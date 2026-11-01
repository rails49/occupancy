import { describe, it, expect } from 'vitest';
import { render, svg } from 'lit';
import { renderTrack } from '../src/trackMarker.js';
import type { TrackSymbolSize } from '../src/trackMarker.js';
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
};

const size: TrackSymbolSize = { dpt: 90, strokePx: 2, nodePx: 12, handlePx: 36 };

describe('renderTrack', () => {
  it('draws the centerline, both rails, a dot per node and a handle per node', () => {
    const el = renderSvg(renderTrack(track, size));
    expect(el.querySelectorAll('.centerline')).toHaveLength(1);
    expect(el.querySelectorAll('.rail')).toHaveLength(2);
    expect(el.querySelectorAll('.node')).toHaveLength(3);
    expect(el.querySelectorAll('.heading-handle')).toHaveLength(3);
  });

  it('lights the node a reveal points at, and no other', () => {
    const el = renderSvg(renderTrack(track, size, [{ x: 300, y: 100 }]));
    const lit = [...el.querySelectorAll('.node')].map(n => n.classList.contains(HIGHLIGHT_CLASS));
    expect(lit).toEqual([false, true, false]);
  });
});
