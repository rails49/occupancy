/**
 * Where the build finds the model, and where in the bundle it puts it.
 *
 * The build-time half of `modelAssets.ts`, split out because `vite.config.ts`
 * imports it: Vite's config loader leaves workspace packages external, and Node
 * cannot load `@occupancy/detector`'s TypeScript source, so nothing the config
 * imports may import the package. This module imports nothing.
 */

/**
 * The package entry the build resolves to find the model (ADR 0019).
 *
 * The model is gitignored, and absent on a fresh clone: the copy is conditional
 * on the file existing, so a build with no local model succeeds and the live
 * view reports every sensor `unknown` / `no-model` rather than failing to
 * start. That is what keeps `bin/test.sh` runnable without downloading
 * anything.
 */
export const DETECTOR_MODEL_ENTRY = '@occupancy/detector/model';

/** The bundle directory the build copies the model into. */
export const DETECTOR_MODEL_DEST = 'models';
