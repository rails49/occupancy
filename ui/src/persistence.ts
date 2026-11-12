/**
 * Where a session's work goes when it is saved, and the three ways of putting
 * it there (#48, #333).
 *
 * A browser cannot write to a file it was handed through `<input type="file">`;
 * only the File System Access API yields a handle that can be written back, and
 * that API exists in Chromium desktop alone — not Firefox, not Safari, and on
 * no phone at all. `ui/CLAUDE.md` names Chrome, Safari and Firefox as supported
 * equally and `SPEC.md` assumes the labeling device *is* a phone, so write-back
 * is an enhancement over a download path that stays permanently, never a
 * replacement for it.
 *
 * The third way is an occupancy service (#333): an archive this page opened
 * from one is written back to it a file at a time, which needs no handle and so
 * works in every supported browser, on a phone too.
 *
 * The module exists so that split lives in one place. `rr-app` holds a
 * {@link FileBinding} and calls {@link openArchive} and {@link writeArchive};
 * which of the three routes runs is decided here, which is why this takes the
 * **archive** rather than exported bytes — the service route writes changed
 * files and never an archive, and exporting for it would fetch every image the
 * page has not looked at for nothing. `capture.ts` wraps `getUserMedia` the
 * same way and for the same reason.
 */

import type { R49Archive } from '@rails49/r49';
import { createOnService, saveToService } from './serviceArchive.js';

/**
 * The archive on an occupancy service this session writes back to (#333).
 *
 * `etag` is the version the manifest was read at, and it is what `If-Match`
 * holds: a save over a copy that moved on is refused rather than merged.
 * `null` is a service that serves the archive read-only — a `.r49` zip, or a
 * folder it cannot write. The service page turns editing off for it (#381).
 *
 * `create` is a service with no archive yet: the page made a fresh one, and
 * the first save creates it on the service, after which the binding carries
 * the `ETag` the create answered with (#382).
 */
export interface ServiceBinding {
  /** Where the service answers, as `liveContract.ts`'s `LIVE_BASE`. */
  readonly base: string;
  /** The manifest's `ETag` as last seen, or `null` for a read-only copy or one not yet created. */
  readonly etag: string | null;
  /** Whether the service has no archive yet, so the next save creates it (#382). */
  readonly create?: boolean;
}

/**
 * Where this session writes back to, in one of three kinds.
 *
 * * `service` present — Save writes to the **occupancy service**, where the
 *   binding carries an `ETag`.
 * * `handle` present — Save **overwrites** that file.
 * * neither — Save **downloads a new generation**.
 *
 * The `stem` is carried separately because the download path has no handle to
 * read a name from and still needs one to build a filename, and because it
 * survives a binding that never gains a handle. A service binding carries
 * none: an archive on a service has no filename here, so the name a Save As
 * suggests comes from `layout.name` at the moment of saving.
 */
export interface FileBinding {
  /** Filename without the `.r49` extension. Empty for a service binding. */
  readonly stem: string;
  /** Present only where the File System Access API exists. */
  readonly handle?: FileSystemFileHandle;
  /** Present only for an archive opened from an occupancy service (#333). */
  readonly service?: ServiceBinding;
}

/** What a save actually did, so the caller can say so. */
export type SaveOutcome =
  /** Written into a real file on disk; `binding` may be newly bound. */
  | { kind: 'wrote'; binding: FileBinding; filename: string }
  /** A new generation landed in the browser's download folder. */
  | { kind: 'downloaded'; binding: FileBinding; filename: string }
  /** Written back to the occupancy service; `binding` carries the new `ETag`. */
  | { kind: 'served'; binding: FileBinding }
  /**
   * The service said no, in its own words (#333). Nothing was written, nothing
   * rebound, and the archive is still dirty and still bound to the service —
   * this page does not fall back to a file by itself and merges nothing.
   */
  | { kind: 'refused'; binding: FileBinding; message: string }
  /**
   * A 412: the archive on the service changed since this page read it, and
   * nothing was written (#381). The caller reloads the page.
   */
  | { kind: 'stale' }
  /** The user dismissed the picker. Nothing was written, nothing rebound. */
  | { kind: 'cancelled' };

/**
 * What a read-only service binding is told, when Save goes to a file instead.
 *
 * Said rather than silently rerouted: the person opened the archive from the
 * service and has every reason to believe Save puts it back there.
 */
export const READ_ONLY_NOTICE =
  'The archive on the occupancy service is read-only, so this save goes to a file.';

/** An archive chosen to open, and the binding that opening it establishes. */
export interface OpenedArchive {
  readonly file: File;
  readonly binding: FileBinding;
}

