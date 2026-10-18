import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadArchives } from '../src/load.ts';

// A copy of rails49/r49's conformance/cases/format-v4/archive.r49.
const frozenFixtureDir = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('loadArchives', () => {
  it('decodes the frozen v4 fixture to normalized grayscale', async () => {
    const archives = await loadArchives(frozenFixtureDir, 64);
    const frozen = archives.find((a) => a.name === 'format-v4.r49');
    expect(frozen).toBeDefined();
    expect(frozen!.images).toHaveLength(1);
    const img = frozen!.images[0].image;
    expect(img.width).toBe(64);
    expect(img.data.length).toBe(img.width * img.height);
    for (const v of img.data) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('reports an empty directory loudly', async () => {
    await expect(loadArchives(dirname(fileURLToPath(import.meta.url)))).rejects.toThrow(/no \.r49/);
  });
});
