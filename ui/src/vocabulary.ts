import { VOCABULARY } from '@occupancy/config';
import { vocabularySubtypes, type VocabularyNode } from '@rails49/r49';

/**
 * Whether a stored class names an entry of the taxonomy.
 *
 * Re-exported from `@rails49/r49` rather than implemented here: the corpus
 * validator **blocks** a submission on the same predicate the editor merely
 * warns on, and two implementations of segment matching would matter most in
 * exactly the case where they disagreed — a contributor rejected for a class
 * this editor drew as fine. This module stays the only place `ui/` learns what
 * a car may be called.
 */
export { isKnownClass } from '@rails49/r49';

/**
 * The authored class taxonomy, read as a tree — the one place `ui/` learns what
 * a car may be called.
 *
 * A pure module for the same reason `geometry.ts` is one: it is arithmetic over
 * data, and a component cannot be tested in jsdom. Everything here is derived
 * from the vocabulary in `@rails49/r49`'s data file, reached through the generated
 * `@occupancy/config`, so **a subtype added in an `@rails49/r49` release reaches
 * the editor's menu at the next bump and regenerate, with no code edit** — and no class name is written anywhere
 * else in `ui/` (`SPEC.md` § Parameters live in `config.yaml`).
 *
 * Two rules the tree is read with, both of which are wrong somewhere if
 * reimplemented:
 *
 * * **A nested object is a subtype; anything else is a property.** `width_mm`
 *   is an optional per-class width override that sits beside subtypes in the
 *   same mapping, and telling the two apart structurally is what avoids a
 *   reserved list of key names that the data file would then have to know about.
 * * **The stored class is always rooted, and the root is never shown.** A label
 *   maps to the longest entry of `detector.classes` that is a segment-prefix of
 *   its class, so an unrooted `loco.steam` matches nothing and is **dropped
 *   from the export** — the unlabeled-car-as-background failure the
 *   completeness rule exists to prevent. So `class` carries `stock.` and the
 *   menu renders the root's children.
 */

export type { VocabularyNode };

/** One class the menu can offer, and the subtypes nested under it. */
export interface ClassChoice {
  /** The full dotted class, root included — exactly what is stored. */
  readonly class: string;
  /** The last segment, which is what the user reads. */
  readonly name: string;
  /** Subtypes of this class, in authored order. Empty for a leaf. */
  readonly children: readonly ClassChoice[];
}

/** The authored taxonomy. A separate name so the default is legible. */
const AUTHORED: VocabularyNode = VOCABULARY;

/**
 * The subtypes of a node, in authored order. Shared with the validator through
 * `@rails49/r49` for the same reason `isKnownClass` is: "a nested object is a
 * subtype, anything else is a property" is a rule about the authored taxonomy,
 * not about the menu.
 */
const subtypes = vocabularySubtypes;

/**
 * The taxonomy's single root — the class every new car is created as.
 *
 * Derived rather than written down: the editor authoring a hardcoded `'stock'`
 * would be a second home for a value `@rails49/r49`'s data file owns, and it would go
 * on agreeing with the vocabulary only by luck.
 *
 * **Exactly one root**, and both other counts throw rather than guess. None
 * leaves a new car with no class to be created as, and a second makes "the
 * root" — the thing every class must be rooted at — ambiguous. `bin/generate_config.py`
 * rejects an empty vocabulary, so reaching either case means a hand-edited
 * `lib/config`, which is already a documented mistake.
 *
 * @throws If the vocabulary does not name exactly one root class.
 */
export function rootClass(vocabulary: VocabularyNode = AUTHORED): string {
  const roots = subtypes(vocabulary);
  if (roots.length !== 1) {
    throw new Error(
      `The vocabulary in @occupancy/config must name exactly one root class, found ${roots.length}. ` +
        'Regenerate it: pnpm config:generate'
    );
  }
  return roots[0][0];
}

/** The subtree under one node, as choices carrying their full dotted class. */
function choicesUnder(node: VocabularyNode, prefix: string): readonly ClassChoice[] {
  return subtypes(node).map(([name, child]) => {
    const dotted = `${prefix}.${name}`;
    return { class: dotted, name, children: choicesUnder(child, dotted) };
  });
}

/**
 * What the reclassify menu offers: the root's children, nested.
 *
 * The root itself is **not** among them — it is required in the stored class
 * and absent from the UI — so a taxonomy that is only a root offers nothing,
 * and the editor opens no reclassify row at all rather than an empty submenu.
 */
export function classChoices(vocabulary: VocabularyNode = AUTHORED): readonly ClassChoice[] {
  const root = rootClass(vocabulary);
  return choicesUnder(vocabulary[root] as VocabularyNode, root);
}

