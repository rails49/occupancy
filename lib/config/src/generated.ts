// GENERATED FILE — DO NOT EDIT.
//
// Source: config.yaml, and @rails49/r49's data file for the format's gauge,
// scales and vocabulary. Regenerate with: pnpm config:generate
//
// Hand edits are lost on the next run, and bin/test.sh fails the build when
// this file disagrees with its sources.

//── Layout geometry ─────────────────────────────────────────────────────────

/** Prototype track gauge in mm. Read from @rails49/r49's data file. */
export const STANDARD_GAUGE = 1435.0;

/**
 * Prototype car width in mm — the widest real stock, not a typical one.
 *
 * Car width is derived from this rather than stored per label. Because
 * width in pixels is `DPT * STANDARD_WIDTH / STANDARD_GAUGE`, the scale
 * ratio cancels: a car is the same 2.09 track-widths wide in every scale.
 */
export const STANDARD_WIDTH = 3000.0;

/**
 * Minimum usable DPT. Warns persistently, never blocks — the fixture
 * corpus sits below it at DPT 18-19.
 */
export const MIN_DPT = 20;

/**
 * Largest apparent camera displacement still taken as the canonical
 * pose, as a **fraction of one track width**.
 *
 * The verdict `@occupancy/drift` deliberately does not make. Above this,
 * the live view refuses to classify — with an override — and the editor
 * warns without blocking: one authored number, two responses, which is
 * why it is config and not a constant inside the module.
 *
 * DPT is pixels per track gauge, so the tolerance in pixels is
 * `MAX_DRIFT_TRACK_FRACTION * dpt` — `ui/src/driftSession.ts`'s
 * `maxDriftPx` is the one place that multiplies. A fraction rather than
 * a pixel count because the failure is geometric: a sensor stops sitting
 * on the car it reads. It is a **tolerance, not a detection floor** — the
 * check resolves far smaller displacements than this accepts, and should.
 *
 * See config.yaml for the derivation.
 */
export const MAX_DRIFT_TRACK_FRACTION = 0.25;

/** Every scale name @rails49/r49's data file defines a ratio for. */
export type Scale = "G" | "O" | "S" | "HO" | "T" | "N" | "Z";

/**
 * Scale name to reduction ratio (HO is 1:87). Model-domain gauge is
 * `STANDARD_GAUGE / SCALE_TO_RATIO[scale]`.
 */
export const SCALE_TO_RATIO = { "G": 25, "O": 48, "S": 64, "HO": 87, "T": 120, "N": 160, "Z": 220 } as const;

/**
 * Scale names as a non-empty tuple, in @rails49/r49's data file order — the
 * form a schema enum needs.
 */
export const SCALES: readonly [Scale, ...Scale[]] = ["G", "O", "S", "HO", "T", "N", "Z"];

//── Detector ────────────────────────────────────────────────────────────────

/** Detector input resolution, `[width, height]` in pixels. */
export const DETECTOR_INPUT = [960, 544] as const;

/**
 * Single confidence threshold for decoding detections.
 *
 * A placeholder until held-out recall can set it. Nothing reads it yet;
 * how the eventual detector export applies it is that export's to decide.
 */
export const DETECTOR_CONFIDENCE_THRESHOLD = 0.25;

/**
 * Rotated-box IoU above which two detections are the same car.
 *
 * The exported graph does not deduplicate: `end2end`'s `TopK` selects the
 * 300 top-scoring slots and suppresses nothing, so up to four boxes land
 * on one vehicle (issue #107). The decode applies this after thresholding.
 */
export const DETECTOR_NMS_IOU = 0.5;

/**
 * Fraction of exported images held out for validation.
 *
 * The unit is the image, not the label: every car in a frame lands on
 * the same side of the split, or the frame appears in both.
 */
export const DETECTOR_VAL_SPLIT = 0.2;

/**
 * The YOLO class list, verbatim and index-ordered.
 *
 * ⚠️  APPEND-ONLY. A position in this array *is* a class index, so
 * reordering or removing an entry invalidates trained weights while
 * config.yaml still validates. Edit config.yaml, never this file.
 *
 * A label maps to the longest entry that is a segment-prefix of its class:
 * `stock` matches `stock.loco.steam` but never `stockyard`.
 */
export const DETECTOR_CLASSES = ["stock"] as const;

/**
 * The authoring taxonomy — what a label's `class` should match. Read
 * from @rails49/r49's data file; every DETECTOR_CLASSES entry names a class in it.
 *
 * The root is required, not cosmetic: an unrooted class matches no
 * entry in DETECTOR_CLASSES and would be dropped from an export. The root
 * itself is not offered in the UI; its children are.
 *
 * A **nested object is a subtype**; any other value is a property of the
 * class it sits under (`width_mm` is the one such property today). That
 * is what tells a subtype from a property with no reserved key names.
 */
export const VOCABULARY = { "stock": { "loco": { "steam": {}, "diesel": {}, "electric": {} }, "passenger": {}, "freight": {} } } as const;
