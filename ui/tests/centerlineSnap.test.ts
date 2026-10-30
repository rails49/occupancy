import { describe, expect, it } from 'vitest';
import type { GrayPlane } from '@occupancy/drift';
import type { Point } from '@rails49/r49';
import { carWidthPx } from '../src/geometry.js';
import {
  CROSS_SECTION_G,
  MIN_SYMMETRY,
  SNAP_PITCH_G,
  SNAP_RANGE_G,
  TRACE_STEP_G,
  snapToTrack,
  symmetryScore,
  traceAlong,
} from '../src/centerlineSnap.js';

/**
 * The snap, on synthetic track (#275).
 *
 * Synthetic because the snap is a pure function of pixels and nothing else, so
 * an image built from a cross-section profile exercises it exactly as a
 * photograph does, and the answer is known to the pixel rather than to a
 * hand-read reference line. The crops from the ceiling archives and their
 * reference points are a separate matter: they are what tunes
 * `MIN_SYMMETRY` against real ballast, and that is a person's judgement.
 *
 * Every plane here is built from one profile across the track:
 *
 * ```
 *          railhead                        railhead
 *             v                               v
 *   ────┐ ... ┌─┐ ... ┌──── roadbed ────┐ ... ┌─┐ ... ┌────
 *       └─ off the roadbed              off the roadbed ─┘
 *      -1.3G       -0.5G       0       +0.5G        +1.3G
 * ```
 */

/** DPT 34, the ceiling archives' resolution: a gauge is 34 px. */
const DPT = 34;

/** Half a railhead's width, in gauges — a smooth bump, as a photograph has it. */
const RAIL_SIGMA_G = 0.1;

/**
 * The value at `acrossG` gauges from the middle of the track.
 *
 * Smooth rather than a step, because a photographed railhead is a few pixels of
 * gradient and a hard edge would make these tests measure the sampler's
 * interpolation instead of the snap.
 */
function trackProfile(acrossG: number): number {
  const d = Math.abs(acrossG);
  const roadbed = 0.42 - 0.3 / (1 + Math.exp((1.3 - d) / 0.06));
  const rail = 0.5 * Math.exp(-(((d - 0.5) / RAIL_SIGMA_G) ** 2) / 2);
  return roadbed + rail;
}

function plane(width: number, height: number, value: (x: number, y: number) => number): GrayPlane {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = value(x, y);
  }
  return { width, height, data };
}

/** Straight track running along `y = centreY`, left to right. */
function straightTrack(width = 400, height = 240, centreY = 120): GrayPlane {
  return plane(width, height, (_x, y) => trackProfile((y - centreY) / DPT));
}

/** Track curving on a circle of `radiusG` gauges, centred below the frame. */
function curvedTrack(radiusG: number, centre: Point, width = 420, height = 300): GrayPlane {
  const radius = radiusG * DPT;
  return plane(width, height, (x, y) => trackProfile((Math.hypot(x - centre.x, y - centre.y) - radius) / DPT));
}

/** The direction of a circle's tangent at `at`, turning the way `sign` says. */
function tangent(centre: Point, at: Point, sign: number): Point {
  return { x: sign * -(at.y - centre.y), y: sign * (at.x - centre.x) };
}

const ALONG: Point = { x: 1, y: 0 };

/**
 * A ten-gauge curve, the tightest the ceiling archives carry, with the whole
 * cross-section of the arc's top eight gauges inside the frame.
 */
const ARC = { centre: { x: 400, y: 420 }, radius: 10 * DPT };

function arcTrack(): GrayPlane {
  return curvedTrack(ARC.radius / DPT, ARC.centre, 800, 560);
}

/** Track centres on the issue's `double.jpg`: 153 px apart at DPT 34. */
const DOUBLE_SPACING_G = 4.5;

/** Two parallel tracks, the upper one through `y = 120`. */
function doubleTrack(): GrayPlane {
  return plane(400, 400, (_x, y) =>
    Math.max(
      trackProfile((y - 120) / DPT),
      trackProfile((y - 120 - DOUBLE_SPACING_G * DPT) / DPT)
    )
  );
}

