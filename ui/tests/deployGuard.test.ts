import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ORT_WASM_BINARY } from '../ortAssets.js';
import { DETECTOR_MODEL_FILE } from '../modelAssets.js';

// Why the deploy directory needs a guard that checks for *absence* is in
// `bin/check-deploy-dir.sh`'s header and in `docs/SYSTEM.md` § Deploy (#122); the
// short version is that every earlier check was one-directional and none could
// see 21 MB of corpus archives in the bundle. `ui/tests/publicDir.test.ts`
// closed the source they came in through. This covers the deploy directory
// itself.
//
// What is specific to this file: the inventory lives in the shell script, not
// here. These tests *run* that script against directories they construct, so
// there is no second copy to drift — the thing under test is the thing the
// deploy runs. That is the reason the guard is its own script rather than a
// block inside `bin/deploy.sh`, which cannot be exercised without a build, a
// 1Password lookup and an upload.

const repoRoot = path.resolve(__dirname, '../..');
const guard = path.join(repoRoot, 'bin/check-deploy-dir.sh');

/** Run the guard against `dir`, as `bin/deploy.sh` does. */
function check(dir: string) {
  const { status, stdout, stderr } = spawnSync(guard, [dir], { encoding: 'utf8' });
  return { status, output: stdout + stderr };
}

/** A file of `bytes`, sparse, so a size check can be driven without the bytes. */
function sized(file: string, bytes: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  fs.truncateSync(file, bytes);
}

let dir: string;

