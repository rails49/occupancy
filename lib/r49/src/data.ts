import data from '../r49.json';
import type { VocabularyNode } from './vocabulary.ts';

/**
 * The format's constants, read from `r49.json` at the package root — their one
 * authored home. This module declares none of them; it only gives the parsed
 * file types the rest of the package can use.
 *
 * A JSON file rather than TypeScript because more than this package reads it:
 * occupancy's config generator takes the gauge, the scales and the vocabulary
 * from it (and checks `detector.classes` against the vocabulary), and a Python
 * reader can load it with nothing but the standard library. See ADR 0018.
 */

/** Prototype track gauge in mm. */
export const STANDARD_GAUGE: number = data.standard_gauge;

/**
 * Scale name to reduction ratio (HO is 1:87). Model-domain gauge is
 * `STANDARD_GAUGE / SCALE_TO_RATIO[scale]`.
 */
export const SCALE_TO_RATIO = data.scale_to_ratio;

/** Every scale name the data file defines a ratio for. */
export type Scale = keyof typeof SCALE_TO_RATIO;

/**
 * Scale names as a non-empty tuple, in the data file's order — the form a
 * schema enum needs.
 */
export const SCALES = Object.keys(SCALE_TO_RATIO) as [Scale, ...Scale[]];

/**
 * The authoring taxonomy — what a label's `class` should match.
 *
 * A **nested object is a subtype**; any other value is a property of the class
 * it sits under (`width_mm` is the one such property). The single root is
 * required: every stored class is rooted at it.
 */
export const VOCABULARY: VocabularyNode = data.vocabulary;
