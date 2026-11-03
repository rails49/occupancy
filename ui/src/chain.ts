import type { CarLabel, Image, ManifestData, Point, ReferencePoint, Sensor, Track, WorldPoint } from '@rails49/r49';
import type { Refusal } from './trackFit.js';
import type { HitScene, HitTolerance } from './geometry.js';
import { DEFAULT_GRAB_RADIUS_SCREEN_PX } from './geometry.js';
import type { HistoryTarget } from './history.js';

/**
 * What the car tool and the track tool share (#284): a chain, where each click
 * adds one segment — a car, or a stretch of track — as one history entry.
 *
 * A chain keeps only where it started and what it wrote. The dot it goes on
 * from is read from the manifest, so an undo or a drag while it is live moves
 * it too. `carChain.ts` and `trackChain.ts` are the two kinds; `EditSession`
 * runs the clicks, undo, redo and right-click the same way for both.
 */

/**
 * What a click needs from the editor before anything is written, or a notice
 * to show. A click that wrote, or did nothing, returns `none`.
 */
export type ClickResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'notice'; readonly message: string }
  /** Ask for the world position of a new reference point at `px`. */
  | { readonly kind: 'place-reference-point'; readonly px: Point }
  /** Ask for a new world position for the reference point at `index`. */
  | {
      readonly kind: 'edit-reference-point';
      readonly index: number;
      readonly px: Point;
      readonly world: WorldPoint;
    }
  /** Ask for a sensor's name. */
  | { readonly kind: 'name-sensor'; readonly id: string; readonly name: string | null };

export const NONE: ClickResult = { kind: 'none' };

/** Why a sensor or car end was refused: no track is near enough to land on. */
export const NO_TRACK = 'No track here — sensors and cars sit on a track.';

export const NO_TRACK_NOTICE: ClickResult = { kind: 'notice', message: NO_TRACK };

/** A live chain as the editor draws it: the dot the next segment starts from, and a track's trace. */
export type ChainView =
  | { readonly tool: 'car'; readonly end: Point }
  | {
      readonly tool: 'track';
      readonly end: Point;
      /** The track the chain writes, which the trace draws in its place; null before the second click. */
      readonly line: number | null;
      /**
       * The line as drawn, in the order traced: no nodes before the second
       * click. A straight mark on its last click, the one the chain goes on
       * from, says a double-click asked for the next gap to be straight.
       */
      readonly trace: Track;
    };

/** A chain in progress. */
export interface Chain {
  readonly tool: 'car' | 'track';
  view(): ChainView;
  /** Whether nothing it wrote is still in the manifest. */
  atStart(): boolean;
  /**
   * Writes the segment a click at `at` adds, or says why it adds none. A click
   * within the grab radius of the last dot adds nothing.
   */
  extend(at: Point, scale: number): Promise<ClickResult>;
  /** Brings the chain in step with the manifest. False once it cannot go on. */
  settle(): boolean;
}

/** What a chain tool's click lands on. */
export type ChainHit =
  /** Empty image or a free end: a chain starts or goes on from there. */
  | { readonly kind: 'chain'; readonly chain: Chain }
  /** A segment, which the click splits, or a dot the chain cannot go on from. */
  | { readonly kind: 'edit'; readonly run: () => Promise<ClickResult> };

/** What a chain tool reads and writes through the session. */
export interface ChainContext {
  manifest(): ManifestData;
  /** The image on screen. */
  image(): Image | undefined;
  scene(): HitScene;
  /** `at` on the nearest track, in whole pixels, or null when none is near enough. */
  snap(at: Point): Point | null;
  /** Runs a write through the history, then tells the listeners. */
  record(label: string, target: HistoryTarget, mutate: () => void): Promise<void>;
  /** Says the click or edit was refused, and why: the hint says so until the next one. */
  refuse(reason: Refusal): void;
  writeLayout(changes: {
    calibrationPoints?: readonly ReferencePoint[];
    sensors?: readonly Sensor[];
    tracks?: readonly Track[];
  }): void;
  writeImage(filename: string, changes: { labels?: readonly CarLabel[] }): void;
}

/**
 * A chain tool's half of a click with no chain live, or null when nothing of
 * its own is under `at` and the session asks the other objects.
 */
export type ChainTool = (ctx: ChainContext, at: Point, scale: number) => ChainHit | null;

/** The grab radius at the scale the pointer event reported. */
export function grab(scale: number): HitTolerance {
  return { screenPx: DEFAULT_GRAB_RADIUS_SCREEN_PX, imagePxPerScreenPx: scale };
}

/** `at` in whole image pixels. */
export function pixel(at: Point): Point {
  return { x: Math.round(at.x), y: Math.round(at.y) };
}
