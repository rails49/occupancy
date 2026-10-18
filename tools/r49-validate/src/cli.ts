import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { validate, type ArchiveInput } from './validate.ts';
import { checkGuidance, guidanceTable, REFERENCE_WIDTH_PX } from './guidance.ts';
import { handleOf } from './corpus.ts';
import type { ArchiveReport, Report } from './report.ts';

/**
 * The only impure module: reads files, writes streams, chooses an exit code.
 * Everything it decides with lives in `validate.ts`, `corpus.ts` and
 * `guidance.ts`, which are pure and therefore testable.
 *
 * **stdout is machine, stderr is human — always both, with no flag.** The
 * corpus workflow pipes stdout through `jq` to make its `::warning` annotations
 * and its job summary; a person running the same command reads stderr. One code
 * path serves both, so the rendering nobody tests cannot drift from the one
 * that matters.
 *
 * Exit codes:
 *
 * * **0** — no blocking errors. Warnings do not change this; that is what makes
 *   the bar soft rather than merely lenient.
 * * **1** — at least one archive carries a blocking error.
 * * **2** — the tool itself failed: bad arguments, an unreadable path, a bug.
 *   Distinct from 1 on purpose. A crash here must never read as "your archive
 *   is bad" to a contributor who did nothing wrong.
 */

const USAGE = `
r49-validate <path>...            validate submitted .r49 files
r49-validate guidance             print the capture-guidance table
r49-validate guidance --check <path>
                                  check a document's generated block against it

Options:
  --author <handle>   the pull request author, for the directory-ownership rule
  --check <path>      guidance only; verify instead of print. Exit 1 on drift.
  --width <px>        guidance only; reference frame width (default ${REFERENCE_WIDTH_PX})
`.trim();

/**
 * The archives already committed beside a submission, for the id-collision
 * check. Only the author's own directories are read, and a submitted path is
 * never returned as its own sibling.
 */
async function siblingsOf(paths: readonly string[]): Promise<ArchiveInput[]> {
  const submitted = new Set(paths);
  const directories = new Set(paths.filter(p => handleOf(p) !== null).map(p => dirname(p)));
  const siblings: ArchiveInput[] = [];

  for (const directory of directories) {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch {
      // A brand-new contributor directory does not exist until the merge.
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry);
      if (!entry.endsWith('.r49') || submitted.has(path)) continue;
      siblings.push({ path, bytes: await readFile(path) });
    }
  }

  return siblings;
}

/** One archive's findings, for a person. */
function humanLines(report: ArchiveReport): string[] {
  const lines: string[] = [];
  const facts =
    report.images === null
      ? 'did not load'
      : `${report.images} images, ${report.labels} labels, ` +
        `DPT ${report.dpt === null ? '—' : report.dpt.toFixed(1)}` +
        `${report.dptResidual === null ? '' : ` (residual ${report.dptResidual.toFixed(1)} px)`}`;

  lines.push(`${report.errors.length === 0 ? '✅' : '❌'} ${report.path} — ${facts}`);
  // Geometry on its own line, and only when there is something to say. A
  // maintainer triaging a submission wants "shot from 0.8 m over a 2 m layout"
  // at a glance; nothing here is thresholded, so it never changes the verdict.
  if (report.cameraHeightMM !== null) {
    const obliquity =
      report.obliquityDeg === null || report.widthInflation === null
        ? ''
        : `, worst obliquity ${report.obliquityDeg.toFixed(0)}° ` +
          `(cars up to ${report.widthInflation.toFixed(1)}× their nadir width)`;
    lines.push(
      `   camera  ${report.cameraHeightMM} mm above layout zero` +
        `${report.referenceHeightMM === null ? '' : `, railhead at ${report.referenceHeightMM} mm`}` +
        obliquity,
    );
  }
  for (const error of report.errors) lines.push(`   error   ${error.message}`);
  for (const warning of report.warnings) lines.push(`   warning ${warning.message}`);
  return lines;
}

function humanReport(report: Report): string {
  const lines = report.archives.flatMap(humanLines);
  const errors = report.archives.reduce((n, a) => n + a.errors.length, 0);
  const warnings = report.archives.reduce((n, a) => n + a.warnings.length, 0);
  lines.push(
    '',
    `${report.archives.length} archive(s): ${errors} blocking error(s), ${warnings} warning(s).`
  );
  return lines.join('\n');
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === 'guidance') {
    const { values } = parseArgs({
      args: [...argv.slice(1)],
      options: { width: { type: 'string' }, check: { type: 'string' } },
    });
    const width = values.width === undefined ? REFERENCE_WIDTH_PX : Number(values.width);
    if (!Number.isFinite(width) || width <= 0) {
      process.stderr.write(`--width must be a positive number, got ${values.width}\n`);
      return 2;
    }

    // `--check` reports on stderr like every other human-facing rendering here,
    // and writes nothing to stdout: no program reads it, and stdout
    // carrying the table would tempt a workflow into diffing it a second time.
    if (values.check !== undefined) {
      const { ok, message } = checkGuidance(await readFile(values.check, 'utf8'), width);
      process.stderr.write(`${values.check}: ${message}\n`);
      return ok ? 0 : 1;
    }

    process.stdout.write(guidanceTable(width) + '\n');
    return 0;
  }

  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { author: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    process.stderr.write(USAGE + '\n');
    return values.help ? 0 : 2;
  }

  const submitted: ArchiveInput[] = [];
  for (const path of positionals) {
    submitted.push({ path, bytes: await readFile(path) });
  }

  const report = await validate(submitted, {
    author: values.author ?? null,
    siblings: await siblingsOf(positionals),
  });

  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(humanReport(report) + '\n');
  return report.ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  err => {
    // Exit 2, never 1: this is the tool failing, not an archive being rejected.
    process.stderr.write(`r49-validate failed: ${err?.stack ?? err}\n`);
    process.exitCode = 2;
  }
);
