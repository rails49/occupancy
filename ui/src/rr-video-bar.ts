import { LitElement, html, css } from 'lit';
import { lookTheme } from '@rails49/look';
import { customElement, property } from 'lit/decorators.js';
import type { Playback } from './liveSources.js';

/**
 * `m:ss`: where a video file is, and how long it is, for the transport (#286).
 *
 * Both numbers are finite by the time they get here: a `<video>` reports `NaN`
 * for the duration of a file whose metadata has not arrived and `Infinity` for
 * one with no end, and `Playback.duration` answers `0` for both.
 */
function clockText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The video transport: the file to run the live view on, and the controls for
 * the one that is playing (#286, split out of `rr-live-view` in #359).
 *
 * It reads a {@link Playback} and a file name and nothing else — not the frame
 * source that owns them, not the loop, not the archive. Play, pause and seek
 * act on the `Playback` it was handed; which file to open and going back to the
 * camera are the live view's to carry out, because swapping the frame source is
 * its job, so both leave here as events.
 *
 * The transport is here rather than on the `<video>` as native `controls`
 * because the marker overlay covers the picture and takes every pointer — a
 * control under it could not be pressed.
 *
 * `playback` is `null` where there is nothing to play: the camera, and a file
 * the source refused. Then only the picker shows, which is what offers a
 * different file after a refusal.
 *
 * **Properties:** `playback`, `name`.
 *
 * @fires rr-video-pick - A file was chosen. Detail: the `File`
 * @fires rr-camera-use - Go back to this device's camera. No detail.
 */
@customElement('rr-video-bar')
export class RRVideoBar extends LitElement {
  /**
   * The transport of the file playing, or `null` for a feed of the present and
   * for a file that will never play.
   *
   * **`hasChanged` is always `true`, and that is load-bearing.** The live view
   * hands over the *same* object on every frame — each reading on it is a
   * getter over a `<video>` that is moving, which is what `Playback` is for —
   * so Lit's default identity check would render this element once, when the
   * file was opened, and leave the clock and the slider where they were while
   * the picture ran on.
   */
  @property({ attribute: false, hasChanged: () => true }) playback: Playback | null = null;
  /** The name of the open file, shown beside the picker, or `null` on the camera. */
  @property({ type: String }) name: string | null = null;

  static styles = [
    lookTheme,
    css`
    /* A row, like the recorder and the service bar it stands beside: the file,
       the controls, and the clock beside the slider that moves it. */
    :host {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 1rem;
      background: var(--sl-color-neutral-100);
      color: var(--sl-color-neutral-700);
      font-size: 0.9rem;
    }

    /* The slider takes the rest of the row. */
    .video-seek {
      flex: 1 1 auto;
      min-width: 4rem;
    }

    .video-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* The row's gap spaces these, where the single button of a bar that is
       otherwise text is pushed off its words. */
    button {
      padding: 0.15rem 0.6rem;
      font: inherit;
      color: inherit;
      background: color-mix(in srgb, currentColor 12%, transparent);
      border: 1px solid currentColor;
      border-radius: 4px;
      cursor: pointer;
    }
  `,
  ];

  /** Open the picker. The input is hidden so the bar reads like its neighbours. */
  private _pickVideo() {
    this.renderRoot.querySelector<HTMLInputElement>('input[type="file"]')?.click();
  }

  private _onVideoPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    // Cleared so that picking the same file again fires `change` again, which
    // is how a clip is watched a second time.
    input.value = '';
    if (!file) return;
    this.dispatchEvent(
      new CustomEvent<File>('rr-video-pick', { detail: file, bubbles: true, composed: true })
    );
  }

  /** Ask to go back to this device's camera, which releases the file (#286). */
  private _useCamera() {
    this.dispatchEvent(new CustomEvent<void>('rr-camera-use', { bubbles: true, composed: true }));
  }

  /** Run the file, or stop it on the frame that is up (#286). */
  private _togglePlay() {
    const playback = this.playback;
    if (!playback) return;
    if (playback.paused) playback.play();
    else playback.pause();
    // A paused file hands over no frames, so nothing else would re-render the
    // bar to say which state it is in now.
    this.requestUpdate();
  }

  /** Move the file to where the slider was dragged (#286). */
  private _onSeek(e: Event) {
    this.playback?.seek(Number((e.target as HTMLInputElement).value));
    this.requestUpdate();
  }

  render() {
    const playback = this.playback;
    const duration = playback?.duration ?? 0;
    const at = playback?.currentTime ?? 0;
    return html`
      <button class="video-open" @click=${this._pickVideo}>Video file…</button>
      <input type="file" accept="video/*" hidden @change=${this._onVideoPick} />
      ${this.name ? html`<span class="video-name">${this.name}</span>` : ''}
      ${playback
        ? html`
            <button class="video-play" @click=${this._togglePlay}>
              ${playback.paused ? 'Play' : 'Pause'}
            </button>
            <input
              class="video-seek"
              type="range"
              min="0"
              max=${duration}
              step="0.1"
              aria-label="Seek"
              ?disabled=${duration === 0}
              .value=${String(at)}
              @input=${this._onSeek}
            />
            <span class="video-time">${clockText(at)} / ${clockText(duration)}</span>
          `
        : ''}
      ${this.name
        ? html`<button class="video-camera" @click=${this._useCamera}>Camera</button>`
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-video-bar': RRVideoBar;
  }

  // Typed at the listener as well as at the dispatch: both cross the shadow
  // boundary, and `rr-video-pick` carries the `File` the live view opens.
  interface HTMLElementEventMap {
    'rr-video-pick': CustomEvent<File>;
    'rr-camera-use': CustomEvent<void>;
  }
}