/**
 * The picker methods, declared narrowly rather than pulled in as a global
 * augmentation: they are absent from `lib.dom` (unlike `FileSystemFileHandle`
 * itself, which OPFS put there), and a `window as any` here would be the cast
 * that spreads.
 */
interface FilePickerWindow {
  showOpenFilePicker?: (options?: {
    types?: { description?: string; accept: Record<string, string[]> }[];
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
    excludeAcceptAllOption?: boolean;
  }) => Promise<FileSystemFileHandle>;
}

/**
 * The permission pair, also absent from `lib.dom`. Optional because a handle
 * from OPFS has neither, and because the fallback path never gets this far.
 */
interface PermissionedHandle extends FileSystemFileHandle {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<PermissionState>;
}

const PICKER_TYPES = [
  { description: 'r49 layout archive', accept: { 'application/octet-stream': ['.r49'] } }
];

function picker(): FilePickerWindow {
  return window as unknown as FilePickerWindow;
}

/** True where a file can be written back in place. Chromium desktop only. */
export function supportsFileSystemAccess(): boolean {
  return typeof picker().showOpenFilePicker === 'function';
}

/** `west-yard.r49` → `west-yard`. Any other extension is left alone. */
export function fileStem(filename: string): string {
  return filename.replace(/\.r49$/i, '');
}

/**
 * The download path's filename: `west-yard-20260802-1432.r49`.
 *
 * Every download creates a *new* file, so without an ordering in the name the
 * folder fills with `west-yard (1)`, `west-yard (2)` and the newest generation
 * is the one you have to remember rather than the one you can see. The format
 * is zero-padded and coarse-to-fine precisely so a lexical sort of the folder
 * *is* a chronological one.
 *
 * **Local time, not UTC**, because it is read against the clock on the wall
 * during a labeling session, not compared across machines.
 *
 * This name belongs to the download path alone. The picker suggests a plain
 * `west-yard.r49`, because a written-back file keeps its name across every
 * later overwrite — a timestamp there would be a name asserting a save time the
 * file no longer has, which is worse than no timestamp, since one invites trust.
 */
export function timestampedName(stem: string, date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  return `${stem}-${stamp}.r49`;
}

/**
 * Chooses a `.r49` to open, through the picker where one exists and a file
 * input everywhere else.
 *
 * Resolves `null` when the user dismisses either. Only **read** access is asked
 * for here; the permission to write is requested at the first save, where the
 * prompt's purpose is visible — see {@link writeArchive}.
 */
