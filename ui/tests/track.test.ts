import { describe, it, expect } from 'vitest';
import {
  headingHandle,
  hitTrack,
  insertNode,
  reverseNodes,
  offsetPoints,
  pointAt,
  segment,
  tangentAt,
  extendTrack,
  trackPath,
  wrapAngle,
  MAX_TURN,
  nearestOnTrack,
  segments,
} from '../src/track.js';
import type { Track, TrackNode } from '../src/track.js';

const SNAP = 6;

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

describe('extendTrack', () => {
  const start = { x: 0, y: 0 };
  const MIN = 10;
  const straight = [node(0, 0, 0), node(100, 0, 0)];

  /** The nodes a click adds, failing the test if it adds none. */
  function nodesAfter(nodes: readonly TrackNode[], to: { x: number; y: number }, snap = SNAP) {
    const step = extendTrack(start, nodes, to, snap, MIN);
    if (step.kind !== 'node') throw new Error(`expected a node, got ${step.kind}`);
    return step.nodes;
  }

  it('makes the first segment a straight along the chord', () => {
    expect(nodesAfter([], { x: 100, y: 100 })).toEqual([
      node(0, 0, Math.PI / 4),
      node(100, 100, Math.PI / 4),
    ]);
  });

  it('adds nothing for a click within the minimum distance of the start', () => {
    expect(extendTrack(start, [], { x: 6, y: 6 }, SNAP, MIN)).toEqual({ kind: 'too-close' });
  });

  it('ends an arc tangent to the last node, its heading mirrored about the chord', () => {
    const nodes = nodesAfter(straight, { x: 200, y: 100 });
    expect(nodes).toHaveLength(3);
    expect(nodes[2]).toMatchObject({ x: 200, y: 100 });
    expect(nodes[2].heading).toBeCloseTo(Math.PI / 2);
  });

  it('snaps a click near the tangent line onto it as a straight', () => {
    expect(nodesAfter(straight, { x: 300, y: 5 })[2]).toEqual(node(300, 0, 0));
  });

  it('scales the snap with the tolerance it is given', () => {
    const added = nodesAfter(straight, { x: 300, y: 5 }, 2)[2];
    expect(added).toMatchObject({ x: 300, y: 5 });
    expect(added.heading).toBeGreaterThan(0);
  });

  it('refuses a click behind the last node as too sharp', () => {
    expect(extendTrack(start, straight, { x: 50, y: 0 }, SNAP, MIN)).toEqual({ kind: 'too-sharp' });
  });

  it('refuses a turn sharper than the limit and accepts one at it', () => {
    const half = MAX_TURN / 2;
    const ok = { x: 100 + 100 * Math.cos(half - 0.01), y: 100 * Math.sin(half - 0.01) };
    const sharp = { x: 100 + 100 * Math.cos(half + 0.01), y: 100 * Math.sin(half + 0.01) };
    expect(extendTrack(start, straight, ok, SNAP, MIN).kind).toBe('node');
    expect(extendTrack(start, straight, sharp, SNAP, MIN)).toEqual({ kind: 'too-sharp' });
  });

  it('adds nothing for a click within the minimum distance of the last node', () => {
    expect(extendTrack(start, straight, { x: 100, y: 0 }, SNAP, MIN)).toEqual({ kind: 'too-close' });
    expect(extendTrack(start, straight, { x: 95, y: 8 }, SNAP, MIN)).toEqual({ kind: 'too-close' });
  });

  it('keeps every segment G1: each node is shared, with one heading', () => {
    let nodes = nodesAfter([], { x: 100, y: 0 });
    nodes = nodesAfter(nodes, { x: 200, y: 40 });
    nodes = nodesAfter(nodes, { x: 280, y: 120 });
    const out = tangentAt(segment(nodes[1], nodes[2]), 1);
    const into = tangentAt(segment(nodes[2], nodes[3]), 0);
    expect(Math.atan2(out.y, out.x)).toBeCloseTo(Math.atan2(into.y, into.x));
  });
});

describe('hitTrack', () => {
  const tracks = [{ nodes: [node(100, 100, 0), node(300, 100, 0)] }];

  it('prefers a heading handle, then a node, then the curve', () => {
    expect(hitTrack(tracks, { x: 136, y: 100 }, 14, 36)).toEqual({ kind: 'heading', line: 0, node: 0 });
    expect(hitTrack(tracks, { x: 102, y: 103 }, 14, 36)).toEqual({ kind: 'node', line: 0, node: 0 });
    expect(hitTrack(tracks, { x: 200, y: 105 }, 14, 36)).toMatchObject({ kind: 'curve', line: 0, segment: 0 });
  });

  it('finds the point on the curve nearest the pointer', () => {
    const hit = hitTrack(tracks, { x: 200, y: 105 }, 14, null);
    expect(hit?.kind === 'curve' && hit.t).toBeCloseTo(0.5, 1);
  });

  it('tests no handles when none are drawn', () => {
    expect(hitTrack(tracks, { x: 136, y: 100 }, 14, null)).toMatchObject({ kind: 'curve' });
  });

  it('finds nothing beyond the radius', () => {
    expect(hitTrack(tracks, { x: 200, y: 130 }, 14, 36)).toBeNull();
  });
});

describe('insertNode', () => {
  it('puts a node on the curve, heading along it', () => {
    const nodes = insertNode([node(0, 0, 0), node(100, 100, Math.PI / 2)], 0, 0.5);
    expect(nodes).toHaveLength(3);
    expect(Math.hypot(nodes[1].x, nodes[1].y - 100)).toBeCloseTo(100, 0);
    expect(nodes[1].heading).toBeCloseTo(Math.PI / 4, 1);
  });

  it('keeps a straight straight', () => {
    const nodes = insertNode([node(0, 0, 0), node(300, 0, 0)], 0, 0.5);
    expect(nodes[1]).toEqual(node(150, 0, 0));
  });
});

describe('reverseNodes', () => {
  it('runs the line the other way', () => {
    const reversed = reverseNodes([node(0, 0, 0), node(100, 0, 0.5)]);
    expect(reversed.map(n => [n.x, n.y])).toEqual([
      [100, 0],
      [0, 0],
    ]);
    expect(reversed[0].heading).toBeCloseTo(0.5 - Math.PI);
    expect(reversed[1].heading).toBeCloseTo(Math.PI);
  });
});

describe('headingHandle', () => {
  it('sits along the heading', () => {
    const p = headingHandle(node(10, 10, Math.PI / 2), 36);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(46);
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

