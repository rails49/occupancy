import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import {
  R49Archive,
  R49Error,
  RULES,
  FORMAT_RULES,
  CORPUS_RULES,
  type FormatRule,
  type ManifestData,
} from '../src/index.ts';

// Every refusal names the rule it broke (#182). These tests assert the rule id
// and never the message: the id is the contract the conformance cases and the
// Python reader share, and the wording is free to change for the person who
// reads it.

const A_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 4,
    layout: { scale: 'HO', calibration: { points: [] }, sensors: [] },
    camera: { resolution: { width: 1920, height: 1080 } },
    images: [],
    ...overrides,
  };
}

const car = (over: Record<string, unknown> = {}) => ({
  id: 'car-1',
  class: 'stock',
  p0: { x: 10, y: 20 },
  p1: { x: 110, y: 25 },
  provenance: 'human',
  ...over,
});

/** The rule `setManifest` names when it refuses `data`. */
function ruleOf(data: unknown): FormatRule {
  try {
    new R49Archive().setManifest(data as ManifestData);
  } catch (err) {
    expect(err).toBeInstanceOf(R49Error);
    return (err as R49Error).rule;
  }
  throw new Error('expected the manifest to be refused, but it was accepted');
}

/** The rule `load` names when it refuses these bytes. */
async function loadRuleOf(bytes: Uint8Array): Promise<FormatRule> {
  try {
    await R49Archive.load(bytes);
  } catch (err) {
    expect(err).toBeInstanceOf(R49Error);
    return (err as R49Error).rule;
  }
  throw new Error('expected the archive to be refused, but it loaded');
}

/** A zip holding `manifest.json` with exactly this text, plus optional entries. */
async function zipWith(manifestText: string | null, entries: string[] = []): Promise<Uint8Array> {
  const zip = new JSZip();
  if (manifestText !== null) zip.file('manifest.json', manifestText);
  for (const entry of entries) zip.file(entry, A_JPEG);
  return await zip.generateAsync({ type: 'uint8array' });
}

/** A zip holding `manifest.json` with exactly these bytes. */
async function zipWithBytes(manifestBytes: Uint8Array): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('manifest.json', manifestBytes);
  return await zip.generateAsync({ type: 'uint8array' });
}

describe('the rule set', () => {
  it('is closed: every rule is either a format rule or a corpus rule, never both', () => {
    expect([...RULES].sort()).toEqual([...FORMAT_RULES, ...CORPUS_RULES].sort());
    expect(new Set(RULES).size).toBe(RULES.length);
  });
});

describe('load names the rule it refused on', () => {
  it('archive/empty for zero bytes', async () => {
    expect(await loadRuleOf(new Uint8Array())).toBe('archive/empty');
  });

  it('archive/not-zip for bytes that are not a zip', async () => {
    expect(await loadRuleOf(new TextEncoder().encode('not a zip at all'))).toBe('archive/not-zip');
  });

  it('archive/no-manifest for a zip without manifest.json', async () => {
    expect(await loadRuleOf(await zipWith(null, ['a.jpg']))).toBe('archive/no-manifest');
  });

  it('manifest/not-json for a manifest.json that does not parse', async () => {
    expect(await loadRuleOf(await zipWith('{ version: 4'))).toBe('manifest/not-json');
  });

  it('manifest/not-json for a manifest.json that is not UTF-8 (#191)', async () => {
    // A lossy decode turns the 0xff into U+FFFD and loads an altered name.
    const named = manifest({
      layout: { name: 'Yard~', scale: 'HO', calibration: { points: [] }, sensors: [] },
    });
    const text = new TextEncoder().encode(JSON.stringify(named));
    const bytes = text.map((b) => (b === 0x7e ? 0xff : b));
    expect(await loadRuleOf(await zipWithBytes(bytes))).toBe('manifest/not-json');
  });

  it('manifest/not-json for a manifest.json with a leading byte-order mark (#191)', async () => {
    const text = new TextEncoder().encode(JSON.stringify(manifest()));
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...text]);
    expect(await loadRuleOf(await zipWithBytes(bytes))).toBe('manifest/not-json');
  });

  it('loads the same manifest without the byte-order mark', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(manifest()));
    await expect(R49Archive.load(await zipWithBytes(bytes))).resolves.toBeInstanceOf(R49Archive);
  });

  it('manifest/version for a v3 archive', async () => {
    const v3 = JSON.stringify({ version: 3, layout: { scale: 'N' }, images: [] });
    expect(await loadRuleOf(await zipWith(v3))).toBe('manifest/version');
  });

  it('manifest/schema for a number that is not finite (#190)', async () => {
    // A number in the format is a finite JSON number. `JSON.parse` reads 1e400
    // as Infinity, which would make the fit NaN and save back as `null`. The
    // text is spliced in because `JSON.stringify` cannot write it.
    const at = (field: string, overrides: Record<string, unknown>) =>
      JSON.stringify(manifest(overrides)).replace(`"${field}"`, '1e400');
    const cases = [
      at('H', {
        layout: { scale: 'HO', calibration: { points: [], camera_height_mm: 'H' }, sensors: [] },
      }),
      at('H', {
        layout: { scale: 'HO', calibration: { points: [], reference_height_mm: 'H' }, sensors: [] },
      }),
      at('H', {
        layout: {
          scale: 'HO',
          calibration: { points: [{ px: { x: 1, y: 2 }, world: { x: 0, y: 0, z: 'H' } }] },
          sensors: [],
        },
      }),
      at('H', {
        layout: { scale: 'HO', calibration: { points: [] }, sensors: [{ id: 's', x: 'H', y: 1 }] },
      }),
      at('H', { images: [{ filename: 'a.jpg', labels: [car({ p1: { x: 'H', y: 25 } })] }] }),
      at('H', { camera: { resolution: { width: 'H', height: 1080 } } }),
    ];
    for (const text of cases) {
      expect(text).toContain('1e400');
      const entries = text.includes('a.jpg') ? ['a.jpg'] : [];
      expect(await loadRuleOf(await zipWith(text, entries))).toBe('manifest/schema');
    }
    // Negative infinity is the same refusal.
    expect(
      ruleOf(
        manifest({
          layout: { scale: 'HO', calibration: { points: [], reference_height_mm: -Infinity }, sensors: [] },
        })
      )
    ).toBe('manifest/schema');
  });

  it('carries the inner rule through the load wrapper for a schema failure', async () => {
    const bad = JSON.stringify(manifest({ vendor_extra: 1 }));
    expect(await loadRuleOf(await zipWith(bad))).toBe('manifest/unknown-key');
  });
});