export async function openArchive(): Promise<OpenedArchive | null> {
  const showOpenFilePicker = picker().showOpenFilePicker;
  if (showOpenFilePicker) {
    let handle: FileSystemFileHandle;
    try {
      [handle] = await showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
    const file = await handle.getFile();
    return { file, binding: { stem: fileStem(file.name), handle } };
  }

  const file = await promptForFile();
  if (!file) return null;
  return { file, binding: { stem: fileStem(file.name) } };
}

/**
 * Writes the archive: back to the occupancy service it came from, in place
 * where the binding has a handle, and as a new timestamped download where it
 * has neither.
 *
 * Five routes, in order:
 *
 * 0. A service binding with an `ETag`, `rebind` false — the changed files, the
 *    manifest and the deletes go to the service (`serviceArchive.ts`'s writer
 *    over `R49Archive.writeChanges`). A binding with `create` sends the whole
 *    archive as one zip instead, and the binding returned carries its `ETag`
 *    and no `create` (#382). No
 *    handle is involved, so this one route works on a phone as well as on
 *    Chromium desktop. A 412 comes back as `stale`, any other refusal as
 *    `refused`, and both leave the binding alone; a network failure throws, as every other route's write
 *    failure does.
 * 1. A service binding with **no** `ETag` — the service serves the archive
 *    read-only. `options.notice` is told so, and the save takes route 2, 3 or
 *    4 from here.
 * 2. A bound handle, `rebind` false — overwrite it, silently. `createWritable`
 *    stages into a swap file and commits on `close()`, so an interrupted write
 *    cannot truncate the original; that atomicity is the whole safety net, by
 *    decision (#48). There is no `.bak` and no verification read: re-parsing
 *    every image on every save costs more than the failure it guards.
 * 3. A bound handle whose write permission is refused — falls through to (5)
 *    rather than failing. A denied prompt must not cost the user a save.
 * 4. No handle (or `rebind`) with the API present — the picker, suggesting the
 *    binding's plain stem. Dismissing it returns `cancelled`; nothing is
 *    written and the old binding stands, and the export it already cost is the
 *    price of not truncating a file it could not fill. A picker save from a
 *    service binding **moves the binding to the file**: the returned one
 *    carries the handle and no service. The *archive* is still the one loaded
 *    from the base URL, so every later save to that file exports and fetches
 *    whatever the page is not holding — `docs/UI.md` § Saving is three routes
 *    has what that costs and why nothing here swaps the archive out.
 * 5. No API — a timestamped download. The binding is returned unchanged: a
 *    download binds nothing, so the next save asks the same question again,
 *    and a service binding stays one.
 *
 * `rebind` is Save As. It skips the service and exports through the archive,
 * which fetches whatever the page has not read. On route 5 it is
 * indistinguishable from a plain save, which is why the affordance is a
 * Shift-click rather than a button: a control that did nothing different on
 * Safari would still have to be explained there.
 *
 * The bytes are exported **once the service route is out of the way, and
 * before any file is touched**: the service route needs none, and an export
 * that fails — an image on a service that will not read — must fail before a
 * picker has named a file, or it would leave an empty `.r49` at that name and
 * truncate whatever was there.
 */
export async function writeArchive(
  archive: R49Archive,
  binding: FileBinding,
  options: { rebind?: boolean; notice?: (message: string) => void } = {}
): Promise<SaveOutcome> {
  const service = options.rebind ? undefined : binding.service;
  if (service) {
    if (service.create || service.etag !== null) {
      const written = service.create
        ? await createOnService(archive, service.base)
        : await saveToService(archive, service.base, service.etag!);
      switch (written.kind) {
        case 'wrote':
          return { kind: 'served', binding: { ...binding, service: { base: service.base, etag: written.etag } } };
        case 'stale':
          return written;
        case 'refused':
          return { kind: 'refused', binding, message: written.message };
      }
    }
    options.notice?.(READ_ONLY_NOTICE);
  }

  // Before the picker and before the first write: a failed export must not have
  // named, or truncated, a file.
  const bytes = await archive.export();

  const handle = options.rebind ? undefined : binding.handle;
  if (handle && (await canWrite(handle))) {
    await writeThrough(handle, bytes);
    return { kind: 'wrote', binding, filename: `${binding.stem}.r49` };
  }

  // A truthy `handle` here means route 3: the write permission was refused, and
  // the answer is the download, not a second dialog asking for a location.
  const showSaveFilePicker = handle ? undefined : picker().showSaveFilePicker;
  if (showSaveFilePicker) {
    let chosen: FileSystemFileHandle;
    try {
      chosen = await showSaveFilePicker({
        suggestedName: `${binding.stem}.r49`,
        types: PICKER_TYPES
      });
    } catch (err) {
      if (isAbort(err)) return { kind: 'cancelled' };
      throw err;
    }
    await writeThrough(chosen, bytes);
    const stem = fileStem(chosen.name);
    return { kind: 'wrote', binding: { stem, handle: chosen }, filename: `${stem}.r49` };
  }

  const filename = timestampedName(binding.stem);
  download(bytes, filename);
  return { kind: 'downloaded', binding, filename };
}

/**
 * Download on a service page (#381): the archive as a timestamped `.r49` in the
 * browser's downloads, for a corpus submission or to open on the cloud page.
 * Nothing is bound and nothing goes to the service. Resolves the filename.
 */
export async function downloadArchive(archive: R49Archive, stem: string): Promise<string> {
  const bytes = await archive.export();
  const filename = timestampedName(stem);
  download(bytes, filename);
  return filename;
}

/**
 * Asks for write permission, lazily — this is the first moment the browser's
 * "let this site edit the file?" prompt has a visible purpose, which is why
 * opening does not ask. A handle from the save picker already answers
 * `granted`, so a New layout never sees the prompt at all.
 */
async function canWrite(handle: FileSystemFileHandle): Promise<boolean> {
  const permissioned = handle as PermissionedHandle;
  if (!permissioned.queryPermission || !permissioned.requestPermission) return true;
  if ((await permissioned.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await permissioned.requestPermission({ mode: 'readwrite' })) === 'granted';
}

async function writeThrough(handle: FileSystemFileHandle, bytes: Uint8Array): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes as unknown as BufferSource);
  } catch (err) {
    // Discard the swap file rather than committing a partial one. A failing
    // abort must not replace the error that caused it.
    await writable.abort().catch(() => undefined);
    throw err;
  }
  await writable.close();
}

/** The download fallback: an anchor click, the only write a browser without the API allows. */
function download(bytes: Uint8Array, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A dismissed picker, which is a normal outcome rather than a failure. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/** The fallback chooser. Resolves null on dismissal — which `change` never fires for. */
function promptForFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.r49';
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null), { once: true });
    // `cancel` is not universal; where it is missing the promise simply never
    // settles, which costs nothing — no archive is replaced until it does.
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}
