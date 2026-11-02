import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import type { Point } from '@rails49/r49';
import { renderPendingTrack, renderTrack, trackMarkerStyles } from '../src/trackMarker.js';
import type { TrackSymbolSize } from '../src/trackMarker.js';
import type { Track } from '../src/track.js';
import type { Fit, FitResult, Join } from '../src/trackFit.js';
import type { TraceView } from '../src/trackTrace.js';
import { HIGHLIGHT_CLASS } from '../src/highlight.js';

/** Render a lit SVGTemplateResult into a detached <svg> and return it. */
function renderSvg(template: ReturnType<typeof svg>): SVGElement {
  const container = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  render(template, container);
  return container;
}

const track: Track = {
  nodes: [
    { x: 100, y: 100, heading: 0 },
    { x: 300, y: 100, heading: 0 },
    { x: 500, y: 100, heading: 0 },
  ],
  clicks: [
    { x: 100, y: 100 },
    { x: 200, y: 101 },
    { x: 350, y: 99 },
    { x: 500, y: 100 },
  ],
};

/** A gauge of 10 px: the bar cap is 40 px. */
const size: TrackSymbolSize = { dpt: 10, strokePx: 2, dotPx: 12, detail: true };

describe('renderTrack', () => {
  it('draws the centerline, both rails and a dot per click, and no node dots or handles', () => {
    const el = renderSvg(renderTrack(track, size));
    expect(el.querySelectorAll('.centerline')).toHaveLength(1);
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    expect(el.querySelectorAll('.click')).toHaveLength(4);
    expect(el.querySelectorAll('.node, .heading, .heading-handle, .bar')).toHaveLength(0);
  });

  it('draws a click past the tolerance from the line red, and the others not', () => {
    // The tolerance is 0.25 G, 2.5 px here: 1 px off is in, 20 px off is out.
    const off: Track = { ...track, clicks: [...track.clicks!.slice(0, 2), { x: 350, y: 120 }, track.clicks![3]] };
    const el = renderSvg(renderTrack(off, size));
    const red = [...el.querySelectorAll('.click')].map(c => c.classList.contains('outlier'));
    expect(red).toEqual([false, false, true, false]);
  });

  it('flags no click with no gauge to measure the tolerance in', () => {
    const off: Track = { ...track, clicks: [...track.clicks!.slice(0, 2), { x: 350, y: 120 }, track.clicks![3]] };
    const el = renderSvg(renderTrack(off, { ...size, dpt: null }));
    expect(el.querySelectorAll('.click.outlier')).toHaveLength(0);
  });

  it('draws the centerline alone without the detail', () => {
    const el = renderSvg(renderTrack(track, { ...size, detail: false }));
    expect(el.querySelectorAll('.centerline')).toHaveLength(1);
    expect(el.querySelectorAll('.rail, .click, .node')).toHaveLength(0);
  });

  it('lights a click a reveal points at, drawn without the detail too, and no node', () => {
    const lit = (detail: boolean) => {
      const el = renderSvg(renderTrack(track, { ...size, detail }, [{ x: 200, y: 101 }]));
      expect(el.querySelectorAll('.node')).toHaveLength(0);
      return [...el.querySelectorAll('.click')].map(c => c.classList.contains(HIGHLIGHT_CLASS));
    };
    expect(lit(true)).toEqual([false, true, false, false]);
    expect(lit(false)).toEqual([true]);
  });

  it('draws flagged clicks in the danger token', () => {
    expect(trackMarkerStyles.cssText).toMatch(/\.click\.outlier\s*\{\s*fill: var\(--sl-color-danger-500\);/);
  });
});

describe('renderPendingTrack', () => {
  /** A straight fit from (x, 0) heading along +x, one part per length. */
  function straight(x: number, lengths: readonly number[]): Fit {
    return { start: { x, y: 0, heading: 0 }, parts: lengths.map(length => ({ length, curvature: 0 })) };
  }

  /** The live tail `fit`, its joins carrying `sigmas`. */
  function live(fit: Fit, sigmas: readonly number[]): FitResult {
    let x = fit.start.x;
    const joins: Join[] = sigmas.map((sigma, i) => {
      const join = { x, y: 0, heading: 0, sigma, ux: 1, uy: 0 };
      x += fit.parts[i]?.length ?? 0;
      return join;
    });
    return { fit, residuals: [], partOf: [], worst: 0, rms: 0, joins, outliers: [] };
  }

  const clicks: Point[] = [0, 50, 100, 150, 200, 250, 300].map(x => ({ x, y: 0 }));

  function view(over: Partial<TraceView>): TraceView {
    return { clicks, committed: null, live: null, flagged: [], ...over };
  }

  /** Each bar's centre and half-length. */
  function bars(el: SVGElement) {
    return [...el.querySelectorAll('.bar')].map(b => {
      const [x1, y1, x2, y2] = ['x1', 'y1', 'x2', 'y2'].map(a => Number(b.getAttribute(a)));
      return { x: (x1 + x2) / 2, y: (y1 + y2) / 2, half: Math.hypot(x2 - x1, y2 - y1) / 2, across: x1 === x2 };
    });
  }

  it('draws rails only on committed track, and the tail as a dashed centerline', () => {
    const el = renderSvg(
      renderPendingTrack(view({ committed: straight(0, [100]), live: live(straight(100, [100, 100]), [0, 3, 1]) }), size)
    );
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    expect(el.querySelectorAll('.centerline:not(.tail)')).toHaveLength(1);
    const tail = el.querySelectorAll('.centerline.tail');
    expect(tail).toHaveLength(2);
    for (const t of tail) expect(t.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('draws no rails while nothing is committed', () => {
    const el = renderSvg(renderPendingTrack(view({ live: live(straight(0, [100, 100]), [5, 3, 1]) }), size));
    expect(el.querySelectorAll('.rail, .centerline:not(.tail)')).toHaveLength(0);
    expect(el.querySelectorAll('.centerline.tail')).toHaveLength(2);
  });

  it('puts a bar across each uncommitted join, half as long as its σ, and none at the start or end', () => {
    const uncommitted = renderSvg(renderPendingTrack(view({ live: live(straight(0, [100, 100]), [5, 3, 1]) }), size));
    expect(bars(uncommitted)).toEqual([{ x: 100, y: 0, half: 3, across: true }]);

    const committed = renderSvg(
      renderPendingTrack(view({ committed: straight(0, [100]), live: live(straight(100, [100, 100]), [0, 3, 1]) }), size)
    );
    expect(bars(committed)).toEqual([{ x: 200, y: 0, half: 3, across: true }]);
  });

  it('draws nothing but the dots for a part with a join at the cap', () => {
    const el = renderSvg(
      renderPendingTrack(view({ committed: straight(0, [100]), live: live(straight(100, [100, 100]), [0, 40, 2]) }), size)
    );
    expect(el.querySelectorAll('.centerline.tail, .bar')).toHaveLength(0);
    expect(el.querySelectorAll('.click')).toHaveLength(clicks.length);
  });

  it('draws a dot per click, flagged ones in the danger ink, and no node dots or handles', () => {
    const el = renderSvg(
      renderPendingTrack(view({ live: live(straight(0, [100, 100]), [5, 3, 1]), flagged: [2] }), size)
    );
    const dots = [...el.querySelectorAll('.click')];
    expect(dots).toHaveLength(clicks.length);
    expect(dots.map(d => d.classList.contains('outlier'))).toEqual([false, false, true, false, false, false, false]);
    expect(el.querySelectorAll('.node, .heading, .heading-handle')).toHaveLength(0);
  });

  it('draws the first click alone before the second', () => {
    const el = renderSvg(renderPendingTrack(view({ clicks: [{ x: 5, y: 5 }] }), size));
    expect(el.querySelectorAll('.click')).toHaveLength(1);
    expect(el.querySelectorAll('.centerline, .rail, .bar')).toHaveLength(0);
  });
});
