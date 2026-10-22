import { describe, it, expect, vi } from 'vitest';
import { DETECTOR_CONFIDENCE_THRESHOLD, MIN_DPT as CONFIG_MIN_DPT } from '@occupancy/config';

// Any ONNX Runtime module the root entry point reached would run one of these
// factories. The editor imports `MIN_DPT` from here, and it must not pay for
// the session to get a number.
const ortLoaded = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('onnxruntime-web', () => {
  ortLoaded.names.push('onnxruntime-web');
  return {};
});
vi.mock('onnxruntime-web/wasm', () => {
  ortLoaded.names.push('onnxruntime-web/wasm');
  return {};
});
vi.mock('onnxruntime-common', () => {
  ortLoaded.names.push('onnxruntime-common');
  return {};
});

describe("the detector's thresholds", () => {
  it('are exported from the root entry point, which loads no ONNX Runtime', async () => {
    const root = await import('../src/index.ts');
    expect(root.MIN_DPT).toBe(20);
    expect(root.CONFIDENCE_THRESHOLD).toBe(0.25);
    expect(ortLoaded.names).toEqual([]);
  });

  it('keep the values config.yaml authors', async () => {
    // config.yaml still owns the numbers until the split (ADR 0019): the
    // exporter reads `confidence_threshold` from it in Python.
    const root = await import('../src/index.ts');
    expect(root.MIN_DPT).toBe(CONFIG_MIN_DPT);
    expect(root.CONFIDENCE_THRESHOLD).toBe(DETECTOR_CONFIDENCE_THRESHOLD);
  });
});
