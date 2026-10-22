import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DETECTOR_MODEL_FILE } from '../src/index.ts';

// The model is a file, not a module, so the package names it twice: once as
// the `./model` entry a build resolves to copy it, once as the constant a
// browser fetches it by. These tests are what keeps the two one name (ADR 0019).

const packageRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(packageRoot, '../..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));

describe("the detector package's model", () => {
  it('has an exports entry, naming the file the constant names', () => {
    const entry: unknown = manifest.exports['./model'];
    expect(typeof entry).toBe('string');
    expect(path.posix.basename(entry as string)).toBe(DETECTOR_MODEL_FILE);
  });

  it('is the quantized artifact, not the fp32 one', () => {
    // `detector.onnx` is 9.6 MiB and `.onnx` is not what onnxruntime-web loads
    // here; the INT8 `.ort` is 3.4 MiB, against Cloudflare's 25 MiB per file.
    expect(DETECTOR_MODEL_FILE).toMatch(/_int8\.ort$/);
  });

  it('sits where the exporter writes it', () => {
    // An `exports` target may not leave the package, and the exporter writes
    // to `detector/models/` until the split (ADR 0019). The entry reaches it
    // through the package's `models` link.
    const target = path.join(packageRoot, manifest.exports['./model']);
    expect(fs.realpathSync(path.dirname(target))).toBe(
      fs.realpathSync(path.join(repoRoot, 'detector/models')),
    );
  });
});
