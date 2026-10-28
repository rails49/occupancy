import { describe, it, expect } from 'vitest';
import { createDriftCheck } from '../src/driftCheck.ts';
import { mapPlane, paintRect, renderScene } from './scene.ts';

/**
 * The check, through the published interface — the same path `tools/drift-bench`
 * and the UI take.
 *
 * Two claims are load-bearing and both are asserted exactly, not approximately.
 * A frame that did not move reads **0**, so the config threshold sits under a
 * hard zero rather than a noise floor; and a frame that moved reads the pixels
 * it moved, in the *reference's* frame, so the number is one DPT multiply from
 * millimetres.
 */

/** Two blocks square: enough for a median, small enough to stay fast. */
const W = 256;
const H = 256;

describe('createDriftCheck', () => {
  it('reads exactly zero for the reference itself', async () => {
    const ref = renderScene(W, H);
    const check = await createDriftCheck([ref]);
    const result = await check.check(ref);
    expect(result.displacementPx).toBe(0);
    expect(result.refIndex).toBe(0);
  });

  it('reads the displacement of a translated frame', async () => {
    const check = await createDriftCheck([renderScene(W, H)]);
    for (const [dx, dy, expected] of [
      [3, 0, 3],
      [0, -5, 5],
      [4, 3, 5],
      [-8, -6, 10],
    ]) {
      const result = await check.check(renderScene(W, H, dx, dy));
      expect(result.displacementPx).toBeCloseTo(expected, 6);
    }
  });

  it('reads zero through a lighting change', async () => {
    // The whole reason phase correlation was chosen over pixel differencing:
    // whitening discards the spectrum's magnitude, which is where exposure and
    // gamma live. `lighting.r49` is the fixture that broke both naive baselines
    // in the benchmark (#92).
    const ref = renderScene(W, H);
    const check = await createDriftCheck([ref]);
    for (const f of [
      (v: number) => v + 0.08,
      (v: number) => v - 0.08,
      (v: number) => (v - 0.5) * 1.15 + 0.5,
      (v: number) => Math.pow(v, 1.2),
    ]) {
      const result = await check.check(mapPlane(ref, f));
      expect(result.displacementPx).toBe(0);
    }
  });

  it('reads zero when rolling stock moved but the camera did not', async () => {
    // The median's job. One block of four disagrees, so the two middle values
    // are both zero — a moved car cannot outvote a still camera.
    const ref = paintRect(renderScene(W, H), 20, 20, 60, 30, 0.2);
    const frame = paintRect(renderScene(W, H), 20, 60, 60, 30, 0.2);
    const check = await createDriftCheck([ref]);
    expect((await check.check(frame)).displacementPx).toBe(0);
  });

  it('names the reference the frame agreed with', async () => {
    // A `min` over references, so agreeing with any archive image is agreement —
    // and `refIndex` says which.
    const refs = [renderScene(W, H, 0, 0), renderScene(W, H, 40, 0), renderScene(W, H, 0, 40)];
    const check = await createDriftCheck(refs);
    expect(check.refCount).toBe(3);
    for (let i = 0; i < refs.length; i++) {
      const result = await check.check(refs[i]);
      expect(result.displacementPx).toBe(0);
      expect(result.refIndex).toBe(i);
    }
  });

  it('reports in the reference frame, not the working resolution', async () => {
    // A 1920-wide reference is correlated at 960, so a 10 px displacement is
    // measured as 5 and reported as 10. This is the property that keeps
    // the tolerance a number about the archive's own geometry rather than about
    // an internal constant.
    const check = await createDriftCheck([renderScene(1920, 1080)]);
    const still = await check.check(renderScene(1920, 1080));
    expect(still.displacementPx).toBe(0);
    const moved = await check.check(renderScene(1920, 1080, 10, 0));
    expect(moved.displacementPx).toBeCloseTo(10, 6);
  });

  it('accepts a frame at a different resolution from the reference', async () => {
    // The live case: archive photos at one size, a camera stream at another.
    // Normalizing internally is what keeps both consumers from having to know.
    const check = await createDriftCheck([renderScene(512, 512)]);
    const half = renderScene(256, 256);
    // Rendered at half scale the scene is not the same picture, so this asserts
    // only that a resolution difference is handled rather than rejected.
    await expect(check.check(half)).resolves.toMatchObject({ refIndex: 0 });
  });

  it('refuses an empty reference set', async () => {
    await expect(createDriftCheck([])).rejects.toThrow(/no reference images/);
  });

  it('refuses a reference whose buffer disagrees with its dimensions', async () => {
    await expect(
      createDriftCheck([{ width: 64, height: 64, data: new Float32Array(100) }]),
    ).rejects.toThrow(/refs\[0\]/);
  });

  it('refuses a reference too small to correlate', async () => {
    await expect(createDriftCheck([renderScene(64, 16)])).rejects.toThrow(/at least 32px/);
  });

  it('refuses a malformed frame', async () => {
    const check = await createDriftCheck([renderScene(W, H)]);
    await expect(
      check.check({ width: 10, height: 10, data: new Float32Array(3) }),
    ).rejects.toThrow(/check: frame/);
  });
});