describe('symmetryScore', () => {
  it('is 1 on the middle of a two-rail section', () => {
    const score = symmetryScore(straightTrack(), { x: 200, y: 120 }, ALONG, DPT);
    expect(score).to.be.closeTo(1, 1e-6);
  });

  it('falls off either side of the middle', () => {
    const track = straightTrack();
    const middle = symmetryScore(track, { x: 200, y: 120 }, ALONG, DPT)!;
    for (const offsetG of [-0.5, -0.25, 0.25, 0.5]) {
      const off = symmetryScore(track, { x: 200, y: 120 + offsetG * DPT }, ALONG, DPT);
      expect(off, `at ${offsetG} G`).to.be.lessThan(middle);
    }
  });

  it('does not care about the sign of the direction', () => {
    const track = straightTrack();
    const forward = symmetryScore(track, { x: 200, y: 131 }, ALONG, DPT);
    const backward = symmetryScore(track, { x: 200, y: 131 }, { x: -2, y: 0 }, DPT);
    expect(forward).to.be.closeTo(backward!, 1e-9);
  });

  it('is unchanged by brightness and by contrast, so shadow is still track', () => {
    const lit = straightTrack();
    const shaded = plane(lit.width, lit.height, (_x, y) => trackProfile((y - 120) / DPT) * 0.4 + 0.1);
    expect(symmetryScore(shaded, { x: 200, y: 120 }, ALONG, DPT)).to.be.closeTo(
      symmetryScore(lit, { x: 200, y: 120 }, ALONG, DPT)!,
      1e-6
    );
  });

  it('has no answer where the section runs off the frame', () => {
    // CROSS_SECTION_G/2 gauges above y = 0 is off the image, and an invented
    // edge pixel is the symmetry a point at the border would snap to.
    const track = straightTrack(400, 240, 10);
    expect(CROSS_SECTION_G / 2).to.equal(1.5);
    expect(symmetryScore(track, { x: 200, y: 10 }, ALONG, DPT)).to.be.null;
  });

  it('has no answer on a flat image, where a reflection of nothing matches anything', () => {
    const blank = plane(400, 240, () => 0.37);
    expect(symmetryScore(blank, { x: 200, y: 120 }, ALONG, DPT)).to.be.null;
  });

  it('has no answer without a direction', () => {
    expect(symmetryScore(straightTrack(), { x: 200, y: 120 }, { x: 0, y: 0 }, DPT)).to.be.null;
  });
});

