import { describe, it, expect, vi, afterEach } from 'vitest';
import { R49Archive } from '@rails49/r49';
import type { ManifestData } from '@rails49/r49';
import {
  READ_ONLY_NOTICE,
  fileStem,
  supportsFileSystemAccess,
  timestampedName,
  writeArchive,
  type FileBinding
} from '../src/persistence.js';
import { archiveBase } from '../src/liveContract.js';

/**
 * jsdom has no File System Access API, which is the honest baseline: it is the
 * fallback path, and it is what Safari and every phone run. The write-back
 * routes are covered by installing fakes on `window` — this proves the module
 * *routes* correctly, not that Chromium's API behaves as documented, which no
 * test in jsdom could show.
 *
 * The service route (#333) needs no handle, so it is the one route jsdom can
 * run end to end, against a stubbed `fetch`.
 */

/** A v4 manifest with no images, which is all these routes need. */
function manifest(): ManifestData {
  return {
    version: 4,
    layout: { name: 'west-yard', scale: 'N', calibration: { points: [] }, sensors: [] },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
  } as ManifestData;
}

/**
 * An archive whose `export()` answers `bytes`, so a test can assert on what
 * reached the file rather than on a zip it would have to re-open.
 */
function archiveOf(bytes: Uint8Array): R49Archive {
  const archive = new R49Archive();
  archive.setManifest(manifest());
  vi.spyOn(archive, 'export').mockResolvedValue(bytes);
  return archive;
}

/** The handle plus the two methods `lib.dom` does not declare, so a test can assert on them. */
interface FakeHandle extends FileSystemFileHandle {
  queryPermission: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  createWritable: ReturnType<typeof vi.fn>;
}

/**
 * A handle that records what was written through it. `standing` is what
 * `queryPermission` answers and `asked` what the prompt would return, so the
 * already-granted and the must-ask cases are the same fake with two arguments.
 */
function fakeHandle(
  name: string,
  standing: PermissionState = 'granted',
  asked: PermissionState = standing
) {
  const written: unknown[] = [];
  const closed = { value: false };
  return {
    written,
    closed,
    handle: {
      name,
      queryPermission: vi.fn().mockResolvedValue(standing),
      requestPermission: vi.fn().mockResolvedValue(asked),
      createWritable: vi.fn().mockResolvedValue({
        write: vi.fn(async (data: unknown) => {
          written.push(data);
        }),
        close: vi.fn(async () => {
          closed.value = true;
        }),
        abort: vi.fn().mockResolvedValue(undefined)
      })
    } as unknown as FakeHandle
  };
}

afterEach(() => {
  delete (window as any).showOpenFilePicker;
  delete (window as any).showSaveFilePicker;
  vi.restoreAllMocks();
});

describe('timestampedName', () => {
  it('stamps local date and time, zero-padded', () => {
    expect(timestampedName('west-yard', new Date(2026, 7, 2, 14, 32))).toBe(
      'west-yard-20260802-1432.r49'
    );
    expect(timestampedName('yard', new Date(2026, 0, 9, 4, 5))).toBe('yard-20260109-0405.r49');
  });

  // The whole point of the format: the folder listing sorted by name is the
  // folder listing sorted by age, which is what makes the newest generation the
  // one you can see rather than the one you have to remember (#48).
  it('sorts lexically in chronological order', () => {
    const names = [
      timestampedName('yard', new Date(2026, 7, 2, 9, 30)),
      timestampedName('yard', new Date(2025, 11, 31, 23, 59)),
      timestampedName('yard', new Date(2026, 7, 2, 10, 0)),
      timestampedName('yard', new Date(2026, 6, 2, 10, 0))
    ];
    expect([...names].sort()).toEqual([names[1], names[3], names[0], names[2]]);
  });
});

