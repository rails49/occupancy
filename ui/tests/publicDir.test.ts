import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// `ui/public` is the one directory vite copies into `dist/` verbatim, with no
// manifest of what it holds and no transform on the way — and `bin/deploy.sh`
// uploads `dist/` to production. Everything else in the bundle is named
// somewhere: `ortAssets.ts` names the runtime, `modelCopy.ts` names the
// model's package entry, and a test holds each of them to it. `public/` is named by nothing,
// so what ships from it is whatever happens to be sitting there.
//
// That is how a symlink to a 21 MB corpus checkout came to be published
// (#122). Gitignoring it (#108) stopped git from carrying it and did nothing
// about the build, because the build reads the working tree — so the guard has
// to read the working tree too.

const publicDir = path.resolve(__dirname, '../public');

/** Every entry under `public/`, recursively, as paths relative to it. */
function walk(dir: string, prefix = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(prefix, entry.name);
    // `withFileTypes` reports a symlink as a symlink rather than following it,
    // which is the distinction this whole file turns on.
    if (entry.isDirectory()) return [rel, ...walk(path.join(dir, entry.name), rel)];
    return [rel];
  });
}

describe('ui/public', () => {
  it('contains no symlinks', () => {
    // The regression. A symlink here is invisible in the bundle: vite copies
    // through it, so the deployed files are ordinary ones with no trace of
    // where they came from — and a per-file size limit cannot see 21 MB spread
    // over six files. Point a dev-only server route at the target instead; see
    // `serveProtoFixtures` in `vite.config.ts`.
    const links = walk(publicDir).filter(rel => fs.lstatSync(path.join(publicDir, rel)).isSymbolicLink());

    expect(links).toEqual([]);
  });

  it('holds only the handful of assets the app actually serves', () => {
    // Deliberately an exact list rather than a size cap or an extension filter.
    // The failure this exists for is *unexpected content*, and every cheaper
    // rule has to guess which content counts — the archives that shipped were
    // individually small and had a perfectly ordinary extension. Adding a real
    // asset here means adding it to this list, which is the point: `public/`
    // gets a manifest, like every other input to the bundle.
    // `_headers` is here rather than beside the deploy script because Cloudflare
    // Pages reads it from the root of the uploaded directory, and that directory
    // is now `ui/dist/` itself (rails49/control#47). Shipping it through the
    // build is what removed the staging copy — and put it under this manifest.
    expect(walk(publicDir).sort()).toEqual(['_headers', 'favicon.svg', 'icons.svg']);
  });
});