/** The smallest directory that passes everything: the shape of a real deploy. */
beforeEach(() => {
  // One level deep, not two: the app has an origin to itself, so the deploy
  // directory is `ui/dist/` rather than a staging root holding a landing page
  // and the build under `ui/` (rails49/control#47).
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r49-deploy-'));
  // A real one, not a stub: the guard checks that the shipped `_headers` still
  // sets require-corp, so a placeholder here would fail every test below for
  // the wrong reason.
  fs.writeFileSync(
    path.join(dir, '_headers'),
    '/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n',
  );
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
  fs.mkdirSync(path.join(dir, 'ort'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  // Imported, never spelled out: these filenames are named once, in
  // `ortAssets.ts` and `modelAssets.ts`. The guard script repeats the ORT one
  // because a shell script cannot import — a test has no such excuse, and a
  // literal here would quietly stop constructing a passing bundle the day the
  // name changed.
  fs.writeFileSync(path.join(dir, 'ort', ORT_WASM_BINARY), '\0asm');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('bin/check-deploy-dir.sh', () => {
  it('passes a deploy directory holding only what a release contains', () => {
    const { status, output } = check(dir);

    expect(status).toBe(0);
    // Reports the measured total against the budget rather than passing
    // silently. The number is the one a maintainer needs to see creeping, and
    // a budget nobody watches is a budget raised reflexively on first contact.
    expect(output).toMatch(/MiB/);
  });

  it('passes when the optional model directory is absent', () => {
    // A clone with no `detector/models/` builds fine and ships a no-model
    // banner (#85). The inventory is what *may* appear, not what must.
    fs.mkdirSync(path.join(dir, 'models'));
    fs.writeFileSync(path.join(dir, 'models', DETECTOR_MODEL_FILE), 'x');

    expect(check(dir).status).toBe(0);
  });

  it('refuses a symlink anywhere, naming its path', () => {
    // The mechanism that made #122 invisible: the copy dereferences the link,
    // so what lands in the bundle is an ordinary file carrying no trace of
    // where it came from. Nothing downstream can tell it from build output.
    fs.symlinkSync('/etc/hosts', path.join(dir, 'assets/somewhere-else'));

    const { status, output } = check(dir);

    expect(output).toContain('assets/somewhere-else');
    expect(status).not.toBe(0);
  });

  it('refuses an extension that has no business in a deploy, naming it', () => {
    fs.writeFileSync(path.join(dir, 'assets/cars-0-10.r49'), 'PK');

    const { status, output } = check(dir);

    expect(output).toContain('cars-0-10.r49');
    expect(status).not.toBe(0);
  });

  it('refuses an entry the inventory does not name', () => {
    // `.DS_Store` was really there, back when the deploy directory was a
    // tracked staging root the build only partly overwrote. Vite empties
    // `dist/` now, so nothing should survive a build — which is a reason to
    // keep asserting it rather than to stop.
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'junk');

    const { status, output } = check(dir);

    expect(output).toContain('.DS_Store');
    expect(status).not.toBe(0);
  });

  it('refuses a directory of payload inside the build output', () => {
    // #122's exact shape, minus the giveaway extension: archives reaching the
    // bundle through `ui/public/`, which vite copies verbatim. They landed a
    // level down when the build was staged under `ui/`; they land here now, and
    // the inventory follows the build output rather than a fixed depth.
    fs.mkdirSync(path.join(dir, 'proto-fixtures'));
    fs.writeFileSync(path.join(dir, 'proto-fixtures/simple.bin'), 'PK');

    const { status, output } = check(dir);

    expect(output).toContain('proto-fixtures');
    expect(status).not.toBe(0);
  });

  it('refuses a total size over budget, though every file clears the per-file limit', () => {
    // The check that would have fired in #122. Six archives of ~5 MB each pass
    // a *per-file* 25 MiB ceiling with room to spare; only the total sees them.
    for (const n of [1, 2, 3, 4, 5, 6]) sized(path.join(dir, `assets/chunk-${n}.js`), 5 * 1024 * 1024);

    const { status, output } = check(dir);

    expect(output).toMatch(/budget|total/i);
    expect(status).not.toBe(0);
  });

  it('refuses a bundle whose _headers did not make it', () => {
    // `_headers` used to be a tracked file in the staging directory, so it
    // could not go missing without someone deleting it from git. It ships
    // through the build now (`ui/public/`), which is one more way for it to be
    // absent — and the inventory above is a list of what *may* appear, so a
    // bundle without it passed every other check here.
    //
    // Worth a check of its own because losing it is the quietest failure in
    // this repo: no error, no warning, the app works, and ORT drops to a single
    // WASM thread for ~1.5x on every inference (#15).
    fs.rmSync(path.join(dir, '_headers'));

    const { status, output } = check(dir);

    expect(output).toContain('_headers');
    expect(status).not.toBe(0);
  });

  it('refuses a bundle whose _headers no longer isolates', () => {
    // Present but not doing its job is the same outage as absent. The rule's
    // *content* is pinned in `ortAssets.test.ts` against the source file; this
    // is the copy that actually ships.
    fs.writeFileSync(path.join(dir, '_headers'), '/*\n  X-Frame-Options: DENY\n');

    const { status, output } = check(dir);

    expect(output).toContain('_headers');
    expect(status).not.toBe(0);
  });

  it('still refuses a bundle missing the ORT binary', () => {
    // Pre-existing guard, kept: the app cannot run without it and it can no
    // longer be fetched from a CDN under COEP: require-corp (#15).
    fs.rmSync(path.join(dir, 'ort', ORT_WASM_BINARY));

    const { status, output } = check(dir);

    expect(output).toContain(ORT_WASM_BINARY);
    expect(status).not.toBe(0);
  });

  it('still refuses a single file over Cloudflare\'s 25 MiB limit', () => {
    // Pre-existing guard, kept. Cloudflare rejects the upload; failing here
    // says so in one line instead of partway through a push.
    sized(path.join(dir, 'assets/huge.js'), 26 * 1024 * 1024);

    const { status, output } = check(dir);

    expect(output).toContain('huge.js');
    expect(status).not.toBe(0);
  });

  it('refuses rather than under-reports when a file cannot be read', () => {
    // The size check reads the bundle through a pipe, and a pipeline reports
    // its *last* command's status: without `pipefail`, a `cat` that failed
    // still left `wc` exiting 0 and the budget passing on a total missing
    // however many bytes went unread. Measured at 200 KB before the fix — the
    // one gate here that failed open, in a guard whose whole point is the
    // opposite. An unreadable file is not a bundle anyone should publish.
    sized(path.join(dir, 'assets/unreadable.js'), 200 * 1024);
    fs.chmodSync(path.join(dir, 'assets/unreadable.js'), 0o000);

    expect(check(dir).status).not.toBe(0);

    // So `afterEach` can remove it.
    fs.chmodSync(path.join(dir, 'assets/unreadable.js'), 0o644);
  });

  it('refuses a directory that does not exist', () => {
    expect(check(path.join(dir, 'nope')).status).not.toBe(0);
  });
});

describe('bin/deploy.sh', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'bin/deploy.sh'), 'utf8');

  it('runs the guard, and runs it before anything is uploaded', () => {
    // A guard that ran after `wrangler pages deploy` would report a bundle
    // already published. `set -e` at the top of the script turns the non-zero
    // exit into an abort, so ordering is the whole contract.
    const guardLine = source.indexOf('check-deploy-dir.sh');
    const deployLine = source.indexOf('pages deploy');

    expect(guardLine).toBeGreaterThan(-1);
    expect(deployLine).toBeGreaterThan(guardLine);
  });

  it('uploads the build output itself, with no staging copy in between', () => {
    // The staging directory existed to hold a landing page beside the build.
    // With the app on its own origin there is nothing to stage, and a copy step
    // reintroduced here would be a second place for unaccounted files to sit —
    // exactly what the guard above exists to catch, one level removed from the
    // build that vite empties.
    expect(source).toMatch(/^DEPLOY_DIR="ui\/dist"$/m);
    expect(source).not.toContain('rsync');
  });

  it('leaves the checks to the guard rather than keeping a second copy', () => {
    // `ui/tests/ortAssets.test.ts` asserts the ORT filename appears in a
    // deploy script because a shell script cannot import TypeScript. That
    // reason does not extend to a check the deploy script could simply call —
    // two `find -size` blocks would be two things to keep in step.
    expect(source).not.toContain('-size +25M');
  });
});
