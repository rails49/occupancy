import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import { renderPendingTrack, renderTrack, renderTrackCues, trackMarkerStyles } from '../src/trackMarker.js';
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

  it('draws a square in place of the dot at both ends of each straight gap', () => {
    const marked: Track = {
      ...track,
      clicks: [{ x: 100, y: 100 }, { x: 200, y: 101, straight: true }, { x: 350, y: 99 }, { x: 500, y: 100 }],
    };
    const el = renderSvg(renderTrack(marked, size));
    expect([...el.querySelectorAll('.click')].map(c => c.tagName)).toEqual(['circle', 'rect', 'rect', 'circle']);
    const square = el.querySelectorAll('rect.click')[0];
    expect(Number(square.getAttribute('x')) + Number(square.getAttribute('width')) / 2).toBe(200);
    expect(Number(square.getAttribute('y')) + Number(square.getAttribute('height')) / 2).toBe(101);
    expect(square.getAttribute('width')).toBe(String(size.dotPx));
  });

  it('draws the two end dots hollow and the middle dots filled with hollow ends (#324)', () => {
    const el = renderSvg(renderTrack(track, { ...size, hollowEnds: true }));
    expect([...el.querySelectorAll('.click')].map(c => c.classList.contains('end'))).toEqual([true, false, false, true]);
    const filled = renderSvg(renderTrack(track, size));
    expect(filled.querySelectorAll('.click.end')).toHaveLength(0);
  });

  it('inks a track green and the traced line blue (#324)', () => {
    expect(trackMarkerStyles.cssText).toMatch(/\.track\s*\{[^}]*--track-ink:\s*#4ade80/);
    expect(trackMarkerStyles.cssText).toMatch(/\.track-pending\s*\{[^}]*--track-ink:\s*#60a5fa/);
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

  it('draws a square at the click it goes on from when the next gap is to be straight', () => {
    const pending: Track = { ...track, clicks: [...track.clicks!.slice(0, 3), { x: 500, y: 100, straight: true }] };
    const el = renderSvg(renderPendingTrack(pending, size));
    expect([...el.querySelectorAll('.click')].map(c => c.tagName)).toEqual(['circle', 'circle', 'circle', 'rect']);
    const first = renderSvg(renderPendingTrack({ nodes: [], clicks: [{ x: 5, y: 5, straight: true }] }, size));
    expect([...first.querySelectorAll('.click')].map(c => c.tagName)).toEqual(['rect']);
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

  it('rings the click it goes on from when asked, and nothing else (#324)', () => {
    const el = renderSvg(renderPendingTrack(track, size, true));
    const rings = el.querySelectorAll('.ring');
    expect(rings).toHaveLength(1);
    expect(rings[0].tagName).toBe('circle');
    expect([rings[0].getAttribute('cx'), rings[0].getAttribute('cy')]).toEqual(['500', '100']);
    expect(Number(rings[0].getAttribute('r'))).toBeGreaterThan(size.dotPx / 2);
    expect(renderSvg(renderPendingTrack(track, size)).querySelectorAll('.ring')).toHaveLength(0);
  });

  it('rings the first click alone, and a straight mark as a square (#324)', () => {
    const first = renderSvg(renderPendingTrack({ nodes: [], clicks: [{ x: 5, y: 5 }] }, size, true));
    expect([...first.querySelectorAll('.ring')].map(r => r.tagName)).toEqual(['circle']);
    const pending: Track = { ...track, clicks: [...track.clicks!.slice(0, 3), { x: 500, y: 100, straight: true }] };
    const square = renderSvg(renderPendingTrack(pending, size, true)).querySelector('.ring')!;
    expect(square.tagName).toBe('rect');
    expect(Number(square.getAttribute('x')) + Number(square.getAttribute('width')) / 2).toBe(500);
    expect(Number(square.getAttribute('width'))).toBeGreaterThan(size.dotPx);
  });
});

describe('renderTrackCues (#324)', () => {
  const none = { tracing: false, preview: null, hover: null };
  const gap = [
    { x: 500, y: 100, heading: 0 },
    { x: 700, y: 100, heading: 0 },
  ];

  it('draws nothing with no cue', () => {
    const el = renderSvg(renderTrackCues(none, size));
    expect(el.querySelectorAll('*')).toHaveLength(0);
  });

  it('draws the preview as a dashed blue centerline along its nodes', () => {
    const el = renderSvg(renderTrackCues({ ...none, tracing: true, preview: { nodes: gap, refusal: null } }, size));
    const group = el.querySelector('.track-preview')!;
    expect(group.classList.contains('track-pending')).toBe(true);
    expect(group.classList.contains('refused')).toBe(false);
    const path = group.querySelector('.centerline')!;
    expect(path.getAttribute('d')).toBe(trackPath(gap));
    expect(path.getAttribute('stroke-dasharray')).not.toBeNull();
    expect(el.querySelectorAll('.rail, .click')).toHaveLength(0);
  });

  it('marks a refused preview, which its styles draw red', () => {
    const el = renderSvg(renderTrackCues({ ...none, tracing: true, preview: { nodes: gap, refusal: 'tight' } }, size));
    expect(el.querySelector('.track-preview')!.classList.contains('refused')).toBe(true);
    expect(trackMarkerStyles.cssText).toMatch(/\.track-preview\.refused\s*\{[^}]*--track-ink:\s*#ef4444/);
  });

  it('rings an end dot under the pointer in track green, a square for a straight end', () => {
    const el = renderSvg(renderTrackCues({ ...none, hover: { kind: 'end', at: { x: 100, y: 100 }, square: false } }, size));
    const ring = el.querySelector('.ring')!;
    expect(ring.tagName).toBe('circle');
    expect(ring.closest('.track')!.classList.contains('track-pending')).toBe(false);
    const square = renderSvg(renderTrackCues({ ...none, hover: { kind: 'end', at: { x: 100, y: 100 }, square: true } }, size));
    expect(square.querySelector('.ring')!.tagName).toBe('rect');
  });

  it('draws a faint click dot where an insert would go', () => {
    const el = renderSvg(renderTrackCues({ ...none, hover: { kind: 'insert', at: { x: 250, y: 102 } } }, size));
    const dot = el.querySelector('.track-insert .click')!;
    expect([dot.getAttribute('cx'), dot.getAttribute('cy')]).toEqual(['250', '102']);
    expect(trackMarkerStyles.cssText).toMatch(/\.track-insert\s*\{[^}]*opacity:\s*0\.5/);
  });
});