describe('snapToTrack', () => {
  it('moves a rough click onto the middle of straight track', () => {
    const track = straightTrack();
    for (const clickG of [-0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6]) {
      const snapped = snapToTrack(track, { x: 200, y: 120 + clickG * DPT }, ALONG, DPT);
      expect(snapped, `click at ${clickG} G`).to.not.be.null;
      expect(Math.abs(snapped!.at.y - 120) / DPT, `click at ${clickG} G`).to.be.lessThan(0.25);
    }
  });

  it('reports how far it moved the point, and leaves the along-track position alone', () => {
    const snapped = snapToTrack(straightTrack(), { x: 200, y: 134 }, ALONG, DPT)!;
    expect(snapped.at.x).to.be.closeTo(200, 1e-9);
    expect(snapped.at.y - 134).to.be.closeTo(snapped.offsetPx * -1, 1e-9);
    expect(Math.abs(snapped.offsetPx)).to.be.at.most(SNAP_RANGE_G * DPT);
  });

  it('moves no further than it has to when the image cannot tell two offsets apart', () => {
    // Already on the middle: the score peaks at offset 0 and the search runs
    // outwards, so a tie keeps the point where it is.
    const snapped = snapToTrack(straightTrack(), { x: 200, y: 120 }, ALONG, DPT)!;
    expect(snapped.offsetPx).to.equal(0);
  });

  it('snaps across a curve as well as a straight, given the tangent', () => {
    const on = { x: ARC.centre.x, y: ARC.centre.y - ARC.radius };
    const click = { x: on.x, y: on.y + 0.4 * DPT };
    const snapped = snapToTrack(arcTrack(), click, tangent(ARC.centre, on, 1), DPT)!;
    expect(snapped).to.not.be.null;
    const offG = (Math.hypot(snapped.at.x - ARC.centre.x, snapped.at.y - ARC.centre.y) - ARC.radius) / DPT;
    expect(Math.abs(offG)).to.be.lessThan(0.25);
  });

  it('refuses rather than snapping onto a lone rail when one is hidden', () => {
    // A car, a shadow or a structure covers one side of the track. A lone rail
    // is perfectly symmetric about *itself*, so the trap is a confident snap
    // half a gauge off; the scored band's far side is plain ballast, so there is
    // nothing to match.
    const hidden = plane(400, 240, (_x, y) => {
      const acrossG = (y - 120) / DPT;
      return acrossG > 0.2 ? 0.5 : trackProfile(acrossG);
    });
    for (const clickG of [-0.3, 0, 0.3]) {
      expect(snapToTrack(hidden, { x: 200, y: 120 + clickG * DPT }, ALONG, DPT), `click at ${clickG} G`).to.be.null;
    }
  });

  it('scores a hidden rail below a visible pair, whatever the threshold is set to', () => {
    // The relative claim, independent of MIN_SYMMETRY: occluding one side
    // destroys the symmetry rather than merely denting it.
    const both = symmetryScore(straightTrack(), { x: 200, y: 120 }, ALONG, DPT)!;
    const hidden = plane(400, 240, (_x, y) => {
      const acrossG = (y - 120) / DPT;
      return acrossG > 0.2 ? 0.5 : trackProfile(acrossG);
    });
    const one = symmetryScore(hidden, { x: 200, y: 120 }, ALONG, DPT);
    expect(one === null || one < both).to.be.true;
  });

  it('refuses on a flat image and at the frame edge', () => {
    expect(snapToTrack(plane(400, 240, () => 0.37), { x: 200, y: 120 }, ALONG, DPT)).to.be.null;
    expect(snapToTrack(straightTrack(400, 240, 10), { x: 200, y: 10 }, ALONG, DPT)).to.be.null;
  });

  it('refuses without a direction, which is why the first click of a run is unsnapped', () => {
    expect(snapToTrack(straightTrack(), { x: 200, y: 120 }, { x: 0, y: 0 }, DPT)).to.be.null;
  });

  it('stays on the clicked track of a double-track pair', () => {
    const snapped = snapToTrack(doubleTrack(), { x: 200, y: 120 + 0.4 * DPT }, ALONG, DPT)!;
    expect(snapped).to.not.be.null;
    expect(Math.abs(snapped.at.y - 120) / DPT).to.be.lessThan(0.25);
  });

  it('cannot reach the midline between two tracks, which is symmetric too', () => {
    // The method sees *every* mirror symmetry, and a parallel pair has one
    // halfway between them. SNAP_RANGE_G is what keeps it out of reach, and the
    // bound is a real one: two tracks less than 2 x SNAP_RANGE_G apart centre
    // to centre would put their midline within a click's reach, and two cars
    // 2.09 G wide cannot pass on a pair that close.
    expect(2 * SNAP_RANGE_G).to.be.lessThan(carWidthPx(1));
    const track = doubleTrack();
    const midline = 120 + (DOUBLE_SPACING_G / 2) * DPT;
    // High-scoring, so this is a reach limit and not a quality judgement.
    expect(symmetryScore(track, { x: 200, y: midline }, ALONG, DPT)).to.be.greaterThan(MIN_SYMMETRY);
    // And unreachable from a click anywhere on either track.
    for (const clickG of [-0.5, 0, 0.5]) {
      const snapped = snapToTrack(track, { x: 200, y: 120 + clickG * DPT }, ALONG, DPT)!;
      expect(Math.abs(snapped.at.y - 120) / DPT, `click at ${clickG} G`).to.be.lessThan(0.25);
    }
  });

  it('searches at the declared pitch, so it can land between pixels', () => {
    const snapped = snapToTrack(straightTrack(), { x: 200, y: 123 }, ALONG, DPT)!;
    const steps = snapped.offsetPx / (SNAP_PITCH_G * DPT);
    expect(steps).to.be.closeTo(Math.round(steps), 1e-9);
  });
});

