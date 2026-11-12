/**
 * An occupancy service's camera, as the editor's camera button reads it (#381).
 *
 * On a service page the camera button adds the service's next frame, not a
 * picture from the device's camera. {@link ServiceCamera.next} asks `latest`
 * for a frame newer than the last one this has seen. {@link ServiceCamera.watch}
 * asks every few seconds whether the service's answer carries a frame at all,
 * which is what enables and disables the button.
 *
 * The live view does not use this: its source, `occupancyService.ts`, decodes
 * and shows every frame. This decodes nothing. Paths and parts are
 * `liveContract.ts`'s.
 */

import type { ShownFrame } from './liveSources.js';
import { LATEST_TIMEOUT_MS, LIVE_BASE, errorText, latestUrl, readLatest } from './liveContract.js';
import type { LiveAnswer } from './liveContract.js';

/** How long the watch waits after one answer before asking again. */
export const WATCH_INTERVAL_MS = 2000;

/**
 * How many answers {@link ServiceCamera.next} reads for a new frame. `after`
 * holds each about 1 s at the service, so this is a few seconds.
 */
const NEXT_TRIES = 3;

export interface ServiceCamera {
  /** Whether the service's last answer carried a frame. `false` before the first. */
  readonly ready: boolean;
  /** Ask the service until {@link stop}, calling `onChange` when {@link ready} changes. */
  watch(onChange: () => void): void;
  /** Stop watching. */
  stop(): void;
  /** The service's next frame, newer than the last this has seen, or `null` where it sent none. */
  next(): Promise<ShownFrame | null>;
}

/**
 * The camera of the occupancy service at `base`.
 *
 * @param intervalMs how long the watch waits between answers. Tests pass their own.
 */
export function serviceCamera(base: string = LIVE_BASE, intervalMs = WATCH_INTERVAL_MS): ServiceCamera {
  let ready = false;
  /** The last `frame_id` seen, sent back as `after`. */
  let lastId: string | null = null;
  /** Bumped by `watch` and `stop`, so a loop from an earlier `watch` ends. */
  let watching = 0;

  /** One `latest` answer, or `null` where the request failed or timed out. */
  async function ask(): Promise<LiveAnswer | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LATEST_TIMEOUT_MS);
    try {
      return await readLatest(await fetch(latestUrl(base, lastId), { signal: controller.signal }));
    } catch (err) {
      console.error(`Cannot read the occupancy service's camera at ${base}: ${errorText(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get ready() {
      return ready;
    },

    watch(onChange: () => void) {
      const run = ++watching;
      void (async () => {
        while (run === watching) {
          const answer = await ask();
          if (run !== watching) return;
          const now = answer?.frame != null;
          if (answer?.payload.frame_id) lastId = answer.payload.frame_id;
          if (now !== ready) {
            ready = now;
            onChange();
          }
          await new Promise(resolve => setTimeout(resolve, intervalMs));
        }
      })();
    },

    stop() {
      watching++;
    },

    async next() {
      for (let tries = 0; tries < NEXT_TRIES; tries++) {
        const answer = await ask();
        if (answer === null || answer.frame === null) {
          ready = false;
          return null;
        }
        const id = answer.payload.frame_id!;
        if (id === lastId) continue;
        lastId = id;
        ready = true;
        return { id, bytes: answer.frame };
      }
      return null;
    },
  };
}
