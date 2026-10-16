/**
 * The editor's camera-drift readout: every image measured against the
 * archive's reference image, `images[0]` (#95, #118).
 */

/**
 * Measures `image` against `reference`, both archive filenames, and resolves to
 * the displacement in `camera.resolution` pixels.
 */
export type MeasureDrift = (reference: string, image: string) => Promise<number>;

/** What the readout knows about one image. */
export type DriftRow =
  | { readonly kind: 'reference' }
  | { readonly kind: 'measuring' }
  | { readonly kind: 'measured'; readonly px: number };

/**
 * Each image's drift from the reference image, kept in step with the image list.
 *
 * It is told only the current filenames, on every update, and works out the
 * rest itself: a different first filename is a new reference image and every
 * measurement starts over; a new filename is measured; a removed one loses its
 * row. So no edit, undo or redo has to say what it changed (#167).
 *
 * Images are measured one at a time, in order, whether or not the layout is
 * calibrated: the pixels need no DPT, only the verdict does.
 */
export class DriftMeasurements {
  private _reference: string | null = null;
  private _queue: string[] = [];
  private _present = new Set<string>();
  private _measured = new Map<string, number>();
  /** Images whose measurement failed against the current reference; not retried. */
  private _failed = new Set<string>();
  /** The image being measured, and the reference it is measured against. */
  private _measuring: { reference: string; image: string } | null = null;
  private _draining = false;

  private readonly _measure: MeasureDrift;
  private readonly _onChange: () => void;

  /**
   * @param measure  how one image is measured against another
   * @param onChange called whenever a row may have changed
   */
  constructor(measure: MeasureDrift, onChange: () => void) {
    this._measure = measure;
    this._onChange = onChange;
  }

  /** Bring the readout in step with the archive's image filenames, in order. */
  sync(filenames: readonly string[]): void {
    const reference = filenames[0] ?? null;
    if (reference !== this._reference) {
      this._reference = reference;
      this._measured = new Map();
      this._failed = new Set();
      this._queue = [];
    }
    this._present = new Set(filenames);
    for (const image of this._measured.keys()) {
      if (!this._present.has(image)) this._measured.delete(image);
    }
    for (const image of this._failed) {
      if (!this._present.has(image)) this._failed.delete(image);
    }
    this._queue = this._queue.filter(image => this._present.has(image));
    for (const image of filenames.slice(1)) {
      if (
        !this._measured.has(image) &&
        !this._failed.has(image) &&
        !this._queue.includes(image) &&
        !this._isMeasuring(image)
      ) {
        this._queue.push(image);
      }
    }
    void this._drain();
  }

  /** Abandon the queue and any measurement in flight, for an archive that is gone. */
  stop(): void {
    this.sync([]);
  }

  /**
   * What is known about one image, or `undefined` when nothing is: not yet
   * measured, or the measurement failed. Neither is the same as measuring zero.
   */
  row(filename: string): DriftRow | undefined {
    if (filename === this._reference) return { kind: 'reference' };
    if (this._isMeasuring(filename)) return { kind: 'measuring' };
    const px = this._measured.get(filename);
    return px === undefined ? undefined : { kind: 'measured', px };
  }

  private _isMeasuring(image: string): boolean {
    return this._measuring?.image === image && this._measuring.reference === this._reference;
  }

  private async _drain() {
    if (this._draining) return;
    this._draining = true;
    for (let image = this._queue.shift(); image !== undefined; image = this._queue.shift()) {
      const reference = this._reference!;
      this._measuring = { reference, image };
      this._onChange();
      let px: number | null = null;
      try {
        px = await this._measure(reference, image);
      } catch (err) {
        // No row rather than an error row: the labeler did not ask for this
        // check, and an error about a warning would be noise about noise.
        console.error(`Camera-drift check failed for ${image}`, err);
      }
      this._measuring = null;
      // The archive may have changed while this ran: a result against a former
      // reference image, or for an image since removed, describes nothing on screen.
      if (reference === this._reference && this._present.has(image)) {
        if (px === null) this._failed.add(image);
        else this._measured.set(image, px);
      }
      this._onChange();
    }
    this._draining = false;
  }
}
