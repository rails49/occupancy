import { describe, it, expect, vi, afterEach } from 'vitest';
import { R49Archive } from '@rails49/r49';
import type { ManifestData } from '@rails49/r49';
import { saveToService } from '../src/serviceArchive.js';
import { archiveBase } from '../src/liveContract.js';
import { jsonAnswer, errorAnswer, htmlAnswer } from './liveFixture.js';
import { jpeg } from './jpegFixture.js';

/**
 * Saving an archive back to an occupancy service (#333), against a stubbed
 * `fetch`.
 *
 * The archive is `@rails49/r49`'s — `R49Archive.load` takes the service's base
 * URL, reads the manifest, and fetches each image when something asks for it.
 * What this file covers is the writer `writeChanges` sends each file through:
 * every request it makes is a request a test can see, with its method, its path
 * and its `If-Match`.
 *
 * It also pins the lazy reads the editor above depends on, because they are the
 * reason an image read can now fail — the behaviour `rr-editor-view`,
 * `rr-diagnostics-view` and `editSession` each had to take on.
 */

const BASE = '/live';

function manifest(filenames: readonly string[] = []): ManifestData {
  return {
    version: 4,
    layout: { name: 'west-yard', scale: 'N', calibration: { points: [] }, sensors: [] },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: filenames.map(filename => ({ filename, labeled_complete: false, labels: [] })),
  } as ManifestData;
}

/** One image's bytes, distinguishable by their first byte. */
const bytesFor = (seed: number) => new Uint8Array([seed, 2, 3, 4]);

/** An answer carrying bytes, as the service serves an image. */
function fileAnswer(bytes: Uint8Array, type = 'image/jpeg'): Response {
  return new Response(bytes as unknown as BodyInit, { headers: { 'content-type': type } });
}

/**
 * A `Blob`'s text. jsdom's `Blob` has neither `text()` nor `arrayBuffer()`, and
 * `FileReader` is the reader it does have.
 */
function textOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** A 204, as a service answers a write. */
function wrote(etag?: string): Response {
  return new Response(null, { status: 204, ...(etag === undefined ? {} : { headers: { etag } }) });
}

/**
 * A request as `<METHOD> <path>`.
 *
 * The path rather than the URL, because the two sides address the same files
 * from different starting points: `R49Archive.load` is given the absolute base
 * `archiveBase()` resolves, and the writer's `PUT` and `DELETE` are
 * origin-relative. Both land on the same path, which is the thing worth
 * asserting.
 */
function key(url: string, init?: RequestInit): string {
  return `${init?.method ?? 'GET'} ${new URL(url, window.location.href).pathname}`;
}

/** What `fetch` was asked for: the method and the path, in order. */
function calls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url, init]) => key(String(url), init as RequestInit));
}

/** The `If-Match` of each write, in order, with the reads left out. */
function ifMatches(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method !== undefined)
    .map(([, init]) => {
      const headers = (init as RequestInit).headers as Record<string, string>;
      return headers['If-Match'];
    });
}

/**
 * A `fetch` that answers each request from `answers`, by `<METHOD> <path>`, and
 * fails any request no entry covers — so a test says exactly which requests it
 * expects to see.
 */
function stubFetch(answers: Record<string, () => Response | Promise<Response>>) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const asked = key(String(url), init);
    const answer = answers[asked];
    if (!answer) throw new TypeError(`Failed to fetch: nothing stubbed for ${asked}`);
    return await answer();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** The archive the service serves, read from its base URL. */
function open(): Promise<R49Archive> {
  return R49Archive.load(archiveBase(BASE));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('opening the archive a service serves', () => {
  it('reads the manifest from the base URL and validates it', async () => {
    const fetchMock = stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['img_1.jpg'])),
    });

    const archive = await open();

    expect(calls(fetchMock)).toEqual(['GET /live/archive/manifest.json']);
    expect(archive.getManifest().layout.name).toBe('west-yard');
  });

  it('refuses a manifest the format does not accept', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer({ version: 3 }) });
    await expect(open()).rejects.toThrow();
  });

  it('refuses an answer that is not the manifest', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => errorAnswer(503) });
    await expect(open()).rejects.toThrow('503');
  });
});

