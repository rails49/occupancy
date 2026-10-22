import { defineConfig, type UserConfig, type ViteDevServer } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import basicSsl from '@vitejs/plugin-basic-ssl';
import type { InlineConfig } from 'vitest';
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { ORT_WASM_BINARY, ortCopyTargets } from './ortAssets.js';
import { DETECTOR_MODEL_DEST, DETECTOR_MODEL_ENTRY } from './modelCopy.js';

interface VitestConfig extends UserConfig {
  test?: InlineConfig;
}

/**
 * ORT's bundle build carries `new URL('<binary>', import.meta.url)` for the
 * case where nothing sets `ort.env.wasm.wasmPaths`, and Rollup turns that into
 * a second emitted copy of the 13 MB binary. `rr-live-view` always sets the
 * path, so that copy is 13 MB of bytes nothing can ever fetch — drop it and
 * leave `ort/` as the one place the runtime lives.
 */
const dropUnfetchableOrtWasm = {
  name: 'rr-drop-unfetchable-ort-wasm',
  generateBundle(_options: unknown, bundle: Record<string, unknown>) {
    // `.wasm` only, and matched on the hashed name Rollup gives it. The glue
    // shares this prefix; it is inlined today, but were it ever emitted on its
    // own, deleting it would take out the threading this change exists to buy.
    const stem = path.basename(ORT_WASM_BINARY, '.wasm');
    for (const name of Object.keys(bundle)) {
      const file = path.basename(name);
      if (file.endsWith('.wasm') && file.startsWith(stem)) delete bundle[name];
    }
  },
};

/**
 * Where a corpus checkout may be symlinked for local dev, and the URL it is
 * served at.
 *
 * **Deliberately not under `publicDir`** (#122). It lived in `ui/public/` and
 * that directory means one thing — copied verbatim into `dist/`, and from there
 * uploaded to production by `bin/deploy.sh`. Vite dereferences the symlink on
 * the way, so ~21 MB of `.r49` archives arrived at rails49.org as ordinary
 * files, under every per-file size check and indistinguishable from bundle
 * output. Gitignoring it (#108) stopped git from carrying it and did nothing
 * about the build, which reads the working tree.
 */
const PROTO_FIXTURES_DIR = 'proto-fixtures';
const PROTO_FIXTURES_ROUTE = '/proto-fixtures';

/**
 * Serve those fixtures in `pnpm dev`, and only there.
 *
 * `apply: 'serve'` is the whole guarantee: there is no build hook, so no
 * arrangement of this plugin can put a fixture in `dist/`. The URL is unchanged
 * from when the symlink sat in `publicDir`, so nothing about driving the
 * diagnostics view without the file picker changes.
 */
const serveProtoFixtures = {
  name: 'rr-serve-proto-fixtures',
  apply: 'serve' as const,
  configureServer(server: ViteDevServer) {
    server.middlewares.use(PROTO_FIXTURES_ROUTE, (req, res) => {
      // `basename` flattens any traversal attempt, and the corpus fixtures tree
      // is flat, so nothing legitimate needs a subdirectory.
      const name = path.basename(decodeURIComponent((req.url ?? '').split('?')[0]));
      const file = path.resolve(__dirname, PROTO_FIXTURES_DIR, name);
      if (!name || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        // Answered here rather than passed on with `next()`. Everything
        // reaching this middleware is a fixture request, and the fallthrough is
        // vite's SPA rewrite — so a typo'd filename would return `index.html`
        // with a 200 and the archive parser would report a corrupt zip.
        res.statusCode = 404;
        res.end(`No fixture ${name} in ui/${PROTO_FIXTURES_DIR}/`);
        return;
      }
      res.setHeader('Content-Type', 'application/zip');
      fs.createReadStream(file).pipe(res);
    });
  },
};

/**
 * The `vite-plugin-static-copy` target for the detector, or `null` with no
 * local model.
 *
 * Resolved through the detector package's `./model` entry, so the filename is
 * the package's (ADR 0019). A published package with no model has no `./model`
 * entry (`ERR_PACKAGE_PATH_NOT_EXPORTED`), and a linked checkout with no model
 * has the entry but not the file (`MODULE_NOT_FOUND`). Either way the build
 * goes on without it and the live view reports every sensor `unknown` /
 * `no-model`. Any other failure stops the build.
 *
 * `src` is relative to `ui/`, which is what the plugin resolves against.
 * `resolve` is a parameter so tests can stand in for a package with a model.
 */
export function detectorCopyTarget(
  resolve: (id: string) => string = createRequire(import.meta.url).resolve,
): { src: string; dest: string } | null {
  let file: string;
  try {
    file = resolve(DETECTOR_MODEL_ENTRY);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return null;
    throw err;
  }
  return { src: path.relative(__dirname, file), dest: DETECTOR_MODEL_DEST };
}

const detectorTarget = detectorCopyTarget();

export const config: VitestConfig = {
  base: '/',
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: 'node_modules/@shoelace-style/shoelace/dist/assets',
          dest: 'shoelace',
        },
        ...ortCopyTargets,
        // The detector, and nothing else: the CNN is retained but no longer
        // loaded (#7, #85), so shipping it would be 11 MB nothing fetches. The
        // filename is the detector package's, and `modelAssets.ts` builds the
        // URL the `loadDetector` call fetches from it.
        ...(detectorTarget ? [detectorTarget] : []),
      ],
    }) as any,
    dropUnfetchableOrtWasm,
    serveProtoFixtures,
    ...(process.env.HTTP ? [] : [basicSsl()]),
  ],
  resolve: {
    dedupe: ['lit', 'lit-html', 'lit-element'],
  },
  server: {
    host: true,
    fs: {
      allow: ['..'],
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'onnx-vendor': ['onnxruntime-web/wasm'],
        },
      },
    },
  },
};

export default defineConfig(config);
