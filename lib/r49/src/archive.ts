import JSZip from 'jszip';
import { make_id } from './uid.ts';
import { R49Error, type FormatRule, type ImageMismatch } from './rules.ts';
import {
  parseManifest,
  assertManifestVersion,
  type ManifestData,
  type Image,
} from './manifest.schema.ts';

export class R49Archive {
  private zip: JSZip;
  private manifest: ManifestData | null = null;

  constructor(zip?: JSZip) {
    this.zip = zip || new JSZip();
  }

  /**
   * Loads an .r49 archive from binary data and validates its manifest against
   * the v4 schema.
   *
   * @param data Raw archive bytes, in any form the host platform produces.
   * @throws An {@link R49Error} naming the rule broken: `archive/empty`,
   *         `archive/not-zip`, `archive/no-manifest`, `manifest/not-json`, or
   *         any rule `setManifest` names.
   */
  static async load(data: Buffer | Blob | ArrayBuffer | Uint8Array): Promise<R49Archive> {
    const size = (data as any).byteLength ?? (data as any).size ?? 0;
    if (size === 0) {
      throw new R49Error('archive/empty', 'Cannot load .r49 archive: data is empty');
    }
    try {
      let zip: JSZip;
      try {
        zip = await JSZip.loadAsync(data);
      } catch (err) {
        throw new R49Error('archive/not-zip', String(err), { cause: err });
      }
      const archive = new R49Archive(zip);
      await archive.readAndValidateManifest();
      return archive;
    } catch (err) {
      // The wrapper keeps the rule it caught and the text it always showed: a
      // refusal detected through another error (zod's, JSZip's) quotes that
      // error, exactly as the editor printed it before rules existed. Anything
      // else that throws in here is JSZip failing to inflate an entry, which is
      // the zip being unreadable after all.
      const rule: FormatRule = err instanceof R49Error ? err.rule : 'archive/not-zip';
      const inner = err instanceof R49Error && err.cause !== undefined ? err.cause : err;
      throw new R49Error(rule, `Failed to load .r49 archive (size: ${size} bytes): ${inner}`, {
        cause: err,
      });
    }
  }