describe('reading an image from a service', () => {
  // One read is one request: the archive holds the images added here and
  // nothing it fetched, so what keeps the editor to one read per image is its
  // own URL per filename rather than a cache down here.
  it('fetches an image when it is asked for, and nothing before', async () => {
    const fetchMock = stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['img_1.jpg'])),
      'GET /live/archive/img_1.jpg': () => fileAnswer(bytesFor(9)),
    });
    const archive = await open();

    expect(calls(fetchMock)).toEqual(['GET /live/archive/manifest.json']);
    expect(await archive.getImage('img_1.jpg')).toEqual(bytesFor(9));
    expect(calls(fetchMock)).toEqual([
      'GET /live/archive/manifest.json',
      'GET /live/archive/img_1.jpg',
    ]);
  });

  it('percent-encodes each segment of the name it asks for', async () => {
    const fetchMock = stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['raw/IMG 1.jpg'])),
      'GET /live/archive/raw/IMG%201.jpg': () => fileAnswer(bytesFor(9)),
    });
    const archive = await open();

    expect(await archive.getImage('raw/IMG 1.jpg')).toEqual(bytesFor(9));
    expect(calls(fetchMock)).toContain('GET /live/archive/raw/IMG%201.jpg');
  });

  // A 404 is the archive having a hole in it — a manifest naming a file the
  // service does not hold — not a read that failed.
  it('answers null for an image the service does not have', async () => {
    stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['img_1.jpg'])),
      'GET /live/archive/img_1.jpg': () => new Response('gone', { status: 404 }),
    });
    const archive = await open();

    expect(await archive.getImage('img_1.jpg')).to.be.null;
  });

  it('rejects on a refusal, and on a request that never answered', async () => {
    stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['a.jpg', 'b.jpg'])),
    });
    const archive = await open();

    stubFetch({
      'GET /live/archive/a.jpg': () => errorAnswer(500),
      // `b.jpg` is stubbed nowhere, so the stub throws the way a dropped
      // connection does.
    });

    await expect(archive.getImage('a.jpg')).rejects.toThrow('a.jpg');
    await expect(archive.getImage('b.jpg')).rejects.toThrow();
  });

  it('asks again after a failed read', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['a.jpg'])) });
    const archive = await open();

    const failing = stubFetch({ 'GET /live/archive/a.jpg': () => errorAnswer(500) });
    await expect(archive.getImage('a.jpg')).rejects.toThrow();

    stubFetch({ 'GET /live/archive/a.jpg': () => fileAnswer(bytesFor(1)) });
    expect(await archive.getImage('a.jpg')).toEqual(bytesFor(1));
    expect(calls(failing)).toHaveLength(1);
  });

  it('fetches the images it does not hold when it is exported', async () => {
    stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['img_1.jpg'])),
      'GET /live/archive/img_1.jpg': () => fileAnswer(jpeg()),
    });
    const archive = await open();
    await archive.addImage('img_2.jpg', bytesFor(7));

    const bytes = await archive.export();

    const reopened = await R49Archive.load(bytes);
    expect(reopened.getManifest().images.map(image => image.filename)).toEqual([
      'img_1.jpg',
      'img_2.jpg',
    ]);
    expect(await reopened.getImage('img_1.jpg')).toEqual(jpeg());
    expect(await reopened.getImage('img_2.jpg')).toEqual(bytesFor(7));
  });
});

