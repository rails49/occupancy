import { describe, it, expect, vi } from 'vitest';
import { fixture, html } from '@open-wc/testing';
import '../src/rr-video-bar.js';
import type { RRVideoBar } from '../src/rr-video-bar.js';
import type { Playback } from '../src/liveSources.js';

// The video transport on its own (#359): the clock, the slider, Play/Pause,
// and the two events it reports. `rr-live-view` is driven through the real
// video-file source in `rr-live-view.video.test.ts`; what is left here is the
// bar's half of that, against a `Playback` a test moves by hand.

/** A `Playback` a test moves, as a playing `<video>` moves the real one. */
interface StandInPlayback {
  paused: boolean;
  currentTime: number;
  duration: number;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  seek: ReturnType<typeof vi.fn>;
}

function standInPlayback(fields: Partial<StandInPlayback> = {}): StandInPlayback {
  return {
    paused: false,
    currentTime: 0,
    duration: 90,
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    ...fields,
  };
}

/** The bar with a file open, which is the state the transport shows in. */
async function playing(playback: Playback | null, name: string | null = 'IMG_4312.mov') {
  return fixture<RRVideoBar>(
    html`<rr-video-bar .playback=${playback} .name=${name}></rr-video-bar>`,
  );
}

function part<E extends Element>(el: RRVideoBar, selector: string): E | null {
  return el.shadowRoot!.querySelector<E>(selector);
}

describe('rr-video-bar', () => {
  it('offers the picker with nothing open, and nothing else', async () => {
    const el = await playing(null, null);

    expect(part(el, '.video-open')).to.not.be.null;
    expect(part(el, 'input[type="file"]')).to.not.be.null;
    // No transport over a file that is not playing, and no way back to a
    // camera that is already what is showing.
    expect(part(el, '.video-play')).to.be.null;
    expect(part(el, '.video-camera')).to.be.null;
    expect(part(el, '.video-name')).to.be.null;
  });

  it('opens the picker from the bar, not from a bare file input', async () => {
    // The input is hidden so the control reads like its neighbours.
    const el = await playing(null, null);
    const input = part<HTMLInputElement>(el, 'input[type="file"]')!;
    const opened = vi.spyOn(input, 'click');

    part<HTMLButtonElement>(el, '.video-open')!.click();

    expect(input.hidden).toBe(true);
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('reads the clock as m:ss, where it is over how long it is', async () => {
    const el = await playing(standInPlayback({ currentTime: 12, duration: 90 }));

    expect(part(el, '.video-time')!.textContent).toContain('0:12 / 1:30');
    const seek = part<HTMLInputElement>(el, '.video-seek')!;
    expect(seek.max).toBe('90');
    expect(Number(seek.value)).toBe(12);
    expect(seek.disabled).toBe(false);
  });

  it('reads 0:00 / 0:00 and disables the slider for a file with no length', async () => {
    // `Playback.duration` answers 0 both before the metadata arrives and for a
    // file with no end; neither may reach the screen as "NaN:NaN", and there
    // is nothing to drag a slider along.
    const el = await playing(standInPlayback({ currentTime: 0, duration: 0 }));

    expect(part(el, '.video-time')!.textContent).toContain('0:00 / 0:00');
    expect(part<HTMLInputElement>(el, '.video-seek')!.disabled).toBe(true);
  });

  it('labels the button for what pressing it does', async () => {
    const el = await playing(standInPlayback({ paused: true }));
    expect(part(el, '.video-play')!.textContent!.trim()).toBe('Play');

    const el2 = await playing(standInPlayback({ paused: false }));
    expect(part(el2, '.video-play')!.textContent!.trim()).toBe('Pause');
  });

  it('runs the file, and stops it on the frame that is up', async () => {
    const playback = standInPlayback({ paused: false });
    const el = await playing(playback);

    part<HTMLButtonElement>(el, '.video-play')!.click();
    playback.paused = true;
    await el.updateComplete;

    expect(playback.pause).toHaveBeenCalledTimes(1);
    // A paused file hands over no frames, so nothing else would re-render the
    // bar to say which state it is in now.
    expect(part(el, '.video-play')!.textContent!.trim()).toBe('Play');

    part<HTMLButtonElement>(el, '.video-play')!.click();
    expect(playback.play).toHaveBeenCalledTimes(1);
  });

  it('moves the file to where the slider was dragged', async () => {
    const playback = standInPlayback({ currentTime: 12, duration: 90 });
    const el = await playing(playback);

    const seek = part<HTMLInputElement>(el, '.video-seek')!;
    seek.value = '45';
    seek.dispatchEvent(new Event('input'));
    playback.currentTime = 45;
    await el.updateComplete;

    expect(playback.seek).toHaveBeenCalledWith(45);
    expect(part(el, '.video-time')!.textContent).toContain('0:45 / 1:30');
  });

  it('reports the file that was picked, and lets the same one be picked again', async () => {
    const el = await playing(null, null);
    const picked: File[] = [];
    el.addEventListener('rr-video-pick', e => picked.push(e.detail));
    const input = part<HTMLInputElement>(el, 'input[type="file"]')!;
    const file = new File([new Uint8Array([1])], 'IMG_4312.mov', { type: 'video/quicktime' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });

    input.dispatchEvent(new Event('change'));

    expect(picked).toEqual([file]);
    // Cleared so that picking the same file again fires `change` again, which
    // is how a clip is watched a second time.
    expect(input.value).toBe('');
  });

  it('says nothing for a picker that was dismissed', async () => {
    const el = await playing(null, null);
    const picked = vi.fn();
    el.addEventListener('rr-video-pick', picked);

    part<HTMLInputElement>(el, 'input[type="file"]')!.dispatchEvent(new Event('change'));

    expect(picked).not.toHaveBeenCalled();
  });

  it('offers the camera only while a file is open, and reports the press', async () => {
    const el = await playing(standInPlayback(), null);
    expect(part(el, '.video-camera')).to.be.null;

    el.name = 'IMG_4312.mov';
    await el.updateComplete;
    const asked = vi.fn();
    el.addEventListener('rr-camera-use', asked);

    part<HTMLButtonElement>(el, '.video-camera')!.click();

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('follows the same Playback object as it moves', async () => {
    // The live view hands over the same object every frame — every reading on
    // it is a getter over a `<video>` that is playing — so an element that
    // re-rendered only on a new object would leave the clock and the slider
    // where the file was opened while the picture ran on.
    const playback = standInPlayback({ currentTime: 3, duration: 90 });
    const el = await playing(playback);
    expect(part(el, '.video-time')!.textContent).toContain('0:03');

    playback.currentTime = 20;
    el.playback = playback;
    await el.updateComplete;

    expect(part(el, '.video-time')!.textContent).toContain('0:20 / 1:30');
    expect(Number(part<HTMLInputElement>(el, '.video-seek')!.value)).toBe(20);
  });
});
