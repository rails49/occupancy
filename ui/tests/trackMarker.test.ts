import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import { renderPendingTrack, renderTrack, trackMarkerStyles } from '../src/trackMarker.js';
import type { TrackSymbolSize } from '../src/trackMarker.js';
import { trackPath } from '../src/track.js';
import type { Track } from '../src/track.js';
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
  it('draws the rails and the centerline of the line, solid, and a dot per click', () => {
    const el = renderSvg(renderPendingTrack(track, size));
    expect(el.querySelector('.track-pending')).not.toBeNull();
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    const centerline = el.querySelectorAll('.centerline');
    expect(centerline).toHaveLength(1);
    expect(centerline[0].getAttribute('d')).toBe(trackPath(track.nodes));
    expect(centerline[0].getAttribute('stroke-dasharray')).toBeNull();
    expect(el.querySelectorAll('.click')).toHaveLength(track.clicks!.length);
  });

  it('draws no projection, no tangent and no marked click', () => {
    const el = renderSvg(renderPendingTrack(track, size));
    expect(el.querySelectorAll('.projection, .tangent, .part-start, .node, .heading-handle')).toHaveLength(0);
    expect([...el.querySelectorAll('.click')].every(d => d.getAttribute('class') === 'click')).toBe(true);
  });

  it('draws the centerline alone with no gauge to space the rails by', () => {
    const el = renderSvg(renderPendingTrack(track, { ...size, dpt: null }));
    expect(el.querySelectorAll('.rail')).toHaveLength(0);
    expect(el.querySelectorAll('.centerline')).toHaveLength(1);
  });

  it('draws the first click alone before the second', () => {
    const el = renderSvg(renderPendingTrack({ nodes: [], clicks: [{ x: 5, y: 5 }] }, size));
    expect(el.querySelectorAll('.click')).toHaveLength(1);
    expect(el.querySelectorAll('.centerline, .rail')).toHaveLength(0);
  });
});
