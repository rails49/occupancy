import { fft2 } from './fft.ts';
import type { GrayPlane } from './types.ts';

/**
 * Block-wise phase correlation: the measurement itself.
 *
 * The whole idea in three sentences. Whiten the cross-power spectrum of two
 * blocks and its inverse transform is a delta at the lag between them — so the
 * *phase* carries the shift and the discarded magnitude carries the lighting,
 * which is why a room whose lamps changed scores zero here and broke both pixel
 * baselines in the benchmark (#91, #92). Do it per block rather than per frame,
 * and the statistic separates the two things that move: a displaced **camera**
 * shifts every block coherently, a displaced **car** shifts only the blocks it
 * occupies, so the median over blocks reads the camera and ignores the traffic.
 * Take the minimum over references, because agreeing with any archive image is
 * agreement.
 *
 * Everything here is internal — `driftCheck.ts` is the only caller, and the
 * package's interface is `createDriftCheck`.
 */

/**
 * The block side the benchmark validated, in working-resolution pixels.
 *
 * 128 is a power of two (the FFT's only constraint) and large enough that a
 * 486-px-tall working frame still tiles three deep. Smaller blocks would buy
 * more samples for the median and lose the low frequencies that make a
 * texture-poor block readable at all.
 */
export const BLOCK_SIZE = 128;

/**
 * The smallest block worth correlating.
 *
 * A floor rather than a preference: {@link chooseBlockSize} steps down only for
 * inputs too small for {@link BLOCK_SIZE}, which is not a case the benchmark
 * covers, and below 32 px a block holds too little structure for the peak to
 * mean anything.
 */
export const MIN_BLOCK_SIZE = 32;

/**
 * The largest validated block size that fits, as a power of two.
 *
 * @throws if the plane is too small to hold even a {@link MIN_BLOCK_SIZE} block
 */
export function chooseBlockSize(width: number, height: number): number {
  const fits = Math.min(width, height);
  let size = BLOCK_SIZE;
  while (size > fits) size >>= 1;
  if (size < MIN_BLOCK_SIZE) {
    throw new Error(
      `drift: a ${width}x${height} plane is too small to correlate — ` +
        `blocks are at least ${MIN_BLOCK_SIZE}px square`,
    );
  }
  return size;
}

/** Where the blocks sit on a plane. Identical for frame and reference. */
export interface BlockGrid {
  readonly size: number;
  readonly cols: number;
  readonly rows: number;
  /** Left edge of column 0 — the leftover width, halved. */
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Tile a plane with whole blocks, centred.
 *
 * The leftover strip is split between the two edges rather than left at the
 * right and bottom: a layout photo is framed on its subject, so a bias toward
 * one corner would drop blocks from the part of the scene most likely to hold
 * the track.
 */
export function blockGrid(width: number, height: number): BlockGrid {
  const size = chooseBlockSize(width, height);
  const cols = Math.floor(width / size);
  const rows = Math.floor(height / size);
  return {
    size,
    cols,
    rows,
    offsetX: Math.floor((width - cols * size) / 2),
    offsetY: Math.floor((height - rows * size) / 2),
  };
}

const hannWindows = new Map<number, Float32Array>();

/**
 * A 2D Hann window, cached per size.
 *
 * A block is a rectangular cut out of a larger scene, and the FFT treats its
 * edges as wrapping — so without a taper the discontinuity across the seam is
 * itself a strong feature, and it sits at lag zero regardless of how far the
 * camera moved. Tapering to zero at the border is what stops that artefact
 * outvoting the real peak.
 */
function hannWindow(size: number): Float32Array {
  const cached = hannWindows.get(size);
  if (cached) return cached;
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  const win = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) win[y * size + x] = w[y] * w[x];
  }
  hannWindows.set(size, win);
  return win;
}

/**
 * Every block of one plane, transformed — the half of the work that depends on
 * one image alone.
 *
 * Held as two flat `Float32Array`s rather than an array of per-block objects:
 * one allocation instead of `2 * count`, and half the bytes of the `Float64`
 * the transform runs in. A live session holds one of these per reference for
 * its whole life, so the halving is a browser-memory decision, not a
 * micro-optimisation. Precision is not at stake — the spectra are an input to a
 * peak search, not an accumulator.
 */
export interface BlockSpectra {
  readonly grid: BlockGrid;
  /** `cols * rows * size * size`, block-major then row-major. */
  readonly re: Float32Array;
  readonly im: Float32Array;
}