describe('fileStem', () => {
  it('strips the extension, case-insensitively, and leaves anything else', () => {
    expect(fileStem('west-yard.r49')).toBe('west-yard');
    expect(fileStem('west-yard.R49')).toBe('west-yard');
    expect(fileStem('west-yard')).toBe('west-yard');
    expect(fileStem('yard.v2.r49')).toBe('yard.v2');
  });
});

describe('supportsFileSystemAccess', () => {
  it('is false in a browser without the picker', () => {
    expect(supportsFileSystemAccess()).toBe(false);
  });

  it('is true once the picker exists', () => {
    (window as any).showOpenFilePicker = vi.fn();
    expect(supportsFileSystemAccess()).toBe(true);
  });
});

describe('writeArchive', () => {
  const bytes = new Uint8Array([1, 2, 3]);

  it('downloads a timestamped generation when there is no API', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const outcome = await writeArchive(archiveOf(bytes), { stem: 'west-yard' });

    expect(click).toHaveBeenCalled();
    expect(outcome.kind).toBe('downloaded');
    expect(outcome.kind === 'downloaded' && outcome.filename).toMatch(/^west-yard-\d{8}-\d{4}\.r49$/);
    // A download binds nothing: the next save must ask the same question again.
    expect(outcome.kind === 'downloaded' && outcome.binding.handle).toBeUndefined();
  });

  it('overwrites a bound handle without opening a picker', async () => {
    const { handle, written, closed } = fakeHandle('west-yard.r49');
    const showSaveFilePicker = vi.fn();
    (window as any).showSaveFilePicker = showSaveFilePicker;

    const binding: FileBinding = { stem: 'west-yard', handle };
    const outcome = await writeArchive(archiveOf(bytes), binding);

    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(written).toEqual([bytes]);
    expect(closed.value).toBe(true);
    expect(outcome).toEqual({ kind: 'wrote', binding, filename: 'west-yard.r49' });
  });

  it('does not re-prompt when write permission already stands', async () => {
    const { handle, written } = fakeHandle('west-yard.r49', 'granted');

    await writeArchive(archiveOf(bytes), { stem: 'west-yard', handle });

    expect(handle.requestPermission).not.toHaveBeenCalled();
    expect(written).toEqual([bytes]);
  });

  it('prompts for write permission at the first save, and writes once granted', async () => {
    const { handle, written } = fakeHandle('west-yard.r49', 'prompt', 'granted');

    await writeArchive(archiveOf(bytes), { stem: 'west-yard', handle });

    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: 'readwrite' });
    expect(written).toEqual([bytes]);
  });

  // A refused prompt must not cost the user a save. It falls back to the
  // download path rather than raising, or asking a second time with a picker.
  it('falls back to a download when write permission is refused', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { handle } = fakeHandle('west-yard.r49', 'prompt', 'denied');
    const showSaveFilePicker = vi.fn();
    (window as any).showSaveFilePicker = showSaveFilePicker;

    const outcome = await writeArchive(archiveOf(bytes), { stem: 'west-yard', handle });

    expect(showSaveFilePicker).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(outcome.kind).toBe('downloaded');
  });

  // The suggested name is plain: an overwritten file keeps its name forever,
  // so a timestamp there would misreport when it was last written.
  it('suggests an unstamped name for an archive that has never been saved', async () => {
    const { handle, written } = fakeHandle('chosen.r49');
    const showSaveFilePicker = vi.fn().mockResolvedValue(handle);
    (window as any).showSaveFilePicker = showSaveFilePicker;

    const outcome = await writeArchive(archiveOf(bytes), { stem: 'New Layout' });

    expect(showSaveFilePicker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'New Layout.r49' })
    );
    expect(written).toEqual([bytes]);
    expect(outcome).toEqual({
      kind: 'wrote',
      binding: { stem: 'chosen', handle },
      filename: 'chosen.r49'
    });
  });

  it('rebinds to the file chosen by Save As', async () => {
    const bound = fakeHandle('west-yard.r49');
    const chosen = fakeHandle('west-yard-copy.r49');
    (window as any).showSaveFilePicker = vi.fn().mockResolvedValue(chosen.handle);

    const outcome = await writeArchive(
      archiveOf(bytes),
      { stem: 'west-yard', handle: bound.handle },
      { rebind: true }
    );

    expect(bound.written).toEqual([]);
    expect(chosen.written).toEqual([bytes]);
    expect(outcome.kind === 'wrote' && outcome.binding.handle).toBe(chosen.handle);
  });

  it('writes nothing and keeps the binding when the picker is dismissed', async () => {
    (window as any).showSaveFilePicker = vi
      .fn()
      .mockRejectedValue(new DOMException('dismissed', 'AbortError'));

    const outcome = await writeArchive(archiveOf(bytes), { stem: 'New Layout' });

    expect(outcome).toEqual({ kind: 'cancelled' });
  });

  it('discards the swap file when the write fails', async () => {
    const { handle } = fakeHandle('west-yard.r49');
    const abort = vi.fn().mockResolvedValue(undefined);
    handle.createWritable.mockResolvedValue({
      write: vi.fn().mockRejectedValue(new Error('disk full')),
      close: vi.fn(),
      abort
    });

    await expect(writeArchive(archiveOf(bytes), { stem: 'west-yard', handle })).rejects.toThrow('disk full');
    expect(abort).toHaveBeenCalled();
  });
});

