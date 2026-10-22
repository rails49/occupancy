import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  CLOUDFLARE_MAX_FILE_BYTES,
  ORT_WASM_BINARY,
  ORT_WASM_GLUE,
  ortCopyTargets,
} from '../ortAssets.js';
import { DETECTOR_MODEL_URL } from '../modelAssets.js';

// The deployed site must be crossOriginIsolated for ORT to use more than one
// WASM thread (#15), and COEP: require-corp is only safe once every subresource
// is same-origin. That makes "which .wasm ships from origin" a deployment
// invariant rather than a build detail: the jsep build is 25.02 MiB, just over
// Cloudflare Pages' per-file ceiling, which is what pushed it onto a CDN in the
// first place. These tests pin the choice that lets it come home.

const require = createRequire(import.meta.url);
const ortDist = path.dirname(require.resolve('onnxruntime-web/ort-wasm-simd-threaded.wasm'));
const repoRoot = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

/** The installed `@rails49/detector`, as the UI resolves it. */
const detectorDir = fs.realpathSync(path.join(repoRoot, 'ui/node_modules/@rails49/detector'));

/** Every module that imports ORT. They must agree about all of this. */
const ORT_IMPORTERS = [
  path.join(detectorDir, 'dist/browser.js'),
  path.join(repoRoot, 'ui/src/detectorSession.ts'),
];

/** Every `ort-wasm-simd-threaded*.wasm` an ORT dist file names, following glue modules. */
function referencedWasm(entry: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>();
  if (seen.has(entry)) return found;
  seen.add(entry);
  const source = fs.readFileSync(path.join(ortDist, entry), 'utf8');
  for (const ref of source.match(/ort-wasm-simd-threaded[\w.]*\.(?:wasm|mjs)/g) ?? []) {
    if (ref.endsWith('.wasm')) found.add(ref);
    else for (const nested of referencedWasm(ref, seen)) found.add(nested);
  }
  return found;
}

