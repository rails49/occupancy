// @vitest-environment node
// Node, not jsdom: two of these tests run a real `vite build`, and esbuild
// refuses jsdom's `TextEncoder`.
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { DETECTOR_MODEL_FILE, DETECTOR_MODEL_URL } from '../modelAssets.js';
import { DETECTOR_MODEL_DEST, DETECTOR_MODEL_ENTRY } from '../modelCopy.js';

// Which model ships used to be two string literals in two files that run in
// different worlds — a build-time copy target and a run-time fetch — and the
// gap between them is invisible to both the typechecker and the build. The
// filename is the detector package's now (ADR 0019): the build copies what the
// package's `./model` entry resolves to, and the browser fetches the package's
// `DETECTOR_MODEL_FILE`. These tests hold the UI to naming neither.

const repoRoot = path.resolve(__dirname, '../..');
const uiRoot = path.join(repoRoot, 'ui');
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

/**
 * The model the installed package holds, or null. The published package has
 * none until a measured model ships; a linked checkout may have one.
 */
const realModel = (() => {
  try {
    return createRequire(import.meta.url).resolve(DETECTOR_MODEL_ENTRY);
  } catch {
    return null;
  }
})();

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

  describe('resolving the model entry', () => {
    // A stand-in resolver, since the published package holds no model yet.
    const standIn = path.join(os.tmpdir(), DETECTOR_MODEL_FILE);
    const failing = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };

    it('copies from what the entry resolves to, relative to ui/', async () => {
      const { detectorCopyTarget } = await loadConfig();
      const target = detectorCopyTarget(() => standIn);

      expect(target).not.toBeNull();
      expect(target!.dest).toBe(DETECTOR_MODEL_DEST);
      // Relative, because that is what vite-plugin-static-copy resolves
      // against — an absolute path would copy on this machine and nowhere else.
      expect(path.isAbsolute(target!.src)).toBe(false);
      expect(path.resolve(uiRoot, target!.src)).toBe(standIn);
    });

    it('has no target when the package has no ./model entry, or no file behind it', async () => {
      const { detectorCopyTarget } = await loadConfig();
      expect(detectorCopyTarget(failing('ERR_PACKAGE_PATH_NOT_EXPORTED'))).toBeNull();
      expect(detectorCopyTarget(failing('MODULE_NOT_FOUND'))).toBeNull();
    });

    it('stops the build on any other failure', async () => {
      const { detectorCopyTarget } = await loadConfig();
      expect(() => detectorCopyTarget(failing('EACCES'))).toThrow('EACCES');
    });
  });

  describe.skipIf(!realModel)('with a model in the package', () => {
    it('is copied by the build to the URL the live view fetches', async () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-build-'));
      try {
        await buildInto(outDir);
        const shipped = path.join(outDir, DETECTOR_MODEL_URL);
        expect(fs.readFileSync(shipped)).toEqual(fs.readFileSync(realModel!));
        // Copied, not linked: the deploy guard refuses a symlink.
        expect(fs.lstatSync(shipped).isSymbolicLink()).toBe(false);
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 120_000);
  });
});
