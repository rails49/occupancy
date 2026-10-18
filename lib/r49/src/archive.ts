import JSZip from 'jszip';
import { make_id } from './uid.ts';
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
   * @throws If the data is empty, is not a readable zip, lacks manifest.json,
   *         carries a version other than 4, or fails v4 validation.
   */
  static async load(data: Buffer | Blob | ArrayBuffer | Uint8Array): Promise<R49Archive> {
    const size = (data as any).byteLength ?? (data as any).size ?? 0;
    if (size === 0) {
      throw new Error('Cannot load .r49 archive: data is empty');
    }
    try {
      const zip = await JSZip.loadAsync(data);
      const archive = new R49Archive(zip);
      await archive.readAndValidateManifest();
      return archive;
    } catch (err) {
      throw new Error(`Failed to load .r49 archive (size: ${size} bytes): ${err}`);
    }
  }

  /**
   * Re-reads manifest.json from the archive and validates it against the v4
   * schema, replacing any in-memory manifest.
   *
   * The version is checked first and on its own, so a v3 archive fails with a
   * message naming the version rather than with a list of shape mismatches.
   *
   * @throws If manifest.json is absent, is not version 4, or fails validation.
   */
  async readAndValidateManifest(): Promise<ManifestData> {
    const manifestFile = this.zip.file('manifest.json');
    if (!manifestFile) {
      throw new Error('manifest.json not found in archive');
    }
    const content = await manifestFile.async('string');
    const json = JSON.parse(content);
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
   * @throws If the supplied data is not version 4, or fails validation.
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
