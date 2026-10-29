import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Runs `bin/check-deploy-source.sh` in throwaway clones of a local bare origin.

const repoRoot = path.resolve(__dirname, '../..');
const guard = path.join(repoRoot, 'bin/check-deploy-source.sh');

// No inherited GIT_ variable: a git hook exports GIT_DIR, which would point
// these commands at the real repository.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

function git(cwd: string, ...args: string[]) {
  const { status, stderr } = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (status !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`);
}

function commit(cwd: string, file: string) {
  fs.writeFileSync(path.join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
}

function check(cwd: string) {
  const { status, stdout, stderr } = spawnSync(guard, { cwd, env, encoding: 'utf8' });
  return { status, output: stdout + stderr };
}

let dir: string;
let origin: string;
let work: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-source-'));
  origin = path.join(dir, 'origin.git');
  work = path.join(dir, 'work');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(dir, 'clone', '-q', origin, work);
  commit(work, 'a');
  git(work, 'push', '-q', 'origin', 'main');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('bin/check-deploy-source.sh', () => {
  it('passes a clean checkout at origin/main', () => {
    expect(check(work).status).toBe(0);
  });

  it('refuses a checkout on another commit', () => {
    git(work, 'checkout', '-q', '-b', 'feature');
    commit(work, 'b');

    const { status, output } = check(work);
    expect(status).not.toBe(0);
    expect(output).toMatch(/origin\/main/);
  });

  it('refuses a modified tracked file', () => {
    fs.writeFileSync(path.join(work, 'a'), 'changed');

    const { status, output } = check(work);
    expect(status).not.toBe(0);
    expect(output).toMatch(/uncommitted/);
  });

  it('refuses an untracked file', () => {
    fs.writeFileSync(path.join(work, 'new'), '');

    const { status, output } = check(work);
    expect(status).not.toBe(0);
    expect(output).toMatch(/uncommitted/);
  });

  it('refuses when origin/main moved since the last fetch', () => {
    const other = path.join(dir, 'other');
    git(dir, 'clone', '-q', origin, other);
    commit(other, 'c');
    git(other, 'push', '-q', 'origin', 'main');

    const { status, output } = check(work);
    expect(status).not.toBe(0);
    expect(output).toMatch(/origin\/main/);
  });
});

describe('the throwaway repositories', () => {
  it('stay throwaway when the run starts under a git hook', () => {
    // A hook sets GIT_DIR before this file loads, so the check runs this file
    // again in a child that starts with one, pointing at a repository of its own.
    const outer = path.join(dir, 'outer');
    git(dir, 'init', '-q', '-b', 'main', outer);
    const run = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', 'tests/deploySource.test.ts', '-t', 'passes a clean checkout'],
      {
        cwd: path.join(repoRoot, 'ui'),
        env: { ...process.env, GIT_DIR: path.join(outer, '.git') },
        encoding: 'utf8',
      }
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(fs.readdirSync(path.join(outer, '.git', 'refs', 'heads'))).toEqual([]);
    // A whole second vitest starts in the child, which is seconds on its own
    // and more under the rest of the suite, so the default 5 s cannot hold it
    // — the timeout `modelAssets.test.ts` gives its child build.
  }, 120_000);
});
