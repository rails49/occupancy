import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Runs `bin/check-deploy-source.sh` in throwaway clones of a local bare origin.

const repoRoot = path.resolve(__dirname, '../..');
const guard = path.join(repoRoot, 'bin/check-deploy-source.sh');

const env = {
  ...process.env,
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
