import { describe, it, expect } from 'vitest';
import {
  clicksOff,
  hitClick,
  hitTrack,
  offsetPoints,
  pointAt,
  segment,
  tangentAt,
  trackPath,
  wrapAngle,
  nearestOnTrack,
  segments,
} from '../src/track.js';
import type { Track, TrackNode } from '../src/track.js';

function node(x: number, y: number, heading: number): TrackNode {
  return { x, y, heading };
}

describe('wrapAngle', () => {
  it('maps into (-π, π]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(3 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(-5 * Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('segment', () => {
  it('puts both handles on the chord for a straight', () => {
    const s = segment(node(0, 0, 0), node(300, 0, 0));
    expect(s.c0).toEqual({ x: 100, y: 0 });
    expect(s.c1).toEqual({ x: 200, y: 0 });
  });

  it('follows a circular arc when the headings are symmetric about the chord', () => {
    // A quarter circle of radius 100 centred on (0, 100), from (0, 0) to (100, 100).
    const s = segment(node(0, 0, 0), node(100, 100, Math.PI / 2));
    for (let t = 0; t <= 1; t += 0.05) {
      const p = pointAt(s, t);
      expect(Math.hypot(p.x, p.y - 100)).toBeCloseTo(100, 0);
    }
  });

  it('leaves each node along its heading', () => {
    const s = segment(node(0, 0, 0.3), node(200, 80, 0.5));
    const v0 = tangentAt(s, 0);
    const v1 = tangentAt(s, 1);
    expect(Math.atan2(v0.y, v0.x)).toBeCloseTo(0.3);
    expect(Math.atan2(v1.y, v1.x)).toBeCloseTo(0.5);
  });
});

describe('trackPath', () => {
  it('draws one cubic per segment', () => {
    const d = trackPath([node(0, 0, 0), node(300, 0, 0), node(600, 0, 0)]);
    expect(d).toBe('M 0 0 C 100 0 200 0 300 0 C 400 0 500 0 600 0');
  });
});

describe('offsetPoints', () => {
  it('runs parallel to a straight, to its right in image pixels', () => {
    const points = offsetPoints([node(0, 0, 0), node(100, 0, 0)], 5);
    expect(points.length).toBeGreaterThan(2);
    for (const p of points) expect(p.y).toBeCloseTo(5);
    expect(points[0].x).toBeCloseTo(0);
    expect(points[points.length - 1].x).toBeCloseTo(100);
  });

  it('stays the offset away from an arc', () => {
    const points = offsetPoints([node(0, 0, 0), node(100, 100, Math.PI / 2)], 10);
    for (const p of points) expect(Math.hypot(p.x, p.y - 100)).toBeCloseTo(90, 0);
  });
});

describe('hitTrack', () => {
  const tracks = [{ nodes: [node(100, 100, 0), node(300, 100, 0)] }];

  it('finds the line under the pointer, its ends included', () => {
    expect(hitTrack(tracks, { x: 200, y: 105 }, 14)).toEqual({ line: 0 });
    expect(hitTrack(tracks, { x: 100, y: 103 }, 14)).toEqual({ line: 0 });
  });

  it('takes the nearer of two lines', () => {
    const two = [...tracks, { nodes: [node(100, 120, 0), node(300, 120, 0)] }];
    expect(hitTrack(two, { x: 200, y: 112 }, 14)).toEqual({ line: 1 });
  });

  it('finds nothing beyond the radius', () => {
    expect(hitTrack(tracks, { x: 200, y: 130 }, 14)).toBeNull();
  });
});

describe('hitClick', () => {
  const nodes = [node(100, 100, 0), node(300, 100, 0)];
  const tracks: Track[] = [
    { nodes, clicks: [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 300, y: 100 }] },
    { nodes },
    { nodes, clicks: [{ x: 200, y: 120 }] },
  ];

  it('finds the click nearest the pointer, by line and index', () => {
    expect(hitClick(tracks, { x: 205, y: 104 }, 14)).toEqual({ line: 0, index: 1 });
    expect(hitClick(tracks, { x: 200, y: 115 }, 14)).toEqual({ line: 2, index: 0 });
  });

  it('finds nothing beyond the radius, or on a line without clicks', () => {
    expect(hitClick(tracks, { x: 250, y: 100 }, 14)).toBeNull();
    expect(hitClick([{ nodes }], { x: 100, y: 100 }, 14)).toBeNull();
  });
});

describe('clicksOff', () => {
  const nodes = [node(100, 100, 0), node(300, 100, 0)];

  it('gives the indices of the clicks farther than the reach from the line', () => {
    const track: Track = { nodes, clicks: [{ x: 100, y: 100 }, { x: 150, y: 103 }, { x: 200, y: 110 }, { x: 300, y: 95 }] };
    expect(clicksOff(track, 5)).toEqual([2]);
  });

  it('gives none for a line without clicks', () => {
    expect(clicksOff({ nodes }, 5)).toEqual([]);
  });
});

describe('nearestOnTrack', () => {
  const straight: Track[] = [
    {
      nodes: [
        { x: 0, y: 100, heading: 0 },
        { x: 1000, y: 100, heading: 0 },
      ],
    },
  ];

  it('moves a point straight onto a straight, exactly', () => {
    const p = nearestOnTrack(straight, { x: 333, y: 140 }, 50)!;
    expect(p.x).toBeCloseTo(333, 6);
    expect(p.y).toBeCloseTo(100, 6);
  });

  it('finds nothing beyond the reach', () => {
    expect(nearestOnTrack(straight, { x: 333, y: 151 }, 50)).toBeNull();
    expect(nearestOnTrack([], { x: 0, y: 0 }, 50)).toBeNull();
  });

  it('takes the nearer of two tracks', () => {
    const two: Track[] = [...straight, { nodes: straight[0].nodes.map(n => ({ ...n, y: 200 })) }];
    expect(nearestOnTrack(two, { x: 500, y: 160 }, 100)!.y).toBeCloseTo(200, 6);
  });

  it('lands on a curve, at the curve\'s own distance', () => {
    const arc = segments([
      { x: 0, y: 0, heading: 0 },
      { x: 100, y: 100, heading: Math.PI / 2 },
    ])[0];
    const on = pointAt(arc, 0.5);
    const curve: Track = {
      nodes: [
        { x: 0, y: 0, heading: 0 },
        { x: 100, y: 100, heading: Math.PI / 2 },
      ],
    };
    const p = nearestOnTrack([curve], { x: on.x + 3, y: on.y - 3 }, 20)!;
    expect(Math.hypot(p.x - on.x, p.y - on.y)).toBeLessThan(0.5);
  });
});