describe('ORT wasm assets', () => {
  it('ships a binary under Cloudflare Pages\' per-file limit', () => {
    const { size } = fs.statSync(path.join(ortDist, ORT_WASM_BINARY));
    expect(size).toBeLessThan(CLOUDFLARE_MAX_FILE_BYTES);
  });

  it('copies the binary, its glue, and nothing else', () => {
    // Named, never globbed: `*.wasm` sweeps the jsep build back in and
    // `*.{mjs,js}` drags 44 MB of webgl/webgpu/node builds nothing can fetch.
    expect(ortCopyTargets).toEqual([
      { src: `node_modules/onnxruntime-web/dist/${ORT_WASM_BINARY}`, dest: 'ort' },
      { src: `node_modules/onnxruntime-web/dist/${ORT_WASM_GLUE}`, dest: 'ort' },
    ]);
    for (const file of [ORT_WASM_BINARY, ORT_WASM_GLUE]) {
      expect(fs.existsSync(path.join(ortDist, file)), file).toBe(true);
    }
  });

  it('copies the files of the runtime the UI installs, which the detector imports too', () => {
    // The copy targets are paths, not imports: nothing but this test ties the
    // WASM files served from `ort/` to the JavaScript Rollup bundles from the
    // detector's `onnxruntime-web/wasm` import. ORT checks neither against the
    // other, so a second version would fail at runtime, in the browser.
    const uiInstall = fs.realpathSync(path.join(repoRoot, 'ui', path.dirname(ortCopyTargets[0].src)));
    expect(uiInstall).toBe(fs.realpathSync(ortDist));
    const detectorRequire = createRequire(path.join(detectorDir, 'package.json'));
    const detectorDist = path.dirname(detectorRequire.resolve(`onnxruntime-web/${ORT_WASM_BINARY}`));
    expect(fs.realpathSync(detectorDist)).toBe(uiInstall);
  });

  it('lets the UI decide the runtime version, and the workspace resolves one', () => {
    // A peer dependency, so the detector package can never install a runtime
    // of its own beside the UI's (ADR 0019).
    const detector = JSON.parse(fs.readFileSync(path.join(detectorDir, 'package.json'), 'utf8'));
    expect(detector.peerDependencies).toHaveProperty('onnxruntime-web');
    expect(detector.dependencies ?? {}).not.toHaveProperty('onnxruntime-web');
    const versions = new Set(read('pnpm-lock.yaml').match(/^ {2}onnxruntime-web@[^:(]+/gm));
    expect([...versions]).toHaveLength(1);
  });

  it('names the glue ORT actually resolves against wasmPaths', () => {
    // ORT loads the glue from `wasmPaths` the same way it loads the binary, so
    // a copy target missing it 404s on a path no build step would flag.
    const source = fs.readFileSync(path.join(ortDist, 'ort.wasm.bundle.min.mjs'), 'utf8');
    expect(source).toContain(ORT_WASM_GLUE);
  });

  it('is the only wasm the WASM-EP entry point asks for', () => {
    // 'onnxruntime-web/wasm' resolves to ort.wasm.bundle.min.mjs under a
    // bundler; the plain `onnxruntime-web` entry would pull the oversized jsep
    // build instead. Checking every wasm-only variant keeps a condition change
    // from quietly swapping the answer.
    for (const entry of ['ort.wasm.bundle.min.mjs', 'ort.wasm.min.mjs', 'ort.wasm.min.js']) {
      expect([...referencedWasm(entry)], entry).toEqual([ORT_WASM_BINARY]);
    }
  });

  it('is reached through the WASM-EP entry point everywhere ORT is imported', () => {
    // Both files must name the same specifier: two specifiers are two module
    // instances, and the `ort.env.wasm` the live view configures would not be
    // the one the detector's session reads.
    for (const file of ORT_IMPORTERS) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source, file).toMatch(/from ['"]onnxruntime-web\/wasm['"]/);
      expect(source, file).not.toMatch(/from ['"]onnxruntime-web['"]/);
    }
  });

  it('is served from origin, at the path the copy targets write to', () => {
    // ORT otherwise resolves the binary from a `new URL(…, import.meta.url)`
    // copy Rollup emits beside the chunk, which `dropUnfetchableOrtWasm`
    // deletes — so this assignment is what makes deleting it safe, and it has
    // to name `ort/` under the configured base. A CDN would fail COEP anyway.
    // In `detectorSession.ts` since #87, not the live view: two views open a
    // session now, and one of them setting the path would leave the other
    // fetching a hashed filename that isn't there, depending on mount order.
    const source = read('ui/src/detectorSession.ts');
    expect(source).not.toMatch(/cdn\.jsdelivr\.net/);
    expect(source).toMatch(/ort\.env\.wasm\.wasmPaths\s*=\s*'\/ort\/'/);
    expect(ortCopyTargets.every(t => t.dest === 'ort')).toBe(true);
  });

  it('is configured in exactly one place, so mount order cannot decide it', () => {
    // The whole reason `detectorSession.ts` exists (#87). A second assignment
    // is not an error at runtime — it is the same value written twice until one
    // of them drifts, and then the symptom is a 404 in whichever view happened
    // to mount second.
    const assigners = ['ui/src/rr-live-view.ts', 'ui/src/rr-diagnostics-view.ts']
      .filter(f => fs.existsSync(path.join(repoRoot, f)))
      .filter(f => /ort\.env\.wasm\.wasmPaths\s*=/.test(read(f)));
    expect(assigners).toEqual([]);
  });

  it('is named identically by the deploy guard, which cannot import it', () => {
    // In `bin/check-deploy-dir.sh` since #122, where the presence check moved
    // when the deploy directory's guards were gathered into one runnable
    // script. Still a repeated literal, still for the same reason: a shell
    // script cannot import TypeScript.
    expect(read('bin/check-deploy-dir.sh')).toContain(ORT_WASM_BINARY);
  });

  it('refuses to load a model before something says where the runtime is', async () => {
    // The library has no correct default — it cannot know the app's base — and
    // the emitted fallback is gone, so an unset wasmPaths would 404 on a hashed
    // filename. Fail where the cause is legible instead.
    //
    // Asserted against the detector rather than the classifier because the
    // detector is what the live view loads: this is the shipped path, and the
    // guard is only worth anything on the path that runs.
    const ort = await import('onnxruntime-web/wasm');
    const { loadDetector } = await import('@rails49/detector/browser');
    const previous = ort.env.wasm.wasmPaths;
    ort.env.wasm.wasmPaths = undefined;
    try {
      await expect(loadDetector(DETECTOR_MODEL_URL)).rejects.toThrow(/wasmPaths/);
    } finally {
      ort.env.wasm.wasmPaths = previous;
    }
  });
});

describe('ui/public/_headers', () => {
  const headers = fs.readFileSync(path.join(repoRoot, 'ui/public/_headers'), 'utf8');

  it('cross-origin isolates the app', () => {
    const rule = headers.split(/\n(?=\S)/).find(block => block.startsWith('/*'));
    expect(rule).toBeDefined();
    expect(rule).toMatch(/^\s+Cross-Origin-Opener-Policy:\s*same-origin$/m);
    expect(rule).toMatch(/^\s+Cross-Origin-Embedder-Policy:\s*require-corp$/m);
  });

  it('isolates the whole origin, not a prefix under it', () => {
    // The app owns occupancy.rails49.org outright (rails49/control#47). While
    // it shared the apex with a landing page this had to be scoped to `/ui/*`,
    // because require-corp on `/*` blocked that page's cross-origin Google
    // Fonts. A rule that crept back under a prefix would silently un-isolate
    // whatever the app moved to — and losing isolation throws no error, it
    // just drops ORT to one thread.
    const prefixed = headers.split(/\n(?=\S)/).filter(block => /^\/\S+/.test(block) && !block.startsWith('/*'));
    expect(prefixed).toEqual([]);
  });
});