describe('setManifest names the rule it refused on', () => {
  it('manifest/version for a missing or wrong version', () => {
    expect(ruleOf(manifest({ version: 3 }))).toBe('manifest/version');
    expect(ruleOf({})).toBe('manifest/version');
    expect(ruleOf(null)).toBe('manifest/version');
  });

  it('manifest/unknown-key for a key the format does not define, at any depth', () => {
    expect(ruleOf(manifest({ vendor_extra: 1 }))).toBe('manifest/unknown-key');
    expect(
      ruleOf(manifest({ images: [{ filename: 'a.jpg', labels: [car({ colour: 'red' })] }] }))
    ).toBe('manifest/unknown-key');
  });

  it('manifest/duplicate-id for duplicate label ids and duplicate sensor ids', () => {
    expect(
      ruleOf(manifest({ images: [{ filename: 'a.jpg', labels: [car({ id: 'x' }), car({ id: 'x' })] }] }))
    ).toBe('manifest/duplicate-id');
    expect(
      ruleOf(
        manifest({
          layout: {
            scale: 'N',
            calibration: { points: [] },
            sensors: [{ id: 'x', x: 1, y: 1 }, { id: 'x', x: 2, y: 2 }],
          },
        })
      )
    ).toBe('manifest/duplicate-id');
  });

  it('manifest/provenance for every way a label can misstate its provenance', () => {
    const labelled = (label: Record<string, unknown>) =>
      manifest({ images: [{ filename: 'a.jpg', labels: [label] }] });
    const { provenance: _omitted, ...withoutProvenance } = car();

    expect(ruleOf(labelled(car({ proposed_by: 'v1' })))).toBe('manifest/provenance');
    expect(ruleOf(labelled(car({ provenance: 'proposed' })))).toBe('manifest/provenance');
    expect(ruleOf(labelled(car({ provenance: 'corrected' })))).toBe('manifest/provenance');
    expect(ruleOf(labelled(car({ provenance: 'guessed' })))).toBe('manifest/provenance');
    expect(ruleOf(labelled(withoutProvenance))).toBe('manifest/provenance');
  });

  it('manifest/schema for any other shape the format does not allow', () => {
    expect(ruleOf(manifest({ layout: { calibration: { points: [] }, sensors: [] } }))).toBe(
      'manifest/schema'
    );
    expect(ruleOf(manifest({ id: '' }))).toBe('manifest/schema');
    expect(
      ruleOf(
        manifest({ layout: { scale: 'HO', calibration: { points: [], camera_height_mm: 0 }, sensors: [] } })
      )
    ).toBe('manifest/schema');
  });

  it('names the unknown key ahead of any other failure in the same manifest', () => {
    // The reworded "newer build" message is the one a user can act on, so it
    // wins when a stale reader meets a file that is also wrong elsewhere.
    expect(ruleOf(manifest({ vendor_extra: 1, id: '' }))).toBe('manifest/unknown-key');
  });
});

describe('imageMismatches names the rule each disagreement breaks', () => {
  async function archiveOf(declared: string[], present: string[]): Promise<R49Archive> {
    const images = declared.map(filename => ({ filename, labeled_complete: false, labels: [] }));
    return await R49Archive.load(await zipWith(JSON.stringify(manifest({ images })), present));
  }

  it('is empty when the manifest and the zip name the same images', async () => {
    expect((await archiveOf(['a.jpg'], ['a.jpg'])).imageMismatches()).toEqual([]);
  });

  it('images/missing for a manifest entry with no file, images/orphan for a file with no entry', async () => {
    const archive = await archiveOf(['a.jpg', 'b.jpg'], ['a.jpg', 'c.jpg']);
    expect(archive.imageMismatches()).toEqual([
      { rule: 'images/missing', filename: 'b.jpg' },
      { rule: 'images/orphan', filename: 'c.jpg' },
    ]);
  });
});
