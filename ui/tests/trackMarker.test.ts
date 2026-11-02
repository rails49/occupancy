import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import type { Point } from '@rails49/r49';
import { renderPendingTrack, renderTrack, trackMarkerStyles } from '../src/trackMarker.js';
import type { TrackSymbolSize } from '../src/trackMarker.js';
import type { Track } from '../src/track.js';
import type { Ahead, Fit } from '../src/trackFit.js';
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

  it('marks no click, however far from the line it lies', () => {
    const off: Track = { ...track, clicks: [...track.clicks!.slice(0, 2), { x: 350, y: 120 }, track.clicks![3]] };
    const el = renderSvg(renderTrack(off, size));
    expect([...el.querySelectorAll('.click')].map(c => c.getAttribute('class'))).toEqual(['click', 'click', 'click', 'click']);
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

  it('has no red class in its styles', () => {
    expect(trackMarkerStyles.cssText).not.toMatch(/red|danger/);
  });
});

describe('renderPendingTrack', () => {
  /** A straight fit from (0, 0) heading along +x, one part per length. */
  function straight(lengths: readonly number[]): Fit {
    return { start: { x: 0, y: 0, heading: 0 }, parts: lengths.map(length => ({ length, curvature: 0 })) };
  }

  const clicks: Point[] = [0, 50, 100, 150, 200, 250, 300].map(x => ({ x, y: 0 }));

  /** Where the straight goes on from: its end, straight ahead. */
  const ahead: Ahead = { start: { x: 300, y: 0, heading: 0 }, curvature: 0 };
  const image = { width: 1000, height: 600 };

  function view(over: Partial<TraceView>): TraceView {
    return { clicks, partStarts: [], fit: null, ahead: null, ...over };
  }

  /** The last point of a polyline, within a sample step of where the line leaves the image. */
  function endOf(el: Element): number[] {
    const points = el.getAttribute('points')!.split(' ');
    return points[points.length - 1].split(',').map(Number);
  }

  it('draws the rails and the centerline of the fit, solid, and a dot per click', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([100, 200]), ahead }), size, image));
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    const centerline = el.querySelectorAll('.centerline');
    expect(centerline).toHaveLength(1);
    expect(centerline[0].getAttribute('stroke-dasharray')).toBeNull();
    expect(el.querySelectorAll('.click')).toHaveLength(clicks.length);
    expect(el.querySelectorAll('.bar, .tail')).toHaveLength(0);
  });

  it('draws the projection ahead of the line as a dashed centerline to the edge of the image, with no rails and no tangent after a straight', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([300]), ahead }), size, image));
    const projection = el.querySelectorAll('.projection');
    expect(projection).toHaveLength(1);
    expect(projection[0].getAttribute('stroke-dasharray')).toMatch(/^[1-9]/);
    expect(projection[0].getAttribute('points')).toMatch(/^300,0 /);
    expect(endOf(projection[0])).toEqual([expect.closeTo(1000, -1), 0]);
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    expect(el.querySelectorAll('.tangent')).toHaveLength(0);
  });

  it('draws the tangent after an arc as a dotted line to the edge, beside the projection, which stops at the edge too', () => {
    // An arc of 400 px radius bending up from (300, 300): its projection
    // leaves the image at the top; the tangent runs along y = 300.
    const arc: Ahead = { start: { x: 300, y: 300, heading: 0 }, curvature: -1 / 400 };
    const el = renderSvg(renderPendingTrack(view({ fit: straight([300]), ahead: arc }), size, image));
    const tangent = el.querySelector('.tangent')!;
    expect(tangent.getAttribute('stroke-dasharray')).toMatch(/^0 /);
    expect(tangent.getAttribute('points')).toMatch(/^300,300 /);
    expect(endOf(tangent)).toEqual([expect.closeTo(1000, -1), 300]);
    const projection = el.querySelector('.projection')!.getAttribute('points')!.split(' ');
    expect(projection.length).toBeGreaterThan(2);
    const [, last] = projection[projection.length - 1].split(',').map(Number);
    expect(last).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThan(3);
    expect(projection.every(p => p.split(',').map(Number).every(v => v >= 0))).toBe(true);
  });

  it('draws a loop that stays inside the image as one turn of the circle', () => {
    const loop: Ahead = { start: { x: 500, y: 300, heading: 0 }, curvature: 1 / 50 };
    const el = renderSvg(renderPendingTrack(view({ fit: straight([300]), ahead: loop }), size, image));
    const n = el.querySelector('.projection')!.getAttribute('points')!.split(' ').length;
    expect(n).toBeGreaterThan((2 * Math.PI * 50) / 2 - 2);
    expect(n).toBeLessThan((2 * Math.PI * 50) / 2 + 3);
  });

  it('draws the centerline alone with no gauge to space the rails by', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([100]) }), { ...size, dpt: null }, image));
    expect(el.querySelectorAll('.rail')).toHaveLength(0);
    expect(el.querySelectorAll('.centerline')).toHaveLength(1);
  });

  it('draws a dot per click, none marked with no part after the first, and no node dots or handles', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([300]), ahead }), size, image));
    const dots = [...el.querySelectorAll('.click')];
    expect(dots).toHaveLength(clicks.length);
    expect(dots.every(d => d.getAttribute('class') === 'click')).toBe(true);
    expect(el.querySelectorAll('.node, .heading, .heading-handle')).toHaveLength(0);
  });

  it('marks the first click of each part after the first, and no other', () => {
    const el = renderSvg(renderPendingTrack(view({ fit: straight([100, 100, 100]), partStarts: [2, 4] }), size, image));
    const dots = [...el.querySelectorAll('.click')];
    expect(dots.map(d => d.classList.contains('part-start'))).toEqual([false, false, true, false, true, false, false]);
    expect(dots[2].getAttribute('cx')).toBe('100');
    expect(dots[4].getAttribute('cx')).toBe('200');
  });

  it('draws the first click alone before the second', () => {
    const el = renderSvg(renderPendingTrack(view({ clicks: [{ x: 5, y: 5 }] }), size, image));
    expect(el.querySelectorAll('.click')).toHaveLength(1);
    expect(el.querySelectorAll('.centerline, .rail, .projection, .tangent')).toHaveLength(0);
  });
});