/**
 * The service route (#333). The archive is a real one loaded from a base URL
 * against a stubbed `fetch`, so what these assert is the routing: which of the
 * three places a save goes, and what the binding is afterwards.
 */
describe('writeArchive on a service binding', () => {
  const BASE = '/live';

  /** The requests `fetch` was given, as `<METHOD> <url>`. */
  let seen: string[];

  /** Answers every write with a 204, and the manifest read with the manifest. */
  function stubService(answer: (key: string) => Response = () => new Response(null, { status: 204 })) {
    seen = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        // The path, not the URL: `R49Archive.load` is given the absolute base
        // and the writer's requests are origin-relative.
        const key = `${init?.method ?? 'GET'} ${new URL(url, window.location.href).pathname}`;
        seen.push(key);
        if (key === 'GET /live/archive/manifest.json') {
          return new Response(JSON.stringify(manifest()), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return answer(key);
      })
    );
  }

  async function opened() {
    stubService();
    return await R49Archive.load(archiveBase(BASE));
  }

  afterEach(() => vi.unstubAllGlobals());

  it('writes to the service, and hands back the new ETag in the binding', async () => {
    const archive = await opened();
    stubService(() => new Response(null, { status: 204, headers: { etag: '"v2"' } }));

    const outcome = await writeArchive(archive, {
      stem: '',
      service: { base: BASE, etag: '"v1"' },
    });

    expect(seen).toEqual(['PUT /live/archive/manifest.json']);
    expect(outcome).toEqual({
      kind: 'served',
      binding: { stem: '', service: { base: BASE, etag: '"v2"' } },
    });
  });

  it('needs no handle, so it runs where there is no File System Access API', async () => {
    const archive = await opened();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    stubService();

    const outcome = await writeArchive(archive, {
      stem: '',
      service: { base: BASE, etag: '"v1"' },
    });

    expect(outcome.kind).toBe('served');
    expect(click).not.toHaveBeenCalled();
  });

  it('reports a refusal and leaves the binding on the service', async () => {
    const archive = await opened();
    stubService(() => new Response(null, { status: 412 }));
    const binding: FileBinding = { stem: '', service: { base: BASE, etag: '"v1"' } };

    const outcome = await writeArchive(archive, binding);

    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' && outcome.binding).toEqual(binding);
    expect(outcome.kind === 'refused' && outcome.message).toMatch(/Save As/);
  });

  // A read-only copy: a `.r49` zip on the service, or a folder it cannot write.
  it('says a read-only archive is read-only, then takes the download', async () => {
    const archive = await opened();
    const notice = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    stubService();

    const outcome = await writeArchive(
      archive,
      { stem: 'west-yard', service: { base: BASE, etag: null } },
      { notice }
    );

    expect(notice).toHaveBeenCalledWith(READ_ONLY_NOTICE);
    expect(click).toHaveBeenCalled();
    expect(outcome.kind).toBe('downloaded');
    // Nothing was written to the service.
    expect(seen).toEqual([]);
  });

  it('tells the person before the picker opens, not after', async () => {
    const archive = await opened();
    const order: string[] = [];
    const notice = vi.fn(() => void order.push('notice'));
    (window as any).showSaveFilePicker = vi.fn(() => {
      order.push('picker');
      return Promise.reject(new DOMException('dismissed', 'AbortError'));
    });
    stubService();

    await writeArchive(
      archive,
      { stem: 'west-yard', service: { base: BASE, etag: null } },
      { notice }
    );

    expect(order).toEqual(['notice', 'picker']);
  });

  // Save As from a service binding: the work moves to the file, and nothing
  // goes to the service.
  it('moves the binding to the file a Save As chose', async () => {
    const archive = await opened();
    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array([7, 7]));
    const chosen = fakeHandle('copy.r49');
    (window as any).showSaveFilePicker = vi.fn().mockResolvedValue(chosen.handle);
    stubService();

    const outcome = await writeArchive(
      archive,
      { stem: 'west-yard', service: { base: BASE, etag: '"v1"' } },
      { rebind: true }
    );

    expect(seen).toEqual([]);
    expect(chosen.written).toEqual([new Uint8Array([7, 7])]);
    expect(outcome).toEqual({
      kind: 'wrote',
      binding: { stem: 'copy', handle: chosen.handle },
      filename: 'copy.r49',
    });
    expect(outcome.kind === 'wrote' && outcome.binding.service).toBeUndefined();
  });

  // A download binds nothing, here as everywhere: the archive is still the
  // service's and the next Save goes back to it.
  it('leaves a service binding alone when a Save As downloads', async () => {
    const archive = await opened();
    vi.spyOn(archive, 'export').mockResolvedValue(new Uint8Array([7, 7]));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    stubService();
    const binding: FileBinding = { stem: 'west-yard', service: { base: BASE, etag: '"v1"' } };

    const outcome = await writeArchive(archive, binding, { rebind: true });

    expect(outcome.kind).toBe('downloaded');
    expect(outcome.kind === 'downloaded' && outcome.binding).toEqual(binding);
  });

  // An image on a service may not read, so an export can fail — and it has to
  // fail before a picker has named a file, or an empty `.r49` lands at that
  // name and truncates whatever was there.
  it('exports before the picker, so a failed export names no file', async () => {
    const archive = await opened();
    vi.spyOn(archive, 'export').mockRejectedValue(new Error('could not read IMG 1.jpg'));
    const picker = vi.fn();
    (window as any).showSaveFilePicker = picker;
    stubService();

    await expect(
      writeArchive(archive, { stem: 'west-yard', service: { base: BASE, etag: '"v1"' } }, {
        rebind: true,
      })
    ).rejects.toThrow('IMG 1.jpg');
    expect(picker).not.toHaveBeenCalled();
  });

  // A binding and an archive that disagree is a bug here, not a save the
  // person can do anything about; the format refuses it rather than writing a
  // zip's files to a URL.
  it('refuses to write an archive that did not come from a service', async () => {
    await expect(
      writeArchive(archiveOf(new Uint8Array([1])), {
        stem: '',
        service: { base: BASE, etag: '"v1"' },
      })
    ).rejects.toThrow(/URL archive/);
  });

  // The service route writes changed files, never an archive: exporting for it
  // would fetch every image the page has not looked at for nothing.
  it('exports nothing for a save that goes to the service', async () => {
    const archive = await opened();
    const exported = vi.spyOn(archive, 'export');
    stubService();

    await writeArchive(archive, { stem: '', service: { base: BASE, etag: '"v1"' } });

    expect(exported).not.toHaveBeenCalled();
  });
});