/** Windowed per-block FFT of a plane, on the grid `grid` names. */
export function blockSpectra(plane: GrayPlane, grid: BlockGrid): BlockSpectra {
  const { size, cols, rows, offsetX, offsetY } = grid;
  const area = size * size;
  const count = cols * rows;
  const win = hannWindow(size);
  const re = new Float32Array(count * area);
  const im = new Float32Array(count * area);
  const scratchRe = new Float64Array(area);
  const scratchIm = new Float64Array(area);

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const originX = offsetX + bx * size;
      const originY = offsetY + by * size;
      for (let y = 0; y < size; y++) {
        const src = (originY + y) * plane.width + originX;
        const dst = y * size;
        for (let x = 0; x < size; x++) {
          scratchRe[dst + x] = plane.data[src + x] * win[dst + x];
        }
      }
      scratchIm.fill(0);
      fft2(scratchRe, scratchIm, size, false);
      const base = (by * cols + bx) * area;
      re.set(scratchRe, base);
      im.set(scratchIm, base);
    }
  }

  return { grid, re, im };
}

/** Reusable buffers for one correlation, sized to the grid's block. */
export interface CorrelationScratch {
  readonly re: Float64Array;
  readonly im: Float64Array;
}

export function makeScratch(grid: BlockGrid): CorrelationScratch {
  const area = grid.size * grid.size;
  return { re: new Float64Array(area), im: new Float64Array(area) };
}

/**
 * The apparent shift of one block, in working-resolution pixels.
 *
 * The peak is taken at **integer lag** — no sub-pixel interpolation — and that
 * is a decision, not an omission. It is what makes a frame that did not move
 * score *exactly* zero rather than a small non-zero number: the benchmark's 230
 * legitimate cases all read 0.00000 (#92), and a threshold placed under a hard
 * zero is a different kind of claim from one placed under a noise floor. The
 * cost is a quantum of one working pixel — well inside the tolerance
 * the UI's `MAX_DRIFT_TRACK_FRACTION` sets, which is a quarter of a track width
 * and so tens of times larger at any realistic DPT.
 */
function blockShift(
  frame: BlockSpectra,
  ref: BlockSpectra,
  block: number,
  scratch: CorrelationScratch,
): number {
  const size = frame.grid.size;
  const area = size * size;
  const base = block * area;
  const { re, im } = scratch;

  // Whitened cross-power spectrum: F · conj(R), then normalised to unit
  // magnitude. Dropping the magnitude is dropping the lighting — it is the one
  // step that makes this robust to the exposure and gamma changes a pixel
  // difference cannot survive.
  for (let i = 0; i < area; i++) {
    const fr = frame.re[base + i];
    const fi = frame.im[base + i];
    const rr = ref.re[base + i];
    const ri = ref.im[base + i];
    const cr = fr * rr + fi * ri;
    const ci = fi * rr - fr * ri;
    const mag = Math.hypot(cr, ci);
    // A bin with no energy in one of the two blocks carries no phase to read.
    // Zeroing it abstains; dividing by ~0 would invent a unit-magnitude
    // direction out of rounding error.
    if (mag < 1e-12) {
      re[i] = 0;
      im[i] = 0;
    } else {
      re[i] = cr / mag;
      im[i] = ci / mag;
    }
  }

  fft2(re, im, size, true);

  let peak = -Infinity;
  let peakIndex = 0;
  for (let i = 0; i < area; i++) {
    if (re[i] > peak) {
      peak = re[i];
      peakIndex = i;
    }
  }

  // The transform's output wraps, so a lag past the halfway point is a negative
  // one — a block that moved two pixels left, not size-2 pixels right.
  const u = peakIndex % size;
  const v = (peakIndex - u) / size;
  const dx = u > size / 2 ? u - size : u;
  const dy = v > size / 2 ? v - size : v;
  return Math.hypot(dx, dy);
}

/** Median of an array, sorted in place. */
function median(values: Float64Array): number {
  values.sort();
  const mid = values.length >> 1;
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Median block displacement between a frame and one reference, in
 * working-resolution pixels.
 */
export function medianShift(
  frame: BlockSpectra,
  ref: BlockSpectra,
  scratch: CorrelationScratch,
  shifts: Float64Array,
): number {
  for (let block = 0; block < shifts.length; block++) {
    shifts[block] = blockShift(frame, ref, block, scratch);
  }
  return median(shifts);
}
