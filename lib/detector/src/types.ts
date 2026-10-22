/**
 * The data shapes L0, the first layer of the occupancy output, is expressed in.
 * L1's shapes are the UI's (`ui/src/occupancy.ts`).
 *
 * Types only — no arithmetic, so both entry points can import them without
 * pulling anything a browser bundle would have to carry.
 */

import type { Point } from '@rails49/r49';

/** The frame a set of pixel coordinates is expressed in. */
export interface Frame {
  readonly width: number;
  readonly height: number;
}

/**
 * One L0 detection: a car's pose exactly as the model emitted it, mapped into
 * the frame the caller asked to be answered in.
 *
 * `width` is **raw** — the model's own prediction, not the DPT-derived
 * constant. Width is a fit to a constant and its deviation is pure error, so
 * L1 substitutes the constant before testing a sensor (see the UI's `occupancy`); but
 * SPEC keeps L0 unfiltered and unmassaged, so a consumer can see what the
 * model actually said. `length` is the long axis and `width` the short one by
 * construction: where the model puts the longer extent on its rotated *y*
 * axis, the decode swaps the two and turns the angle a quarter turn rather
 * than reporting a car narrower than it is long.
 */
export interface Detection {
  /** Box centre, in report-frame pixels. */
  readonly centre: Point;
  /** Long axis, in report-frame pixels. */
  readonly length: number;
  /** Short axis, in report-frame pixels, **as predicted**. */
  readonly width: number;
  /** Orientation of the long axis, in radians from the +x axis. */
  readonly angle: number;
  /** `DETECTOR_CLASSES[index]`, resolved from the tensor's class field. */
  readonly class: string;
  /** The model's score for this box, in `0…1`. */
  readonly confidence: number;
}
