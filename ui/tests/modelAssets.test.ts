import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  DETECTOR_MODEL_DIR,
  DETECTOR_MODEL_FILE,
  DETECTOR_MODEL_URL,
  detectorCopyTarget,
} from '../modelAssets.js';

// Which model ships used to be two string literals in two files that run in
// different worlds — a build-time copy target and a run-time fetch — and the
// gap between them is invisible to both the typechecker and the build. These
// tests are what makes `modelAssets.ts` the single place, by refusing to let
// either side name the file itself.

const repoRoot = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

describe('the shipped model', () => {
  it('is copied from where the export writes it', () => {
    expect(detectorCopyTarget).toEqual({
      src: `${DETECTOR_MODEL_DIR}/${DETECTOR_MODEL_FILE}`,
      dest: 'models',
    });
    // Relative to `ui/`, because that is what vite-plugin-static-copy resolves
    // against — an absolute path here would copy on this machine and nowhere
    // else.
    expect(DETECTOR_MODEL_DIR.startsWith('../')).toBe(true);
  });

  it('is copied only when the file exists, since its directory always does', () => {
    // `version.txt` is tracked, so the directory is there on a fresh clone, and
    // a copy conditioned on the directory failed every build without a model.
    expect(fs.existsSync(path.join(repoRoot, 'detector/models/version.txt'))).toBe(true);
    expect(read('ui/vite.config.ts')).toContain(
      'fs.existsSync(path.resolve(__dirname, detectorCopyTarget.src))'
    );
  });

  it('is fetched from the directory it is copied into, under the app base', () => {
    expect(DETECTOR_MODEL_URL).toBe(`/${detectorCopyTarget.dest}/${DETECTOR_MODEL_FILE}`);
  });

  it('is the quantized artifact, not the fp32 one', () => {
    // `detector.onnx` is 9.6 MiB and `.onnx` is not what onnxruntime-web loads
    // here; the INT8 `.ort` is 3.4 MiB. The ceiling is Cloudflare's 25 MiB, and
    // the ONNX/ORT distinction is what the format check is really for.
    expect(DETECTOR_MODEL_FILE).toMatch(/_int8\.ort$/);
  });

  it('is named by neither the config nor the loader — both import it', () => {
    // The whole point. A literal in either file would typecheck, build, deploy,
    // and 404 the moment the camera came up. The run-time side moved from the
    // live view to `detectorSession.ts` in #87, when a second view started
    // needing a session.
    for (const file of ['ui/vite.config.ts', 'ui/src/detectorSession.ts']) {
      const source = read(file);
      expect(source, file).toMatch(/from '\.\.?\/modelAssets\.js'/);
      expect(source, file).not.toContain(DETECTOR_MODEL_FILE);
    }
  });

  it('is named in no view at all — they go through the loader', () => {
    // The filename must not spread as views multiply. A view that fetched the
    // model itself would be a second run-time name for it, which is the exact
    // drift this module exists to prevent.
    const views = fs
      .readdirSync(path.join(repoRoot, 'ui/src'))
      .filter(f => f.startsWith('rr-') && f.endsWith('.ts'));
    for (const view of views) {
      expect(read(`ui/src/${view}`), view).not.toContain(DETECTOR_MODEL_FILE);
    }
  });

  it('is the only model the bundle carries', () => {
    // The CNN is retained and retrainable but no longer loaded (#7, #85), so
    // shipping it would be 11 MB nothing fetches — and a live view that could
    // still reach it would be a second answer to a question SPEC gives one
    // answer to.
    const config = read('ui/vite.config.ts');
    expect(config).not.toContain('classifier/resnet/models');
    expect(read('ui/src/rr-live-view.ts')).not.toContain('@occupancy/classifier');
  });
});
