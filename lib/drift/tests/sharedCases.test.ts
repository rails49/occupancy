import { describe, it, expect } from 'vitest';
import { createDriftCheck } from '../src/driftCheck.ts';
import type { GrayPlane } from '../src/types.ts';
import shared from './fixtures/drift.json';

// The drift cases rails49/occupancy-service shares. Source and format: `fixtures/README.md`.

function sharedPlane(name: string): GrayPlane {
  const raw = Buffer.from((shared.images as Record<string, string>)[name], 'base64');
  const data = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) data[i] = raw[i] / 255;
  return { width: shared.width, height: shared.height, data };
}

describe('the shared drift cases', () => {
  for (const c of shared.cases) {
    it(c.name, async () => {
      const check = await createDriftCheck([sharedPlane(c.reference)]);
      const result = await check.check(sharedPlane(c.frame));
      expect(Math.abs(result.displacementPx - c.expected_px)).toBeLessThanOrEqual(1e-6);
    });
  }
});
