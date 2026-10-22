// @vitest-environment node
// Node, not jsdom: two of these tests run a real `vite build`, and esbuild
// refuses jsdom's `TextEncoder`.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DETECTOR_MODEL_FILE, DETECTOR_MODEL_URL } from '../modelAssets.js';
import { DETECTOR_MODEL_DEST } from '../modelCopy.js';

// Which model ships used to be two string literals in two files that run in
// different worlds — a build-time copy target and a run-time fetch — and the
// gap between them is invisible to both the typechecker and the build. The
// filename is the detector package's now (ADR 0019): the build copies what the
// package's `./model` entry resolves to, and the browser fetches the package's
// `DETECTOR_MODEL_FILE`. These tests hold the UI to naming neither.

const repoRoot = path.resolve(__dirname, '../..');
const uiRoot = path.join(repoRoot, 'ui');
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

/** Where the detector package's `./model` entry points, read from its own manifest. */
const detectorPackage = path.join(repoRoot, 'lib/detector');
const modelEntry = path.join(
  detectorPackage,
  JSON.parse(fs.readFileSync(path.join(detectorPackage, 'package.json'), 'utf8')).exports['./model'],
);

/** A machine that has exported a model keeps it; these tests never overwrite or remove it. */
const realModel = fs.existsSync(modelEntry);

/** Load `vite.config.ts` afresh, so it resolves the model as the file system stands now. */
async function loadConfig() {
  vi.resetModules();
  return import('../vite.config.js');
}

/** Build the UI as `pnpm build` does, into a directory of its own. */
async function buildInto(outDir: string) {
  const { build } = await import('vite');
  const { config } = await loadConfig();
  await build({
    ...config,
    configFile: false,
    root: uiRoot,
    logLevel: 'silent',
    build: { ...config.build, outDir, emptyOutDir: true },
  });
}

describe('the shipped model', () => {
  it('is named by none of the UI files that copy, fetch or show it', () => {
    // A literal in any of these would typecheck, build, deploy, and 404 the
    // moment the camera came up if the package renamed its file.
    const views = fs
      .readdirSync(path.join(uiRoot, 'src'))
      .filter(f => f.startsWith('rr-') && f.endsWith('.ts'))
      .map(f => `ui/src/${f}`);
    for (const file of ['ui/modelAssets.ts', 'ui/modelCopy.ts', 'ui/vite.config.ts', 'ui/src/detectorSession.ts', ...views]) {
      expect(read(file), file).not.toContain(DETECTOR_MODEL_FILE);
    }
  });

  it('is fetched by the loader through the assets module', () => {
    // Without this import a hand-written URL in another directory would pass
    // the filename check above and 404 at run time.
    expect(read('ui/src/detectorSession.ts')).toMatch(/from '\.\.?\/modelAssets\.js'/);
  });

  it('is fetched from the directory it is copied into, under the app base', () => {
    expect(DETECTOR_MODEL_URL).toBe(`/${DETECTOR_MODEL_DEST}/${DETECTOR_MODEL_FILE}`);
  });

  it('is the only model the bundle carries', () => {
    // The CNN is retained and retrainable but no longer loaded (#7, #85), so
    // shipping it would be 11 MB nothing fetches — and a live view that could
    // still reach it would be a second answer to a question SPEC gives one
    // answer to.
    expect(read('ui/vite.config.ts')).not.toContain('classifier/resnet/models');
    expect(read('ui/src/rr-live-view.ts')).not.toContain('@occupancy/classifier');
  });

  describe.skipIf(realModel)('with no local model', () => {
    it('has no copy target', async () => {
      // `version.txt` is tracked, so the directory is there on a fresh clone,
      // and a copy conditioned on the directory failed every build without a
      // model.
      expect(fs.existsSync(path.join(path.dirname(modelEntry), 'version.txt'))).toBe(true);
      const { detectorCopyTarget } = await loadConfig();
      expect(detectorCopyTarget()).toBeNull();
    });

    it('still builds, and the bundle has no models directory', async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-build-'));
      try {
        await buildInto(outDir);
        expect(fs.existsSync(path.join(outDir, 'index.html'))).toBe(true);
        expect(fs.existsSync(path.join(outDir, DETECTOR_MODEL_DEST))).toBe(false);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 120_000);
  });

  describe("with a model at the package's entry", () => {
    // A stand-in, unless this machine has a real one. It is written through
    // the package's entry, not to a path this test knows on its own, so it
    // lands wherever the package says the model lives.
    const standIn = 'stand-in model, not a detector';

    beforeAll(() => {
      if (!realModel) fs.writeFileSync(modelEntry, standIn);
    });
    afterAll(() => {
      if (!realModel) fs.rmSync(modelEntry, { force: true });
    });

    it('copies from what the package entry resolves to, relative to ui/', async () => {
      const { detectorCopyTarget } = await loadConfig();
      const target = detectorCopyTarget();

      expect(target).not.toBeNull();
      expect(target!.dest).toBe(DETECTOR_MODEL_DEST);
      // Relative, because that is what vite-plugin-static-copy resolves
      // against — an absolute path would copy on this machine and nowhere else.
      expect(path.isAbsolute(target!.src)).toBe(false);
      expect(fs.realpathSync(path.resolve(uiRoot, target!.src))).toBe(fs.realpathSync(modelEntry));
    });

    it('is copied by the build to the URL the live view fetches', async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-build-'));
      try {
        await buildInto(outDir);
        const shipped = path.join(outDir, DETECTOR_MODEL_URL);
        expect(fs.readFileSync(shipped)).toEqual(fs.readFileSync(modelEntry));
        // Copied, not linked: the deploy guard refuses a symlink.
        expect(fs.lstatSync(shipped).isSymbolicLink()).toBe(false);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
