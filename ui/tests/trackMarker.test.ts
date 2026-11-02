import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import type { Point } from '@rails49/r49';
import { renderPendingTrack, renderTrack, trackMarkerStyles } from '../src/trackMarker.js';
import type { TrackSymbolSize } from '../src/trackMarker.js';
import type { Track } from '../src/track.js';
import type { Fit } from '../src/trackFit.js';
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

/** A gauge of 10 px. */
const size: TrackSymbolSize = { dpt: 10, strokePx: 2, dotPx: 12, detail: true };

describe('renderTrack', () => {
  it('draws the centerline, both rails and a dot per click, and no node dots or handles', () => {
    const el = renderSvg(renderTrack(track, size));
    expect(el.querySelectorAll('.centerline')).toHaveLength(1);
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    expect(el.querySelectorAll('.click')).toHaveLength(4);
    expect(el.querySelectorAll('.node, .heading, .heading-handle')).toHaveLength(0);
  });

  it('draws a click past the tolerance from the line red, and the others not', () => {
    // The tolerance is 0.25 G, 2.5 px here: 1 px off is in, 20 px off is out.
    const off: Track = { ...track, clicks: [...track.clicks!.slice(0, 2), { x: 350, y: 120 }, track.clicks![3]] };
    const el = renderSvg(renderTrack(off, size));
    const red = [...el.querySelectorAll('.click')].map(c => c.classList.contains('red'));
    expect(red).toEqual([false, false, true, false]);
  });

  it('flags no click with no gauge to measure the tolerance in', () => {
    const off: Track = { ...track, clicks: [...track.clicks!.slice(0, 2), { x: 350, y: 120 }, track.clicks![3]] };
    const el = renderSvg(renderTrack(off, { ...size, dpt: null }));
    expect(el.querySelectorAll('.click.red')).toHaveLength(0);
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
    expect(trackMarkerStyles.cssText).toMatch(/\.click\.red\s*\{\s*fill: var\(--sl-color-danger-500\);/);
  });
});

describe('renderPendingTrack', () => {
  /** A straight fit from (0, 0) heading along +x, one part per length. */
  function straight(lengths: readonly number[]): Fit {
    return { start: { x: 0, y: 0, heading: 0 }, parts: lengths.map(length => ({ length, curvature: 0 })) };
  }

  const clicks: Point[] = [0, 50, 100, 150, 200, 250, 300].map(x => ({ x, y: 0 }));

  function view(over: Partial<TraceView>): TraceView {
    return { clicks, fit: null, red: [], ...over };
  }

  it('draws the rails and the centerline of the fit, solid, and a dot per click', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([100, 200]) }), size));
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    const centerline = el.querySelectorAll('.centerline');
    expect(centerline).toHaveLength(1);
    expect(centerline[0].getAttribute('stroke-dasharray')).toBeNull();
    expect(el.querySelectorAll('.click')).toHaveLength(clicks.length);
    expect(el.querySelectorAll('.bar, .tail')).toHaveLength(0);
  });

  it('draws the centerline alone with no gauge to space the rails by', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([100]) }), { ...size, dpt: null }));
    expect(el.querySelectorAll('.rail')).toHaveLength(0);
    expect(el.querySelectorAll('.centerline')).toHaveLength(1);
  });

  it('draws a dot per click, red ones in the danger ink, and no node dots or handles', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([300]), red: [2] }), size));
    const dots = [...el.querySelectorAll('.click')];
    expect(dots).toHaveLength(clicks.length);
    expect(dots.map(d => d.classList.contains('red'))).toEqual([false, false, true, false, false, false, false]);
    expect(el.querySelectorAll('.node, .heading, .heading-handle')).toHaveLength(0);
  });

  it('draws the first click alone before the second', () => {
    const el = renderSvg(renderPendingTrack(view({ clicks: [{ x: 5, y: 5 }] }), size));
    expect(el.querySelectorAll('.click')).toHaveLength(1);
    expect(el.querySelectorAll('.centerline, .rail')).toHaveLength(0);
  });
});
