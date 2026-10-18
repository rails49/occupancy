/**
 * The format rules an archive can be refused on, by stable id.
 *
 * The id is the contract; the message is not. Two implementations of the
 * format — this one and the Python reader — and the conformance cases both run
 * must agree on *why* an archive was refused without agreeing on wording, so
 * every refusal names one of these and tests assert the id alone (#182).
 *
 * A **format** rule is one every archive follows, whoever reads it.
 * `R49Archive.load` and `setManifest` throw an {@link R49Error} naming one of
 * them, except the two `images/` rules, which `R49Archive.imageMismatches`
 * reports instead of throwing: refusing to open a file because it carries a
 * stray image would lock its author out of the one tool that can fix it.
 *
 * Ids are append-only. Renaming one breaks every conformance case that names it.
 */
export const FORMAT_RULES = [
  /** The bytes are empty. */
  'archive/empty',
  /** The bytes are not a readable zip. */
  'archive/not-zip',
  /** The zip holds no `manifest.json`. */
  'archive/no-manifest',
  /** `manifest.json` is not valid JSON. */
  'manifest/not-json',
  /** The manifest's `version` is not the one this package reads. */
  'manifest/version',
  /** A key the format does not define, at any depth — refused, never stripped. */
  'manifest/unknown-key',
  /** Two labels in one image, or two sensors in one layout, share an id. */
  'manifest/duplicate-id',
  /** A label's `provenance` is absent or unknown, or `proposed_by` contradicts it. */
  'manifest/provenance',
  /** Any other shape the format does not allow: a missing scale, a wrong type, an empty id. */
  'manifest/schema',
  /** The manifest names an image the zip does not contain. */
  'images/missing',
  /** The zip contains an image no manifest entry names. */
  'images/orphan',
] as const;

/**
 * The corpus rules: what an archive must meet to be accepted into the corpus,
 * beyond the format. Nothing in this package enforces them — the corpus
 * validator does — but their ids live beside the format's so the set a
 * submission can be refused on is defined in one place.
 */
export const CORPUS_RULES = [
  /** The path is not `archives/<handle>/<slug>.r49` or `fixtures/<slug>.r49`. */
  'path/shape',
  /** The filename is not a lowercase, hyphen-separated slug. */
  'path/slug',
  /** The submission sits under a contributor directory other than its author's. */
  'path/owner',
  /** The archive carries no archive-level `id`. */
  'archive/id',
  /** Two archives in one contributor directory share an `id`. */
  'archive/id-collision',
  /** A label is still `proposed` — model output nobody reviewed. */
  'labels/provenance',
  /** A label's class is not in the vocabulary. */
  'labels/class',
] as const;

/** Every rule id, format and corpus — the closed set a refusal may name. */
export const RULES: readonly Rule[] = [...FORMAT_RULES, ...CORPUS_RULES];

/** A rule every archive follows. */
export type FormatRule = (typeof FORMAT_RULES)[number];

/** A rule an archive must meet to enter the corpus. */
export type CorpusRule = (typeof CORPUS_RULES)[number];

/** Any rule a refusal may name. */
export type Rule = FormatRule | CorpusRule;

/**
 * The error every refusal of an archive throws: an ordinary `Error` whose
 * message is for a person, plus the {@link FormatRule} it broke, for a program.
 *
 * `name` is deliberately left as `Error`, so `String(err)` — which is what the
 * editor shows — reads exactly as it did before rules existed.
 */
export class R49Error extends Error {
  /** The rule this archive broke. Stable; safe to match on. */
  readonly rule: FormatRule;

  /**
   * @param cause The error the refusal was detected through, when there is
   *        one — zod's, for a schema failure — so its text survives wrapping.
   */
  constructor(rule: FormatRule, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.rule = rule;
  }
}

/** One way the manifest and the zip disagree about which images an archive holds. */
export interface ImageMismatch {
  readonly rule: 'images/missing' | 'images/orphan';
  /** The manifest filename, or the zip entry, the disagreement is about. */
  readonly filename: string;
}
