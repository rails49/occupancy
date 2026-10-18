// Public interface of @occupancy/r49.
//
// This file is the package's interface — the only surface consumers may rely
// on. Anything not exported here is internal and may change without notice.
// Per-symbol documentation lives on the declarations in ./archive.ts and
// ./manifest.schema.ts, because TypeScript discards doc comments written on
// re-export statements.

//── Archive I/O ──────────────────────────────────────────────────────────────
// Read and write .r49 layout archives (a zip of manifest.json + images).
// Manifests are validated against the v4 schema on load; invalid input throws.
// There is no v3 path: loading anything else fails on the version number.
export { R49Archive } from './archive.ts';

//── Manifest types (v4) ──────────────────────────────────────────────────────
// The shape of a parsed manifest, as returned by R49Archive.getManifest().
//
// Two geometries, differing in scope and in whether a model ever sees them:
// a CarLabel is two points along a car's centerline, per image, trained on,
// and carries provenance; a Sensor is a single query point, per layout, never
// trained on, and carries none.
export type {
  ManifestData,
  Layout,
  Camera,
  Image,
  CarLabel,
  Provenance,
  Sensor,
  Calibration,
  CalibrationPoint,
  Point,
  WorldPoint,
} from './manifest.schema.ts';

export { MANIFEST_VERSION } from './manifest.schema.ts';

//── Scale geometry ───────────────────────────────────────────────────────────
// Consumers work with scale names and pixel-domain measurements only — the
// prototype domain (real-world 1435mm gauge) and the model domain (physical
// gauge in mm) are internal implementation details of how getDPT() is
// computed.
// getDPTResidual is the same fit's diagnostic and lives beside it deliberately:
// both must select the same equal-z pairs, and two implementations of that rule
// would drift.
export {
  getDPT,
  getDPTResidual,
  VALID_SCALES,
  type ValidScales,
} from './manifest.schema.ts';

//── Identity ─────────────────────────────────────────────────────────────────
// Time-ordered, collision-resistant 11-character identifiers. Archive, label
// and sensor ids are all minted with it, so it lives with the format whose
// `id` fields it fills.
export { make_id } from './uid.ts';

//── Class vocabulary ─────────────────────────────────────────────────────────
// How the authored taxonomy is read. Here rather than in a consumer because two
// of them must agree: the editor warns on a non-conforming class, and the
// corpus validator blocks on it. Not parse-time validation — `class` stays a
// plain string at the format layer.
// `isSegmentPrefix` is the rule itself, exported so a reader mapping classes
// onto a list of its own (the detector's YOLO class index) matches the same way.
export {
  isKnownClass,
  isSegmentPrefix,
  vocabularySubtypes,
  type VocabularyNode,
} from './vocabulary.ts';

// Withheld: the zod schemas (ManifestDataSchema, PointSchema, LayoutSchema,
// …). Exporting them would make zod part of this package's contract, so it
// could not be replaced without a breaking change. Validation is an
// implementation detail — callers get validated data or an exception.
//
// Withheld: STANDARD_GAUGE, SCALE_TO_RATIO and getGaugeMM, the prototype- and
// model-domain gauge constants. Nothing outside this package needs a physical
// gauge in mm — only the pixel-domain getDPT() and the scale names in
// VALID_SCALES. Exposing the prototype domain would invite gauge arithmetic to
// be reimplemented downstream (which is exactly what lib/classifier used to
// do). The first two are no longer ours to re-export in any case: they are
// generated into @occupancy/config from config.yaml, which is where anything
// that genuinely needs them should read them.
//
// Withheld: `toBase62`. It is a numeric encoding helper, not an identity
// concept — exporting it invites callers to mint ids that bypass the
// timestamp/node/sequence structure `make_id` guarantees. Tests import it
// directly from './uid.ts'.
//
// Withheld: assertManifestVersion. It is the version guard R49Archive applies
// before parsing, not a public predicate — callers that want to know whether
// bytes are loadable should try to load them.
