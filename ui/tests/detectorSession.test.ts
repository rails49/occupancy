import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DETECTOR_MODEL_URL } from '../modelAssets.js';

// `tests/ortAssets.test.ts` pins this module as **source text** — that the
// `wasmPaths` assignment exists, that it names `/ort/`, and that no view
// writes one of its own. Source text is what that test can reach, because the
// link it guards is between a build-time copy target and a run-time fetch.
//
// This file asserts the other half: that running the module does what reading
// it suggests. The two are not the same check — an assignment behind a
// condition that never fires reads correctly and configures nothing.

const loadDetector = vi.fn(async (_source: string) => ({
  detect: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('@rails49/detector/browser', () => ({
  loadDetector: (source: string) => loadDetector(source),
}));

/**
 * A fresh module registry per test.
 *
 * `configured` is a module-global — "once per page, not once per session" is
 * the behaviour under test, and it is unobservable if every test shares one
 * instance of the module that already ran its setup.
 */
async function freshSession() {
  vi.resetModules();
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = undefined;
  const session = await import('../src/detectorSession.js');
  return { ort, ...session };
}

describe('detectorSession', () => {
  beforeEach(() => {
    loadDetector.mockClear();
    loadDetector.mockImplementation(async () => ({ detect: vi.fn(), dispose: vi.fn() }));
  });

  it('points the runtime at the copy this app serves before loading anything', async () => {
    // The library has no correct default of its own, and the emitted
    // fallback copy is dropped from the bundle — so an unconfigured runtime
    // 404s on a hashed filename with no error naming the cause.
    const { ort, openDetector } = await freshSession();
    expect(ort.env.wasm.wasmPaths).to.be.undefined;

    await openDetector();

    expect(ort.env.wasm.wasmPaths).to.equal('/ort/');
  });

  it('configures the runtime once per page, however many sessions are opened', async () => {
    // `ort.env` is module-global. Two views open sessions now, and the second
    // one re-running setup would be a second chance for the two to disagree.
    const { ort, openDetector } = await freshSession();

    await openDetector();
    ort.env.wasm.wasmPaths = '/somewhere/else/';
    await openDetector();

    expect(ort.env.wasm.wasmPaths).to.equal('/somewhere/else/');
    expect(loadDetector).toHaveBeenCalledTimes(2);
  });

  it('loads the model the bundle ships, named by the assets module', async () => {
    const { openDetector } = await freshSession();

    await openDetector();

    expect(loadDetector).toHaveBeenCalledWith(DETECTOR_MODEL_URL);
  });

  it('reports where a failed load was pointed', async () => {
    // The diagnostics view puts this in a fatal message, so it has to be the
    // URL actually fetched rather than a description of it.
    const { DETECTOR_SOURCE } = await freshSession();

    expect(DETECTOR_SOURCE).to.equal(DETECTOR_MODEL_URL);
  });

  it('rejects on a failed load rather than resolving an unloaded detector', async () => {
    // An unloaded detector is unrepresentable by design — `loadDetector` is a
    // factory for that reason. What a *view* does about a failure differs: the
    // live view keeps its loop and reports every sensor `unknown`, the
    // diagnostics view has nothing to report at all. Resolving null here would
    // take that choice away from both.
    const { openDetector } = await freshSession();
    loadDetector.mockRejectedValue(new Error('no such model'));

    await expect(openDetector()).rejects.toThrow('no such model');
  });

  it('warns when the page is not cross-origin isolated, since ORT will not', async () => {
    // Losing isolation costs ~1.5x and breaks nothing visibly: ORT silently
    // drops to a single WASM thread, with no error and no warning of its own,
    // and the only symptom is that everything is slower than the numbers
    // anyone measured. jsdom sets no COOP/COEP, so this is the default here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { openDetector } = await freshSession();

    await openDetector();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('crossOriginIsolated'));
    warn.mockRestore();
  });

  it('stays quiet when the page is isolated, so the warning stays worth reading', async () => {
    Object.defineProperty(self, 'crossOriginIsolated', { value: true, configurable: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { openDetector } = await freshSession();

      await openDetector();

      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      Object.defineProperty(self, 'crossOriginIsolated', { value: undefined, configurable: true });
    }
  });
});
