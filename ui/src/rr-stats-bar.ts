import { LitElement, html, css } from 'lit';
import { lookTheme } from '@rails49/look';
import { customElement, property } from 'lit/decorators.js';

/**
 * Overlay for live detection statistics: frame rate, what the model found, what
 * the sensors made of it, what one inference cost, and how well the camera still
 * lines up with the archive.
 *
 * `cars` is L0 and `occupied` is L1, and showing both is what makes a
 * disagreement visible — a frame with cars and no occupied sensor is either an
 * empty siding or a mis-placed sensor, and the pair is the only readout that
 * distinguishes them.
 *
 * `inference` is the **detect call**, not the frame: L1 is pure geometry and
 * costs nothing measurable, so a whole-frame number would attribute the render
 * to the model. It is the number that moves when the device changes, which is
 * the whole reason to watch it (see the map's hardware note).
 *
 * **`cars`, `inference` and `l0Age` are absent, not zero, when nobody measured
 * them** (#331). An occupancy service that publishes no L0 has no car count and
 * no detector of this page's to time, and a row reading `0` would be a claim
 * that it looked and found nothing — the same confident-looking miss `clear`
 * refuses to make. An absent row says nothing instead.
 *
 * **`alignment` is an instrument, which is why it is here and not in a banner.**
 * The refusal banner is an *event* — it appears when something is wrong and it
 * has to be read. Alignment is a *continuous measurement*, and a user aiming a
 * camera needs to watch it move: a number that only appeared once it was already
 * too large would leave them adjusting a mount blind, and "how much margin is
 * left" is exactly the question the banner cannot answer. It is shown against
 * the tolerance for the same reason a gauge has a red line.
 */
@customElement('rr-stats-bar')
export class RRStatsBar extends LitElement {
  @property({ type: Number }) fps = 0;
  /**
   * L0: detections above the confidence threshold in the frame on screen, or
   * `null` where no L0 was published at all.
   *
   * `null` is not `0`. An empty list is a frame that was inferred and held no
   * cars; `null` is a source that reported no L0 for it (#331), and the row is
   * withheld rather than reporting a count nothing counted.
   */
  @property({ type: Number }) cars: number | null = null;
  /** L1: how many sensors read `occupied`. */
  @property({ type: Number }) occupied = 0;
  /**
   * Milliseconds in `detect` — preprocessing, the session, the decode — or
   * `null` where this page ran no model (#331).
   */
  @property({ type: Number }) inference: number | null = null;
  /**
   * How far behind the picture on screen the L0 drawn over it is, in
   * milliseconds, or `null` where there is no L0 to be behind.
   *
   * An occupancy service infers on its own cadence and may draw the newest L0
   * it has over a newer frame, so the boxes can belong to an earlier moment
   * than the photograph (#331). Both times are the service's clock, so this
   * page's clock plays no part. It is the readout that says whether a box
   * sitting off a car is a bad box or an old one.
   */
  @property({ type: Number }) l0Age: number | null = null;
  /**
   * Estimated camera misalignment against the archive's images, in
   * `camera.resolution` pixels, or `null` when nothing has measured it yet.
   *
   * `null` renders as `—`, not as `0.0`: "not measured" and "measured, and the
   * camera has not moved" are different facts, and this readout is the one place
   * a zero is a claim rather than an initial value.
   */
  @property({ type: Number }) alignment: number | null = null;
  /**
   * The displacement this layout tolerates, in the same pixels, or `null` when
   * no DPT resolves and so no tolerance does either.
   *
   * Rendered beside the measurement rather than folded into a colour, because
   * the ratio is what a user aiming a camera is judging and a red/green dot
   * discards it.
   */
  @property({ type: Number }) alignmentTolerance: number | null = null;

  static styles = [
    lookTheme,
    css`
    :host {
      display: block;
      position: absolute;
      top: 1rem;
      right: 1rem;
      background: color-mix(in srgb, var(--sl-color-neutral-0) 70%, transparent);
      color: var(--sl-color-success-700);
      padding: 0.5rem 1rem;
      border-radius: 4px;
      font-family: monospace;
      font-size: 0.9rem;
      pointer-events: none;
      z-index: 1000;
      border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
      backdrop-filter: blur(4px);
    }

    .stat {
      display: flex;
      justify-content: space-between;
      gap: 1rem;
    }

    .label {
      color: var(--sl-color-neutral-600);
    }

    /* The one row that changes colour. Amber rather than red: past the tolerance
       the live view is already showing a refusal banner, and a second red thing
       saying the same would compete with the button that acts on it. */
    .over {
      color: var(--sl-color-warning-800);
    }
  `,
  ];

  /**
   * The alignment row: the measurement, and what it is being judged against.
   *
   * Withheld entirely when there is no tolerance to judge against — an
   * uncalibrated layout has no track width to take a fraction of, and a bare
   * pixel count with nothing to compare it to invites the reader to supply their
   * own threshold.
   */
  private _renderAlignment() {
    if (this.alignmentTolerance === null) return '';
    const over = this.alignment !== null && this.alignment > this.alignmentTolerance;
    return html`
      <div class="stat ${over ? 'over' : ''}">
        <span class="label">Drift:</span>
        <span>
          ${this.alignment === null ? '—' : `${this.alignment.toFixed(1)}px`} /
          ${this.alignmentTolerance.toFixed(1)}px
        </span>
      </div>
    `;
  }

  /** One row, or nothing at all where the number was never measured. */
  private _renderMeasured(label: string, value: number | null, text: (value: number) => string) {
    if (value === null) return '';
    return html`
      <div class="stat">
        <span class="label">${label}</span>
        <span>${text(value)}</span>
      </div>
    `;
  }

  render() {
    return html`
      <div class="stat">
        <span class="label">FPS:</span>
        <span>${this.fps.toFixed(1)}</span>
      </div>
      ${this._renderMeasured('Cars:', this.cars, cars => `${cars}`)}
      <div class="stat">
        <span class="label">Occupied:</span>
        <span>${this.occupied}</span>
      </div>
      ${this._renderMeasured('Inference:', this.inference, ms => `${ms.toFixed(1)}ms`)}
      ${this._renderMeasured('L0 age:', this.l0Age, ms => `${ms.toFixed(0)}ms`)}
      ${this._renderAlignment()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-stats-bar': RRStatsBar;
  }
}
