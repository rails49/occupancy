/**
 * How an archive opened from an occupancy service is saved back to it (#333).
 *
 * The archive itself is `@rails49/r49`'s, and so is the save: `R49Archive.load`
 * takes the service's base URL, `getImage` fetches an image as it is needed,
 * `export()` fetches whatever is still unread, and `writeChanges` puts the
 * added images, then the manifest, then deletes what the manifest no longer
 * names. **None of that lives here** — a `.r49` reader in `ui/` would be a
 * second implementation of the format (org ADR-0022).
 *
 * What is left is the one thing the format cannot state: how a *this* page
 * reaches a service. `writeChanges` asks for an {@link ArchiveWriter} with a
 * `put` and a `remove`, and {@link ServiceWriter} is that pair over
 * `liveContract.ts`'s requests — `If-Match` on each, the new `ETag` carried out
 * of the manifest's answer, and a failed `DELETE` that leaves an orphan rather
 * than failing the save.
 *
 * The version held — the manifest's `ETag` — is **not** held here: it belongs
 * to the binding in `persistence.ts`, which is what decides where a save goes,
 * and it is handed in per save and handed back.
 */

import type { ArchiveWriter, R49Archive } from '@rails49/r49';
import {
  MANIFEST_NAME,
  SAVE_REFUSED,
  SAVE_STALE,
  deleteArchiveFile,
  manifestUrl,
  putArchiveFile,
  readEtag,
  saveRefusalRule,
} from './liveContract.js';

/** What a write to the service did. A network failure rejects instead. */
export type ServiceWrite =
  /** Landed. `etag` is the version the manifest's answer gave, to save against next. */
  | { readonly kind: 'wrote'; readonly etag: string }
  /** The service said no, in words the caller shows as they are. */
  | { readonly kind: 'refused'; readonly message: string };

/** What a 412 means, in the words the toast uses. */
const STALE_MESSAGE =
  'The copy on the occupancy service changed since this page opened it. ' +
  'Use Save As to keep this work.';

/** The content type a file is written with, from its name. */
function contentType(name: string): string {
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.json$/i.test(name)) return 'application/json';
  return 'application/octet-stream';
}

/** One file's bytes as a body, typed from its name. */
function bodyOf(name: string, bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: contentType(name) });
}

/**
 * A refusal, thrown so it ends the pass.
 *
 * `writeChanges` has one way to stop: a rejected `put`. A refusal is not a
 * failure — it is an answer the person has to act on — so it travels as this,
 * and {@link saveToService} turns it back into a value at the seam. Nothing
 * above sees it.
 */
class ServiceRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServiceRefusal';
  }
}

/**
 * The writer `R49Archive.writeChanges` sends each file through (#333).
 *
 * `put` is `PUT <base>/archive/<name>` and `remove` is `DELETE`, both holding
 * the version in `If-Match` so a copy somebody else moved on refuses this save
 * rather than taking it. The write order is the format's — images, manifest,
 * then deletes — and the manifest's answer carries the new version, so
 * {@link etag} changes under the deletes that follow it and is what the next
 * save holds.
 *
 * One writer per save: it is a position in a pass, not a connection.
 */
export class ServiceWriter implements ArchiveWriter {
  /** The version the next request holds. The manifest's answer replaces it. */
  etag: string;

  /** Where the service answers, which every request here is relative to. */
  private readonly base: string;

  constructor(base: string, etag: string) {
    this.base = base;
    this.etag = etag;
  }

  /**
   * One file onto the service.
   *
   * The body is a `Blob` rather than the bytes so the request carries a
   * `Content-Length`: a service following `LIVE.md` answers 411 without one.
   *
   * @throws {ServiceRefusal} on any answer that is not a 2xx, which ends the
   *         pass — the files `writeChanges` has not reached stay unwritten and
   *         the next save carries them.
   */
  async put(name: string, bytes: Uint8Array): Promise<void> {
    const answer = await putArchiveFile(this.base, name, this.etag, bodyOf(name, bytes));
    if (!answer.ok) throw new ServiceRefusal(await refusalMessage(answer));
    if (name !== MANIFEST_NAME) return;
    // Holding the version from before the write would refuse every `DELETE`
    // after it, and the next save too, reporting a copy somebody else changed
    // when nobody did.
    this.etag = readEtag(answer) ?? (await this._readEtag()) ?? this.etag;
  }

  /**
   * One file off the service.
   *
   * **A failed `DELETE` is logged and resolves**, so the save does not fail and
   * the deletes after it still run. The file stays on the service as an orphan,
   * which rails49/occupancy-service#7 accepts, and r49 forgets the name — the
   * orphan is never retried. What the archive *is* is what the manifest names,
   * and the manifest is already written by the time any of this runs.
   */
  async remove(name: string): Promise<void> {
    try {
      const gone = await deleteArchiveFile(this.base, name, this.etag);
      if (!gone.ok) {
        console.error(
          `The occupancy service answered ${gone.status} deleting ${name}; ` +
            'it stays there as an orphan and the save stands.'
        );
      }
    } catch (err) {
      console.error(`Failed to delete ${name} from the occupancy service`, err);
    }
  }

  /**
   * The version the service holds now, read back from the manifest.
   *
   * Only for an answer to a manifest write that carried no `ETag`. `LIVE.md`
   * says one comes; this is what the pass does when it does not.
   */
  private async _readEtag(): Promise<string | null> {
    console.warn(
      'The occupancy service answered the manifest write with no ETag; reading the version back.'
    );
    try {
      const response = await fetch(manifestUrl(this.base));
      return response.ok ? readEtag(response) : null;
    } catch {
      return null;
    }
  }
}

/**
 * Saves `archive` back to the service at `base`, against the version `etag`.
 *
 * **What goes is the archive as it was when the save started.** That is
 * `writeChanges`'s own rule: it takes the manifest and the added images as they
 * stand when it is called, so an edit landing while the requests are in flight
 * is written by the *next* save — and cannot put an image into the manifest on
 * the service whose bytes this save never sent, which is the hole the write
 * order exists to prevent. It is the same position `EditHistory.markSaved` is
 * given, and for the same reason.
 *
 * @throws on a network failure, which the caller reports as a failed save. A
 *         refusal comes back as a value instead: it is the service answering,
 *         not the save breaking.
 */
export async function saveToService(
  archive: R49Archive,
  base: string,
  etag: string
): Promise<ServiceWrite> {
  const writer = new ServiceWriter(base, etag);
  try {
    await archive.writeChanges(writer);
  } catch (err) {
    if (err instanceof ServiceRefusal) return { kind: 'refused', message: err.message };
    throw err;
  }
  return { kind: 'wrote', etag: writer.etag };
}

/** A refusal, in the words the toast shows. */
async function refusalMessage(response: Response): Promise<string> {
  if (response.status === SAVE_STALE) return STALE_MESSAGE;
  if (response.status === SAVE_REFUSED) {
    const rule = await saveRefusalRule(response);
    return rule === null
      ? `The occupancy service refused the save (${SAVE_REFUSED}).`
      : `The occupancy service refused the save: ${rule}`;
  }
  return `The occupancy service answered ${response.status} to the save.`;
}