describe('traceAlong', () => {
  it('fills a straight stretch a gauge at a time and reaches the closing click', () => {
    const track = straightTrack(600, 240, 120);
    const from = { x: 40, y: 120 };
    const to = { x: 560, y: 120 };
    const trace = traceAlong(track, from, to, DPT);

    expect(trace.stop).to.equal('reached');
    expect(trace.markAt).to.be.null;
    expect(trace.points.length).to.be.greaterThan(10);
    for (const point of trace.points) {
      expect(Math.abs(point.y - 120) / DPT).to.be.lessThan(0.25);
    }
    // Neither click is in the list: the caller owns those.
    expect(trace.points).to.not.deep.include(from);
    expect(trace.points).to.not.deep.include(to);
    // Steps of one gauge, within the correction the snap applies across them.
    let previous = from;
    for (const point of trace.points) {
      expect(Math.hypot(point.x - previous.x, point.y - previous.y)).to.be.closeTo(
        TRACE_STEP_G * DPT,
        0.3 * DPT
      );
      previous = point;
    }
  });

  it('follows a curve, with every point within a quarter gauge of the track', () => {
    const { centre, radius } = ARC;
    // Two clicks on the arc, eight gauges apart along it.
    const at = (angle: number) => ({
      x: centre.x + radius * Math.cos(angle),
      y: centre.y + radius * Math.sin(angle),
    });
    const trace = traceAlong(arcTrack(), at(-Math.PI / 2 - 0.4), at(-Math.PI / 2 + 0.4), DPT);

    expect(trace.stop).to.equal('reached');
    expect(trace.points.length).to.be.greaterThan(5);
    for (const point of trace.points) {
      const offG = (Math.hypot(point.x - centre.x, point.y - centre.y) - radius) / DPT;
      expect(Math.abs(offG), `point ${JSON.stringify(point)}`).to.be.lessThan(0.25);
    }
  });

  it('stops at the last good point and marks the spot where the track goes unclear', () => {
    // The track stops halfway: past x = 300 there is only flat background, the
    // way a turnout, clutter or a frame edge ends a readable section.
    const track = plane(600, 240, (x, y) => (x > 300 ? 0.4 : trackProfile((y - 120) / DPT)));
    const trace = traceAlong(track, { x: 40, y: 120 }, { x: 560, y: 120 }, DPT);

    expect(trace.stop).to.equal('unclear');
    expect(trace.markAt).to.not.be.null;
    expect(trace.markAt!.x).to.be.greaterThan(250);
    expect(trace.markAt!.x).to.be.lessThan(380);
    for (const point of trace.points) expect(point.x).to.be.lessThan(320);
  });

  it('stops before a point would fall in a blocked area, and marks it', () => {
    const track = straightTrack(600, 240, 120);
    const trace = traceAlong(track, { x: 40, y: 120 }, { x: 560, y: 120 }, DPT, {
      blocked: at => at.x > 300,
    });

    expect(trace.stop).to.equal('blocked');
    expect(trace.markAt!.x).to.be.greaterThan(300);
    for (const point of trace.points) expect(point.x).to.be.at.most(300);
  });

  it('lays nothing when the two clicks are within a step of each other', () => {
    const track = straightTrack();
    const trace = traceAlong(track, { x: 200, y: 120 }, { x: 200 + 0.5 * DPT, y: 120 }, DPT);
    expect(trace).to.deep.equal({ points: [], stop: 'reached', markAt: null });
  });

  it('lays nothing for two clicks on the same pixel', () => {
    const track = straightTrack();
    const trace = traceAlong(track, { x: 200, y: 120 }, { x: 200, y: 120 }, DPT);
    expect(trace).to.deep.equal({ points: [], stop: 'reached', markAt: null });
  });

  it('gives up rather than circling when the rails lead away from the click', () => {
    // A closed loop and a click off it: the sections stay symmetric all the way
    // round, so only the divergence test ends the run.
    const centre = { x: 160, y: 160 };
    const radiusG = 3;
    const radius = radiusG * DPT;
    const track = curvedTrack(radiusG, centre, 320, 320);
    const on = { x: centre.x + radius, y: centre.y };
    const trace = traceAlong(track, on, { x: 310, y: 10 }, DPT);

    expect(trace.stop).to.equal('astray');
    expect(trace.markAt).to.not.be.null;
  });

  it('calls a DPT that does not resolve unclear, not reached', () => {
    // No gauge, no cross-section, so nothing was measured. `reached` would read
    // as a complete stretch and let the caller keep a straight line between two
    // distant clicks as though the rails had been followed.
    const trace = traceAlong(straightTrack(), { x: 40, y: 120 }, { x: 300, y: 120 }, 0);
    expect(trace).to.deep.equal({ points: [], stop: 'unclear', markAt: { x: 40, y: 120 } });
  });

  it('holds the trace to the threshold the snap is held to', () => {
    // The stop at an unclear section is MIN_SYMMETRY's, not a second number.
    expect(MIN_SYMMETRY).to.be.greaterThan(0).and.to.be.at.most(1);
  });
});