describe('saveToService', () => {
  /** An archive on the service holding one image, with a second added here. */
  async function edited() {
    stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['img_1.jpg'])),
    });
    const archive = await open();
    await archive.addImage('IMG 2.jpg', bytesFor(7));
    archive.removeImage('img_1.jpg');
    return archive;
  }

  it('puts each file, then the manifest, then deletes — with If-Match on each', async () => {
    const archive = await edited();
    const fetchMock = stubFetch({
      'PUT /live/archive/IMG%202.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': () => wrote('"v2"'),
      'DELETE /live/archive/img_1.jpg': () => wrote(),
    });

    const result = await saveToService(archive, BASE, '"v1"');

    expect(result).toEqual({ kind: 'wrote', etag: '"v2"' });
    expect(calls(fetchMock)).toEqual([
      'PUT /live/archive/IMG%202.jpg',
      'PUT /live/archive/manifest.json',
      'DELETE /live/archive/img_1.jpg',
    ]);
    // The manifest's answer replaces the version held, so the DELETE after it
    // carries the new one and does not read as a stale write.
    expect(ifMatches(fetchMock)).toEqual(['"v1"', '"v1"', '"v2"']);
  });

  it('writes only the manifest when nothing but labels changed', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['img_1.jpg'])) });
    const archive = await open();
    archive.getManifest().images[0].labeled_complete = true;

    const fetchMock = stubFetch({ 'PUT /live/archive/manifest.json': () => wrote('"v2"') });
    expect(await saveToService(archive, BASE, '"v1"')).toEqual({ kind: 'wrote', etag: '"v2"' });
    expect(calls(fetchMock)).toEqual(['PUT /live/archive/manifest.json']);
  });

  it('deletes nothing for an image that was added and taken back here', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer(manifest()) });
    const archive = await open();
    await archive.addImage('img_2.jpg', bytesFor(7));
    archive.removeImage('img_2.jpg');

    const fetchMock = stubFetch({ 'PUT /live/archive/manifest.json': () => wrote('"v2"') });
    await saveToService(archive, BASE, '"v1"');

    // The service never held it, so there is nothing there to delete.
    expect(calls(fetchMock)).toEqual(['PUT /live/archive/manifest.json']);
  });

  // The page reloads on a 412 rather than show the service's words (#381).
  it('reports a 412 as stale', async () => {
    const archive = await edited();
    stubFetch({
      'PUT /live/archive/IMG%202.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': () => new Response(null, { status: 412 }),
    });

    const result = await saveToService(archive, BASE, '"v1"');

    expect(result).toEqual({ kind: 'stale' });
  });

  it('quotes the rule on a 422', async () => {
    const archive = await edited();
    stubFetch({
      'PUT /live/archive/IMG%202.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': () =>
        jsonAnswer({ error: 'manifest/duplicate-id: S01' }, 422),
    });

    const result = await saveToService(archive, BASE, '"v1"');

    expect(result.kind === 'refused' && result.message).toContain('manifest/duplicate-id: S01');
  });

  it('names the status of any other refusal', async () => {
    for (const status of [405, 403, 411]) {
      const archive = await edited();
      stubFetch({
        'PUT /live/archive/IMG%202.jpg': () => wrote(),
        'PUT /live/archive/manifest.json': () => htmlAnswer(status),
      });

      const result = await saveToService(archive, BASE, '"v1"');

      expect(result.kind).toBe('refused');
      expect(result.kind === 'refused' && result.message).toContain(String(status));
    }
  });

  it('refuses the save when a file is refused, before the manifest is written', async () => {
    const archive = await edited();
    const fetchMock = stubFetch({
      'PUT /live/archive/IMG%202.jpg': () => new Response(null, { status: 403 }),
    });

    expect((await saveToService(archive, BASE, '"v1"')).kind).toBe('refused');
    expect(calls(fetchMock)).toEqual(['PUT /live/archive/IMG%202.jpg']);
  });

  it('rejects on a network failure, which the caller reports as a failed save', async () => {
    const archive = await edited();
    stubFetch({});
    await expect(saveToService(archive, BASE, '"v1"')).rejects.toThrow();
  });

  // occupancy-service#7 accepts an orphan file, so a delete that did not land
  // is a stray file on the service rather than a save that did not happen.
  it('marks the save written when a DELETE fails', async () => {
    const archive = await edited();
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubFetch({
      'PUT /live/archive/IMG%202.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': () => wrote('"v2"'),
      'DELETE /live/archive/img_1.jpg': () => new Response(null, { status: 405 }),
    });

    expect(await saveToService(archive, BASE, '"v1"')).toEqual({ kind: 'wrote', etag: '"v2"' });
    expect(failed).toHaveBeenCalled();
  });

  it('runs the deletes after one that failed', async () => {
    stubFetch({
      'GET /live/archive/manifest.json': () => jsonAnswer(manifest(['a.jpg', 'b.jpg'])),
    });
    const archive = await open();
    archive.removeImage('a.jpg');
    archive.removeImage('b.jpg');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const fetchMock = stubFetch({
      'PUT /live/archive/manifest.json': () => wrote('"v2"'),
      'DELETE /live/archive/a.jpg': () => new Response(null, { status: 405 }),
      'DELETE /live/archive/b.jpg': () => wrote(),
    });

    expect((await saveToService(archive, BASE, '"v1"')).kind).toBe('wrote');
    expect(calls(fetchMock)).toEqual([
      'PUT /live/archive/manifest.json',
      'DELETE /live/archive/a.jpg',
      'DELETE /live/archive/b.jpg',
    ]);
  });

  it('sends nothing twice: a written change is not pending afterwards', async () => {
    const archive = await edited();
    stubFetch({
      'PUT /live/archive/IMG%202.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': () => wrote('"v2"'),
      'DELETE /live/archive/img_1.jpg': () => wrote(),
    });
    await saveToService(archive, BASE, '"v1"');

    const fetchMock = stubFetch({ 'PUT /live/archive/manifest.json': () => wrote('"v3"') });
    expect(await saveToService(archive, BASE, '"v2"')).toEqual({ kind: 'wrote', etag: '"v3"' });
    expect(calls(fetchMock)).toEqual(['PUT /live/archive/manifest.json']);
  });

  // The hole the write order exists to prevent: the manifest that goes is the
  // one as of the save's start, so it cannot name an image whose bytes this
  // save never sent.
  it('sends the manifest as it was when the save started', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer(manifest()) });
    const archive = await open();
    await archive.addImage('a.jpg', bytesFor(1));

    let release = () => {};
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const bodies = new Map<string, Blob>();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const asked = key(String(url), init);
      bodies.set(asked, (init as RequestInit).body as Blob);
      if (asked === 'PUT /live/archive/a.jpg') await held;
      return wrote('"v2"');
    });
    vi.stubGlobal('fetch', fetchMock);

    const saving = saveToService(archive, BASE, '"v1"');
    // The edit lands while the first file is in flight.
    await archive.addImage('b.jpg', bytesFor(2));
    release();
    await saving;

    expect(calls(fetchMock)).toEqual([
      'PUT /live/archive/a.jpg',
      'PUT /live/archive/manifest.json',
    ]);
    const sent = JSON.parse(
      await textOf(bodies.get('PUT /live/archive/manifest.json')!)
    ) as ManifestData;
    expect(sent.images.map(image => image.filename)).toEqual(['a.jpg']);
  });

  it('keeps a change made while the save ran, and sends it on the next one', async () => {
    const archive = await edited();
    let release = () => {};
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    stubFetch({
      'PUT /live/archive/IMG%202.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': async () => {
        await held;
        return wrote('"v2"');
      },
      'DELETE /live/archive/img_1.jpg': () => wrote(),
    });

    const saving = saveToService(archive, BASE, '"v1"');
    await archive.addImage('img_3.jpg', bytesFor(5));
    release();
    expect(await saving).toEqual({ kind: 'wrote', etag: '"v2"' });

    const fetchMock = stubFetch({
      'PUT /live/archive/img_3.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': () => wrote('"v3"'),
    });
    await saveToService(archive, BASE, '"v2"');

    expect(calls(fetchMock)).toEqual([
      'PUT /live/archive/img_3.jpg',
      'PUT /live/archive/manifest.json',
    ]);
  });

  it('mints an archive id on the way out, once', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer(manifest()) });
    const archive = await open();
    expect(archive.getManifest().id).to.be.undefined;

    stubFetch({ 'PUT /live/archive/manifest.json': () => wrote('"v2"') });
    await saveToService(archive, BASE, '"v1"');
    const id = archive.getManifest().id;
    expect(id).to.be.a('string');

    stubFetch({ 'PUT /live/archive/manifest.json': () => wrote('"v3"') });
    await saveToService(archive, BASE, '"v2"');
    expect(archive.getManifest().id).toBe(id);
  });

  it('sends the manifest it holds, as JSON', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer(manifest()) });
    const archive = await open();
    archive.getManifest().layout.name = 'east-yard';

    stubFetch({ 'PUT /live/archive/manifest.json': () => wrote('"v2"') });
    const fetchMock = vi.mocked(fetch);
    await saveToService(archive, BASE, '"v1"');
    const body = (fetchMock.mock.calls[0][1] as RequestInit).body as Blob;

    expect(body.type).toBe('application/json');
    const sent = JSON.parse(await textOf(body)) as ManifestData;
    expect(sent.layout.name).toBe('east-yard');
  });

  it('sends an image with its own content type', async () => {
    stubFetch({ 'GET /live/archive/manifest.json': () => jsonAnswer(manifest()) });
    const archive = await open();
    await archive.addImage('img_2.jpg', bytesFor(7));

    const fetchMock = stubFetch({
      'PUT /live/archive/img_2.jpg': () => wrote(),
      'PUT /live/archive/manifest.json': () => wrote('"v2"'),
    });
    await saveToService(archive, BASE, '"v1"');

    const body = (fetchMock.mock.calls[0][1] as RequestInit).body as Blob;
    expect(body.type).toBe('image/jpeg');
  });
});
