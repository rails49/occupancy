/**
 * Where the build finds the model, and where in the bundle it puts it.
 *
 * The build-time half of `modelAssets.ts`, split out because `vite.config.ts`
 * imports it and loads no package code. This module imports nothing.
 */

/**
 * The package entry the build resolves to find the model (ADR 0019).
 *
 * A package version without a model has no `./model` entry (0.0.x has none).
 * The copy is conditional on the entry resolving, so a build with no model
 * succeeds and the live view reports every sensor `unknown` / `no-model`
 * rather than failing to start. That is what keeps `bin/test.sh` runnable
 * without downloading anything.
 */
export const DETECTOR_MODEL_ENTRY = '@rails49/detector/model';

/** The bundle directory the build copies the model into. */
export const DETECTOR_MODEL_DEST = 'models';
