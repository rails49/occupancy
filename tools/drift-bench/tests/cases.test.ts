import { describe, expect, it } from 'vitest';
import { makeImage } from '../src/image.ts';
import { buildCases, requiredMargin, DecodedArchive } from '../src/cases.ts';

function noiseImage(width: number, height: number, seed: number) {
  const img = makeImage(width, height);
  let s = seed;
  for (let i = 0; i < img.data.length; i++) {
    // deterministic LCG noise; content is irrelevant, distinctness is not
    s = (s * 1664525 + 1013904223) >>> 0;
    img.data[i] = (s >>> 8) / 2 ** 24;
  }
  return img;
}

function archive(name: string, imageCount: number, size = 128): DecodedArchive {
  return {
    name,
    images: Array.from({ length: imageCount }, (_, i) => ({
      filename: `img-${i}.jpg`,
      image: noiseImage(size, size, i + 1),
    })),
  };
}

describe('buildCases', () => {
  it('skips archives with fewer than two images', () => {
    expect(buildCases([archive('lonely.r49', 1)])).toEqual([]);
  });

  it('emits every grade once per image, refs excluding the source', () => {
    const cases = buildCases([archive('a.r49', 3)]);
    const perImage = cases.filter((c) => c.source === 'img-0.jpg');
    // 1 sibling + 4 photometric pass grades, 11 flag grades
    expect(perImage.filter((c) => c.expect === 'pass')).toHaveLength(5);
    expect(perImage.filter((c) => c.expect === 'flag')).toHaveLength(11);
    expect(cases).toHaveLength(3 * 16);
    for (const c of perImage) expect(c.refs).toHaveLength(2);
  });

  it('crops frame and refs to identical dimensions', () => {
    const size = 128;
    const cases = buildCases([archive('a.r49', 2, size)]);
    const margin = requiredMargin(size, size);
    for (const c of cases) {
      expect(c.frame.width).toBe(size - 2 * margin);
      expect(c.frame.height).toBe(size - 2 * margin);
      for (const r of c.refs) {
        expect(r.width).toBe(c.frame.width);
        expect(r.height).toBe(c.frame.height);
      }
    }
  });

  it('sibling pass frames match the cropped original exactly', () => {
    const cases = buildCases([archive('a.r49', 2)]);
    const sibling = cases.find((c) => c.grade === 'pass:sibling' && c.source === 'img-1.jpg')!;
    const other = cases.find((c) => c.grade === 'pass:sibling' && c.source === 'img-0.jpg')!;
    // img-1's frame is img-0's only ref, both derived independently
    expect(Array.from(sibling.frame.data)).toEqual(Array.from(other.refs[0].data));
  });
});

describe('buildCases with refs: first', () => {
  it('scores every image but the first against the first alone', () => {
    const a = archive('a.r49', 3);
    const cases = buildCases([a], { refs: 'first' });
    expect(cases).toHaveLength(2 * 16);
    expect(cases.some((c) => c.source === 'img-0.jpg')).toBe(false);
    const ref = buildCases([a]).find((c) => c.grade === 'pass:sibling' && c.source === 'img-0.jpg')!;
    for (const c of cases) {
      expect(c.refs).toHaveLength(1);
      expect(Array.from(c.refs[0].data)).toEqual(Array.from(ref.frame.data));
    }
  });
});

describe('requiredMargin', () => {
  it('covers the largest grade displacement with headroom', () => {
    const margin = requiredMargin(960, 540);
    // the 20px translate grade dominates; rotation at 2 deg stays under it
    expect(margin).toBeGreaterThanOrEqual(22);
    expect(margin).toBeLessThan(40);
  });
});
