import type { BlockingFinding, Scope } from './report.ts';

/**
 * The corpus's own rules about *where* a file sits — as opposed to what is
 * inside it. Settled in issue #56.
 *
 * These live in the validator rather than in the workflow so that a path
 * violation lands in the same report as everything else: the summary table is a
 * rendering of that report, and a class of failure emitted somewhere else would
 * be a class of failure the table silently omits. They are also covered by
 * `pnpm test`, which a workflow's YAML never is.
 *
 * Nothing here knows about GitHub. The PR author's handle arrives as a
 * parameter — GitHub-specific *data*, not GitHub-specific *logic*.
 */

/**
 * Lowercase, hyphen-separated, no spaces.
 *
 * Whitespace is what this actually exists to stop: `git diff --name-only` piped
 * into a shell loop splits on the spaces in `cars 0-10.r49`. It is trivially
 * fixable by the contributor, which is what makes it fair to block on.
 */
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*\.r49$/;

/** A repo-relative path, split and normalised. `\` is tolerated for Windows contributors. */
function segments(path: string): string[] {
  return path.replace(/\\/g, '/').split('/').filter(s => s !== '' && s !== '.');
}

/**
 * Which bar this path is held to.
 *
 * `fixtures/` sits outside `archives/` deliberately: the six are zero-label and
 * below `min_dpt`, so they satisfy neither half of what the corpus is for, and
 * an outside reader's default glob of `archives/**` must not silently ingest them.
 */
export function scopeOf(path: string): Scope {
  const parts = segments(path);
  if (parts[0] === 'archives' && parts.length === 3) return 'archives';
  if (parts[0] === 'fixtures' && parts.length === 2) return 'fixtures';
  return 'unknown';
}

/**
 * The contributor directory a submission sits in, or `null` when the path is
 * not a well-formed `archives/<handle>/<slug>.r49`.
 */
export function handleOf(path: string): string | null {
  const parts = segments(path);
  return scopeOf(path) === 'archives' ? parts[1] : null;
}

/**
 * Check 7 — the path rules.
 *
 * @param path Repo-relative path of the submitted file.
 * @param author The PR author's handle, or `null` when unknown (a local run).
 *               Unknown skips only the ownership rule; shape and slug still apply.
 */
export function checkPath(path: string, author: string | null): BlockingFinding[] {
  const findings: BlockingFinding[] = [];
  const parts = segments(path);
  const scope = scopeOf(path);

  if (scope === 'unknown') {
    findings.push({
      code: 'path/shape',
      rule: 'path/shape',
      message:
        `${path} is not a place the corpus defines. A submission goes in ` +
        `archives/<your-github-handle>/<slug>.r49; fixtures/<slug>.r49 is reserved for the ` +
        `six archives that came from rails49.`,
    });
    return findings;
  }

  const filename = parts[parts.length - 1];
  if (!SLUG.test(filename)) {
    findings.push({
      code: 'path/slug',
      rule: 'path/slug',
      message:
        `${filename} is not a slug. Rename it to lowercase letters, digits and hyphens — ` +
        `"cars 0-10.r49" becomes "cars-0-10.r49". Spaces in particular break shell tooling ` +
        `that walks the changed files.`,
    });
  }

  if (scope === 'archives' && author !== null && parts[1] !== author) {
    findings.push({
      code: 'path/owner',
      rule: 'path/owner',
      message:
        `${path} is under archives/${parts[1]}/, but this pull request is from @${author}. ` +
        `Submit your archives under archives/${author}/ — the directory is the attribution ` +
        `record CC BY 4.0 asks for.`,
    });
  }

  return findings;
}