  /**
   * Re-reads manifest.json from the archive and validates it against the v4
   * schema, replacing any in-memory manifest.
   *
   * The version is checked first and on its own, so a v3 archive fails with a
   * message naming the version rather than with a list of shape mismatches.
   *
   * @throws An {@link R49Error}: `archive/no-manifest` if manifest.json is
   *         absent, `manifest/not-json` if it is not strict UTF-8 or does not parse, or any rule
   *         `setManifest` names.
   */
  async readAndValidateManifest(): Promise<ManifestData> {
    const manifestFile = this.zip.file('manifest.json');
    if (!manifestFile) {
      throw new R49Error('archive/no-manifest', 'manifest.json not found in archive');
    }
    // JSZip's 'string' decodes lossily, replacing invalid UTF-8 with U+FFFD, so
    // the bytes are decoded strictly here (#191). `ignoreBOM` keeps a leading
    // byte-order mark in the text, where JSON.parse refuses it.
    const bytes = await manifestFile.async('uint8array');
    let json: unknown;
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      json = JSON.parse(content);
    } catch (err) {
      throw new R49Error('manifest/not-json', String(err), { cause: err });
    }
    assertManifestVersion(json);
    this.manifest = parseManifest(json);
    return this.manifest;
  }

  /**
   * Writes the in-memory manifest back into the archive, minting an archive
   * `id` first if it has none. Called by export(); rarely needed directly.
   *
   * **An existing id is never overwritten.** This method is the single choke
   * point every write passes through, which is what makes that a guarantee
   * rather than a convention — including for the download fallback, which
   * writes a freshly-named file on every save and would otherwise be the one
   * path that mints a new identity for the same archive each time.
   *
   * @throws If no manifest has been loaded or set.
   */
  async saveManifest(): Promise<void> {
    if (!this.manifest) throw new Error('No manifest data to save');
    if (this.manifest.id === undefined) this.manifest.id = make_id();
    this.zip.file('manifest.json', JSON.stringify(this.manifest, null, 2));
  }

  /**
   * Returns the validated manifest. The object is live — mutating it changes
   * what export() writes.
   *
   * @throws If the archive was constructed empty and no manifest has been set.
   */
  getManifest(): ManifestData {
    if (!this.manifest) throw new Error('Manifest not loaded or invalid');
    return this.manifest;
  }

  /**
   * Replaces the manifest, validating it against the v4 schema first.
   *
   * @throws An {@link R49Error} naming the rule broken: `manifest/version`,
   *         `manifest/unknown-key`, `manifest/duplicate-id`,
   *         `manifest/provenance`, or `manifest/schema` for anything else.
   */
  setManifest(data: ManifestData): void {
    assertManifestVersion(data);
    this.manifest = parseManifest(data);
  }

  /**
   * Reads an image from the archive by its manifest filename.
   *
   * @returns The image bytes, or null if no such entry exists.
   */
  async getImage(filename: string): Promise<Uint8Array | null> {
    const file = this.zip.file(filename);
    if (!file) return null;
    return await file.async('uint8array');
  }

  /**
   * Every file entry in the archive, `manifest.json` included, in no
   * particular order. Directory entries are omitted.
   *
   * The manifest names the images it expects; this is the other direction —
   * what the zip actually carries. A validator needs both to tell a manifest
   * naming an absent image from an image nobody references, and neither is
   * answerable through {@link getImage}, which reports only presence of a name
   * it is handed.
   */
  listEntries(): string[] {
    const names: string[] = [];
    this.zip.forEach((path, file) => {
      if (!file.dir) names.push(path);
    });
    return names;
  }

  /**
   * Every way the manifest and the zip disagree about which images this
   * archive holds, both directions: `images/missing` for a manifest entry with
   * no file, then `images/orphan` for a file no entry names.
   *
   * Reported, not thrown. Both are format rules, but `load` refusing an archive
   * that carries a stray image would lock its author out of the editor that
   * can remove it — so a reader that holds archives to the rule (the corpus
   * validator) asks, and one that only needs the images it names need not.
   *
   * Empty when no manifest is loaded.
   */
  imageMismatches(): ImageMismatch[] {
    if (!this.manifest) return [];
    const declared = this.manifest.images.map(img => img.filename);
    const present = new Set(this.listEntries());
    const referenced = new Set(declared);
    const mismatches: ImageMismatch[] = [];

    for (const filename of declared) {
      if (!present.has(filename)) mismatches.push({ rule: 'images/missing', filename });
    }
    for (const entry of present) {
      if (entry === 'manifest.json' || referenced.has(entry)) continue;
      mismatches.push({ rule: 'images/orphan', filename: entry });
    }
    return mismatches;
  }

  /**
   * Adds an image to the archive and, if a manifest is loaded, appends a
   * matching entry with no labels and `labeled_complete: false` — nothing may
   * assert completeness on a human's behalf. Adding an existing filename
   * overwrites the bytes and leaves the manifest entry (and its labels) intact.
   */
  async addImage(filename: string, data: Uint8Array | Buffer | Blob | ArrayBuffer): Promise<void> {
    this.zip.file(filename, data);
    if (this.manifest) {
      const exists = this.manifest.images.some((img: Image) => img.filename === filename);
      if (!exists) {
        this.manifest.images.push({ filename, labeled_complete: false, labels: [] });
      }
    }
  }

  /**
   * Removes an image and its manifest entry, including any labels. Silently
   * does nothing if the filename is not present.
   */
  removeImage(filename: string): void {
    this.zip.remove(filename);
    if (this.manifest) {
      this.manifest.images = this.manifest.images.filter((img: Image) => img.filename !== filename);
    }
  }

  /**
   * Moves an image to a different position in the manifest's image list.
   * Out-of-range indices are ignored rather than throwing.
   */
  reorderImages(fromIndex: number, toIndex: number): void {
    if (!this.manifest) return;
    const images = this.manifest.images;
    if (fromIndex < 0 || fromIndex >= images.length || toIndex < 0 || toIndex >= images.length) return;
    const [movedImage] = images.splice(fromIndex, 1);
    images.splice(toIndex, 0, movedImage);
  }

  /**
   * Serializes the archive, writing the current manifest first.
   *
   * @returns A complete .r49 archive, ready to persist or download.
   * @throws If no manifest has been loaded or set.
   */
  async export(): Promise<Uint8Array> {
    await this.saveManifest();
    return await this.zip.generateAsync({ type: 'uint8array' });
  }
}
