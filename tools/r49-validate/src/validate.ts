import { R49Archive, R49Error, getDPT, getDPTResidual, isKnownClass } from '@occupancy/r49';
import { MIN_DPT } from '@occupancy/config';
import { checkPath, handleOf, scopeOf } from './corpus.ts';
import { obliquityOf, pointsOffReferencePlane } from './geometry.ts';
import {
  isOk,
  type ArchiveReport,
  type BlockingFinding,
  type Finding,
  type Report,
} from './report.ts';

/**
 * What CI asserts about a corpus submission — issue #57's seven blocking
 * checks and three warnings, over archives already read into memory.
 *
 * Pure by construction: bytes in, report out, no filesystem and no process.
 * `cli.ts` does the reading and the exiting. That is what lets every check be
 * tested against a purpose-built archive rather than against a fixture tree
 * someone has to keep in sync.
 */

/** One archive to examine, with the repo-relative path it sits at. */
export interface ArchiveInput {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ValidateOptions {
  /**
   * The pull request author's handle. `null` (the default) skips only the
   * directory-ownership rule — a local run cannot know it, and refusing to run
   * without it would make the tool useless to the contributor it exists to help.
   */
  readonly author?: string | null;
  /**
   * Archives already in the corpus that share a contributor directory with
   * something submitted. Read for their ids alone, to catch check 6.
   *
   * Scoped to the author's own directory rather than the whole corpus: the only
   * realistic collision is a contributor who re-downloaded, saved, and *added* a
   * second file where they meant to replace one, and that happens inside their
   * own directory. Corpus-wide would mean opening every archive in the repo on
   * every pull request.
   */
  readonly siblings?: readonly ArchiveInput[];
}

/** The manifest fields a report quotes, once the archive has loaded. */
function facts(archive: R49Archive): Omit<ArchiveReport, 'path' | 'scope' | 'errors' | 'warnings'> {
  const manifest = archive.getManifest();
  const images = manifest.images;
  const obliquity = obliquityOf(manifest);
  return {
    id: manifest.id ?? null,
    dpt: getDPT(manifest),
    dptResidual: getDPTResidual(manifest),
    cameraHeightMM: manifest.layout.calibration.camera_height_mm ?? null,
    referenceHeightMM: manifest.layout.calibration.reference_height_mm ?? null,
    obliquityDeg: obliquity?.degrees ?? null,
    widthInflation: obliquity?.widthInflation ?? null,
    images: images.length,
    labels: images.reduce((n, img) => n + img.labels.length, 0),
    complete: images.filter(img => img.labeled_complete).length,
    incomplete: images.filter(img => !img.labeled_complete).length,
  };
}

/**
 * Check 2 — the manifest and the zip must name the same images, both ways.
 * Which ones disagree is `@occupancy/r49`'s rule; what to tell the contributor
 * is this tool's.
 */
function checkImages(archive: R49Archive): BlockingFinding[] {
  return archive.imageMismatches().map(({ rule, filename }) => ({
    code: rule,
    rule,
    message:
      rule === 'images/missing'
        ? `The manifest names ${filename}, but the archive contains no such file.`
        : `${filename} is in the archive but no manifest entry references it. ` +
          `An unreferenced image is weight the corpus carries in git forever.`,
  }));
}

/** Checks 3 and 4 — what a label may claim, and what it may be called. */
function checkLabels(archive: R49Archive): BlockingFinding[] {
  const findings: BlockingFinding[] = [];

  for (const image of archive.getManifest().images) {
    for (const label of image.labels) {
      if (label.provenance === 'proposed') {
        findings.push({
          code: 'labels/provenance',
          rule: 'labels/provenance',
          message:
            `${image.filename}: label ${label.id} is still "proposed" — untouched model output. ` +
            `Review it in the editor: accepting or adjusting a proposal records it as ` +
            `"corrected", which is accepted here. Training on unreviewed proposals is the one ` +
            `thing this corpus exists to prevent.`,
        });
      }
      if (!isKnownClass(label.class)) {
        findings.push({
          code: 'labels/class',
          rule: 'labels/class',
          message:
            `${image.filename}: label ${label.id} has class "${label.class}", which is not in ` +
            `the vocabulary (detector.vocabulary in rails49's config.yaml). If your rolling ` +
            `stock genuinely is not representable, please open an issue — the vocabulary is ` +
            `meant to grow.`,
        });
      }
    }
  }

  return findings;
}

/** The quality warnings. Signals for the maintainer; never blocking. */
function qualityWarnings(archive: R49Archive, f: ReturnType<typeof facts>): Finding[] {
  const warnings: Finding[] = [];

  // Deliberately *not* a warning: a missing camera height. It would fire on
  // every submission from day one, fixtures included, and a warning that always
  // fires devalues the ones that mean something (#139). The editor is where the
  // height is required; here it is a fact in the table. This narrower condition
  // is the one place the fit silently means something other than the
  // contributor intends.
  const offPlane = pointsOffReferencePlane(archive.getManifest());
  if (offPlane > 0) {
    warnings.push({
      code: 'calibration/off-reference-plane',
      message:
        `${offPlane} calibration point${offPlane === 1 ? ' sits' : 's sit'} off the plane DPT is ` +
        `measured on, and without a camera height ${offPlane === 1 ? 'it is' : 'they are'} ` +
        `excluded from the fit. Add layout.calibration.camera_height_mm so every point ` +
        `contributes, or move ${offPlane === 1 ? 'it' : 'them'} onto the reference plane.`,
    });
  }

  if (f.dpt === null) {
    warnings.push({
      code: 'calibration/unresolved',
      message:
        `Calibration does not resolve, so no DPT can be computed and no geometric claim ` +
        `about this archive can be checked. Add two calibration points at known, differing ` +
        `world coordinates in the editor.`,
    });
  } else if (f.dpt < MIN_DPT) {
    warnings.push({
      code: 'calibration/dpt',
      message:
        `DPT is ${f.dpt.toFixed(1)}, below the ${MIN_DPT} a car needs to be localised ` +
        `reliably. Move the camera closer or frame a shorter stretch of track.`,
    });
  }

  if ((f.incomplete ?? 0) > 0) {
    warnings.push({
      code: 'images/incomplete',
      message:
        `${f.incomplete} of ${f.images} images are not marked complete. Only a complete image ` +
        `can be trained on — its unlabeled areas are what teach the detector what background ` +
        `looks like.`,
    });
  }

  return warnings;
}

/** The format rule a load failure names, or a rethrow when it names none. */
function ruleOf(err: unknown): R49Error['rule'] {
  if (err instanceof R49Error) return err.rule;
  throw err;
}

/** A report for an archive that never loaded: the facts are unknown, not zero. */
function unloadable(path: string, error: BlockingFinding): ArchiveReport {
  return {
    path,
    scope: scopeOf(path),
    id: null,
    dpt: null,
    dptResidual: null,
    cameraHeightMM: null,
    referenceHeightMM: null,
    obliquityDeg: null,
    widthInflation: null,
    images: null,
    labels: null,
    complete: null,
    incomplete: null,
    errors: [error],
    warnings: [],
  };
}

/** The archive-level id, or `null` for anything that will not open. */
async function idOf(input: ArchiveInput): Promise<string | null> {
  try {
    const archive = await R49Archive.load(input.bytes);
    return archive.getManifest().id ?? null;
  } catch {
    // A sibling that does not load is not this pull request's problem. It has
    // its own report if it was submitted here, and is somebody else's if not.
    return null;
  }
}

/**
 * Check 6 — two archives in one contributor directory must not share an id.
 *
 * Compares each submission against its already-committed siblings *and* against
 * the other submissions in the same directory, since a single pull request can
 * add both halves of a collision.
 */
async function idCollisions(
  submitted: readonly { input: ArchiveInput; id: string | null }[],
  siblings: readonly ArchiveInput[]
): Promise<Map<string, BlockingFinding[]>> {
  const byPath = new Map<string, BlockingFinding[]>();

  const committed = new Map<string, string>();
  for (const sibling of siblings) {
    const id = await idOf(sibling);
    if (id !== null) committed.set(`${handleOf(sibling.path)} ${id}`, sibling.path);
  }

  const seen = new Map<string, string>();
  for (const { input, id } of submitted) {
    const handle = handleOf(input.path);
    if (id === null || handle === null) continue;

    const key = `${handle} ${id}`;
    const clash = committed.get(key) ?? seen.get(key);
    if (clash !== undefined && clash !== input.path) {
      byPath.set(input.path, [
        {
          code: 'archive/id-collision',
          rule: 'archive/id-collision',
          message:
            `This archive's id (${id}) already exists at ${clash}. If you meant to update that ` +
            `archive, replace the file rather than adding a second one — the id is its identity, ` +
            `and the path is only where it happens to live.`,
        },
      ]);
    }
    seen.set(key, input.path);
  }

  return byPath;
}

/**
 * Validate a set of submitted archives.
 *
 * `fixtures/` is held to a thinner bar — the archive loads, and the manifest
 * and the zip agree about images — and gets **no warnings at all**. The six are
 * known to be zero-label and below `min_dpt` by design, so annotating that on
 * every pull request would be pure noise, and they carry no ids to check.
 */
export async function validate(
  submitted: readonly ArchiveInput[],
  options: ValidateOptions = {}
): Promise<Report> {
  const author = options.author ?? null;
  const siblings = options.siblings ?? [];

  const loaded: { input: ArchiveInput; id: string | null }[] = [];
  const reports = new Map<string, ArchiveReport>();

  for (const input of submitted) {
    const scope = scopeOf(input.path);

    let archive: R49Archive;
    try {
      archive = await R49Archive.load(input.bytes);
    } catch (err) {
      // Check 1, and with it five of the ticket's candidates: an empty file, an
      // unreadable zip, a missing manifest.json, a version other than 4, a
      // schema-invalid manifest, and duplicate ids within a collection all
      // arrive here, because load() already refuses every one of them.
      reports.set(
        input.path,
        unloadable(input.path, {
          code: 'archive/load',
          // Every refusal load() makes is an R49Error. Anything else escaping
          // it is a bug in the reader, and a contributor must not be told their
          // archive broke a rule it did not — so it propagates, and the CLI
          // exits 2 rather than 1.
          rule: ruleOf(err),
          message: `${input.path} could not be read as a v4 .r49 archive: ${err}`,
        })
      );
      continue;
    }

    const f = facts(archive);
    const errors: BlockingFinding[] = [...checkPath(input.path, author), ...checkImages(archive)];
    const warnings: Finding[] = [];

    if (scope !== 'fixtures') {
      errors.push(...checkLabels(archive));
      if (f.id === null) {
        errors.push({
          code: 'archive/id',
          rule: 'archive/id',
          message:
            `${input.path} has no archive-level id. Open it in the editor and save — every save ` +
            `mints one if it is missing, and never changes one that is already there.`,
        });
      }
      warnings.push(...qualityWarnings(archive, f));
    }

    loaded.push({ input, id: f.id });
    reports.set(input.path, { path: input.path, scope, ...f, errors, warnings });
  }

  const collisions = await idCollisions(
    loaded.filter(l => scopeOf(l.input.path) === 'archives'),
    siblings
  );
  for (const [path, findings] of collisions) {
    const report = reports.get(path);
    if (report) reports.set(path, { ...report, errors: [...report.errors, ...findings] });
  }

  const archives = submitted.map(s => reports.get(s.path)!);
  return { version: 1, archives, ok: isOk(archives) };
}
