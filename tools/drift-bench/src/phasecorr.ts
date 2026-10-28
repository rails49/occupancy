import { createDriftCheck } from '@occupancy/drift';
import type { GrayPlane } from '@occupancy/drift';
import { GrayImage } from './image.ts';
import { Scorer } from './harness.ts';

/**
 * The shipped drift check, as a benchmark scorer.
 *
 * **This is an adapter and nothing else.** No arithmetic lives here on purpose:
 * the benchmark's job is to validate the code the UI runs, so a scorer holding
 * its own copy of the algorithm — which is what `src/prototype/` was, on the
 * throwaway `drift-prototype` branch — would grade a copy and pass while the
 * shipped path failed. Every number this reports comes out of
 * `createDriftCheck`, through the same published interface `rr-live-view`
 * calls.
 *
 * `GrayImage` and `GrayPlane` are the same shape by coincidence rather than by
 * dependency: the benchmark predates the package (#91 before #97) and keeps its
 * own type so `src/warp.ts` and `src/photometric.ts` owe nothing to a library.
 * The pass-through below is where that coincidence is stated out loud, so a
 * future divergence lands here as a type error rather than as a wrong score.
 */
function asPlane(img: GrayImage): GrayPlane {
  return { width: img.width, height: img.height, data: img.data };
}

/**
 * Block-wise phase correlation — `@occupancy/drift`, scored per case.
 *
 * A check is built per case rather than once, because a case's references are
 * its own archive's other images and change from case to case. That makes this
 * pay the per-reference FFT setup on every case, which the UI does once per
 * session; the benchmark measures separation, not throughput, so the trade is
 * the right way round.
 *
 * The score is in the reference images' pixels, which the benchmark has already
 * normalized to `WORKING_WIDTH` — so it reads in the same units the grades are
 * calibrated in, and a `flag:translate-5px` case scores about 5.
 */
export const phasecorrScorer: Scorer = {
  name: 'phasecorr',
  async score(frame: GrayImage, refs: GrayImage[]): Promise<number> {
    const check = await createDriftCheck(refs.map(asPlane));
    const { displacementPx } = await check.check(asPlane(frame));
    return displacementPx;
  },
};
