import { defineConfig } from 'vitest/config';
import { config } from './vite.config.js';

/**
 * The look-rules check, run on its own (#149).
 *
 * `vite.config.ts` includes `tests/**` and nothing else, so `look/` is outside
 * `pnpm test` and therefore outside `bin/test.sh` — which is the placement
 * ADR-0005 asks for and `look/README.md` explains. A second config file is what
 * it costs: vitest takes its include pattern from a config, not the CLI.
 *
 * **The include pattern is the only difference, and it is spelled as an
 * override rather than a fresh config.** Everything else — jsdom, the setup
 * file, and `resolve.dedupe`, without which two copies of Lit reach a test that
 * reads `static styles` off decorated classes — comes from the one config that
 * already states it.
 */
export default defineConfig({
  ...config,
  test: { ...config.test, include: ['look/*.test.ts'] },
});
