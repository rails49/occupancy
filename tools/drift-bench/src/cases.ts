import { GrayImage, cloneImage, cropBorder } from './image.ts';
import { DriftParams, cornerDisplacement, warpImage } from './warp.ts';
import { brightness, contrast, gamma } from './photometric.ts';

/**
 * The benchmark's ground truth: every case is either legitimate ("pass" —
 * the camera did not move) or drift ("flag"). Grades name the perturbation so
 * the report shows sensitivity per magnitude, not just one binary.
 */
export interface BenchCase {
  archive: string;
  /** manifest filename of the source image */
  source: string;
  /** group label, e.g. "pass:sibling", "flag:translate-5px" */
  grade: string;
  expect: 'pass' | 'flag';
  frame: GrayImage;
  refs: GrayImage[];
}

/** One archive's decoded images, in manifest order. */
export interface DecodedArchive {
  name: string;
  images: { filename: string; image: GrayImage }[];
}

/**
 * Drift grades, calibrated in working-resolution pixels (960-wide frames).
 * Directions alternate deterministically per image index so the set is not
 * biased toward one axis; magnitudes are the contract.
 */
const GOLDEN_ANGLE = 2.399963229728653;

function driftGrades(index: number): { grade: string; params: DriftParams }[] {
  const a = index * GOLDEN_ANGLE;
  const dir = { x: Math.cos(a), y: Math.sin(a) };
  const sign = index % 2 === 0 ? 1 : -1;
  return [
    ...[2, 5, 10, 20].map((px) => ({
      grade: `flag:translate-${px}px`,
      params: { tx: dir.x * px, ty: dir.y * px },
    })),
    ...[0.5, 1, 2].map((deg) => ({
      grade: `flag:rotate-${deg}deg`,
      params: { rotateDeg: sign * deg },
    })),
    ...[1, 2].map((pct) => ({
      grade: `flag:scale-${pct}pct`,
      params: { scale: 1 + (sign * pct) / 100 },
    })),
    { grade: 'flag:perspective', params: { px: sign * 2e-5, py: -sign * 1e-5 } },
    {
      grade: 'flag:combo',
      params: { tx: dir.x * 5, ty: dir.y * 5, rotateDeg: sign * 0.5 } as DriftParams,
    },
  ];
}

/** Photometric (must-pass) grades. */
const PHOTO_GRADES: { grade: string; apply: (img: GrayImage) => GrayImage }[] = [
  { grade: 'pass:brighter', apply: (img) => brightness(img, 0.08) },
  { grade: 'pass:darker', apply: (img) => brightness(img, -0.08) },
  { grade: 'pass:contrast', apply: (img) => contrast(img, 1.15) },
  { grade: 'pass:gamma', apply: (img) => gamma(img, 1.2) },
];

/**
 * The border crop every image receives, in pixels: the worst displacement any
 * grade inflicts, padded up. One number for the whole benchmark so pass and
 * flag cases are cropped identically (see cropBorder's rationale).
 */
export function requiredMargin(width: number, height: number): number {
  let max = 0;
  for (const { params } of driftGrades(0)) {
    max = Math.max(max, cornerDisplacement(params, width, height));
  }
  return Math.ceil(max) + 2;
}

/**
 * Which images a case is scored against. `siblings`: the archive's other
 * images. `first`: `images[0]` alone, the reference the UI uses (#118); image 0
 * then contributes no cases of its own.
 */
export type RefMode = 'siblings' | 'first';

/**
 * Expand decoded archives into benchmark cases.
 *
 * For each image i of an archive: the refs are the archive's OTHER images —
 * the same scene, legitimately changed (rolling stock moved between frames).
 * Archives with fewer than two images contribute nothing: with no sibling
 * reference there is nothing to disagree with.
 *
 * The "flag:combo" grade layers a brightness shift on its warp — drift in the
 * wild arrives between sessions, when lighting has changed too.
 */
export function buildCases(
  archives: DecodedArchive[],
  { refs: mode = 'siblings' }: { refs?: RefMode } = {},
): BenchCase[] {
  const cases: BenchCase[] = [];
  for (const archive of archives) {
    if (archive.images.length < 2) continue;
    const { width, height } = archive.images[0].image;
    const margin = requiredMargin(width, height);
    const cropped = archive.images.map(({ filename, image }) => ({
      filename,
      image: cropBorder(image, margin),
    }));
    for (let i = mode === 'first' ? 1 : 0; i < archive.images.length; i++) {
      const { filename, image } = archive.images[i];
      const refs =
        mode === 'first' ? [cropped[0].image] : cropped.filter((_, j) => j !== i).map((r) => r.image);
      const push = (grade: string, expect: 'pass' | 'flag', frame: GrayImage) =>
        cases.push({ archive: archive.name, source: filename, grade, expect, frame, refs });

      push('pass:sibling', 'pass', cropBorder(cloneImage(image), margin));
      for (const { grade, apply } of PHOTO_GRADES) {
        push(grade, 'pass', cropBorder(apply(image), margin));
      }
      for (const { grade, params } of driftGrades(i)) {
        let warped = warpImage(image, params);
        if (grade === 'flag:combo') warped = brightness(warped, 0.06);
        push(grade, 'flag', cropBorder(warped, margin));
      }
    }
  }
  return cases;
}
