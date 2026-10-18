import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { loadArchives } from './load.ts';
import { buildCases, RefMode } from './cases.ts';
import { runBenchmark, formatReport } from './harness.ts';
import { BASELINE_SCORERS } from './baseline.ts';
import { phasecorrScorer } from './phasecorr.ts';

/**
 * Synthetic camera-drift benchmark over the rails49/r49 fixture archives.
 *
 *   pnpm --filter @occupancy/drift-bench bench
 *   pnpm --filter @occupancy/drift-bench bench -- --scorer zmad --json out.json
 *
 * The fixtures default to a sibling clone of rails49/r49; point --fixtures
 * anywhere else that holds .r49 archives.
 */

/**
 * Every scorer, with the shipped one first and as the default.
 *
 * The default is `phasecorr` — `@occupancy/drift` itself — because a bare run
 * of this benchmark should answer "does the check that ships still separate the
 * corpus?". The naive pixel baselines stay reachable by name: they are what
 * put a number on why structural comparison was needed (#91), and a table
 * without them loses the comparison that justifies the whole approach.
 */
const SCORERS = { [phasecorrScorer.name]: phasecorrScorer, ...BASELINE_SCORERS };

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const { values } = parseArgs({
  // pnpm forwards the `--` separator itself; parseArgs must not see it
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    fixtures: { type: 'string', default: join(repoRoot, '..', 'r49', 'fixtures') },
    scorer: { type: 'string', default: phasecorrScorer.name },
    archive: { type: 'string' },
    refs: { type: 'string', default: 'siblings' },
    json: { type: 'string' },
  },
});

const scorer = SCORERS[values.scorer!];
if (!scorer) {
  console.error(`unknown scorer "${values.scorer}" — built in: ${Object.keys(SCORERS).join(', ')}`);
  process.exit(1);
}

const REF_MODES: RefMode[] = ['siblings', 'first'];
const refs = values.refs as RefMode;
if (!REF_MODES.includes(refs)) {
  console.error(`unknown --refs "${values.refs}" — one of: ${REF_MODES.join(', ')}`);
  process.exit(1);
}

let archives;
try {
  archives = await loadArchives(values.fixtures!);
} catch (err) {
  console.error(String(err));
  console.error(`\nThe fixtures live in the rails49/r49 repo. Clone it beside this one:`);
  console.error(`  gh repo clone rails49/r49 "${join(repoRoot, '..', 'r49')}" -- --depth 1`);
  process.exit(1);
}
if (values.archive) {
  archives = archives.filter((a) => a.name.includes(values.archive!));
}

const cases = buildCases(archives, { refs });
console.error(
  `${archives.length} archives, ${archives.reduce((n, a) => n + a.images.length, 0)} images, ${cases.length} cases`,
);

const report = await runBenchmark(scorer, cases);
console.log(formatReport(report));

if (values.json) {
  await writeFile(values.json, JSON.stringify(report, null, 2));
  console.error(`\nwrote ${values.json}`);
}
