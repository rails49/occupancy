import { describe, it, expect } from 'vitest';
import { hitClick, hitTrack, nearestGap, nearestOnTrack, offsetPoints, trackPath } from '../src/track.js';
import type { Track, TrackNode } from '../src/track.js';

function node(x: number, y: number, heading: number): TrackNode {
  return { x, y, heading };
}

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

describe('nearestOnTrack', () => {
  const straight: Track[] = [{ nodes: [node(0, 100, 0), node(1000, 100, 0)] }];

  it('finds the point within the reach', () => {
    expect(nearestOnTrack(straight, { x: 333, y: 140 }, 50)).toEqual({ x: expect.closeTo(333, 6), y: expect.closeTo(100, 6) });
  });

  it('finds nothing beyond the reach', () => {
    expect(nearestOnTrack(straight, { x: 333, y: 151 }, 50)).toBeNull();
    expect(nearestOnTrack([], { x: 0, y: 0 }, 50)).toBeNull();
  });
});

describe('nearestGap', () => {
  const track: Track = {
    nodes: [node(0, 0, 0), node(300, 0, 0)],
    clicks: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }, { x: 300, y: 0 }],
  };

  it('names the gap whose part of the line is nearest, by the click it starts from', () => {
    expect(nearestGap(track, { x: 20, y: -5 })).toBe(0);
    expect(nearestGap(track, { x: 150, y: 5 })).toBe(1);
    expect(nearestGap(track, { x: 290, y: 3 })).toBe(2);
  });

  it('names the last gap past the end of the line', () => {
    expect(nearestGap(track, { x: 400, y: 0 })).toBe(2);
  });
});
