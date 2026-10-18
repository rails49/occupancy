# @occupancy/r49

Reads and writes `.r49` railroad layout archives — a zip holding a
`manifest.json` plus the layout photographs it describes. This is the format
`ui/` opens and saves, and the one `dataset/` reads when preparing training
data.

Manifests are validated against the v4 schema on load, so a successfully loaded
archive is a well-formed one. Works unchanged in Node and the browser.

## Interface

See [`src/index.ts`](src/index.ts) — that file is the package's public surface.
Anything not exported there is internal and may change without notice. Per-
symbol documentation lives on the declarations in `src/archive.ts` and
`src/manifest.schema.ts`, where your editor will show it on hover.

The convention and the reasoning behind it are in [`../CLAUDE.md`](../CLAUDE.md).

## Use it

This is a private workspace package — it is never published. Depend on it from
another package in this monorepo:

```json
"dependencies": {
  "@occupancy/r49": "workspace:*"
}
```

## Example

```typescript
import { R49Archive, getDPT } from '@occupancy/r49';
import fs from 'node:fs';

// Load and inspect
const archive = await R49Archive.load(fs.readFileSync('layout.r49'));
const manifest = archive.getManifest();
console.log(`Layout: ${manifest.layout.name}, scale ${manifest.layout.scale}`);

// Resolution in dots-per-track, or null if the layout is uncalibrated
const dpt = getDPT(manifest);

// Modify, then write back
manifest.layout.description = 'Updated layout description';
archive.setManifest(manifest);
await archive.addImage('new-shot.jpg', fs.readFileSync('new-shot.jpg'));

fs.writeFileSync('layout.r49', await archive.export());
```

The manifest returned by `getManifest()` is live — mutating it changes what
`export()` writes. `setManifest()` re-validates, so use it when replacing the
manifest wholesale.

## Notes on the format

A v4 manifest carries the layout (name, scale, calibration, sensors), the
camera (resolution, optional model), and the image list. Each image carries its
car labels and a `labeled_complete` flag.

Calibration is a list of reference points, each an image pixel paired with a
world position in mm, plus an optional camera height. `calibrationFit()` fits
them, with the modelling scale, to an image resolution in dots per track;
`getDPT()` and `getDPTResidual()` read from that fit, and an uncalibrated layout
has no DPT. `VALID_SCALES` lists the scales (G, O, S, HO, T, N, Z); the gauge
and the scale-to-ratio table are in `r49.json`.

Only v4 is supported. Loading any other version fails on the version number.

## The data file

`r49.json`, at the package root, holds the format's constants — the standard
gauge, the scale-to-ratio table and the class vocabulary. It is their one
authored home: the package reads them from it and declares none of them in
code (`src/data.ts` only types the parsed file). It is JSON rather than
TypeScript so that readers other than this package can load it — occupancy's
config generator takes the same values from it, and fails when a
`detector.classes` entry names a class the vocabulary does not. See ADR 0018.

JSON carries no comments, so the vocabulary's rules are stated here:

* **The single root is required.** Every stored class is rooted at it
  (`stock.loco.steam`, never `loco.steam`).
* **A nested object is a subtype; any other value is a property** of the class
  it sits under (`width_mm`). That is how the two are told apart without a
  reserved list of key names.
* **Matching is segment by segment** (`isSegmentPrefix`): `stock` is a prefix of
  `stock.loco`, never of `stockyard`.

## Ids

`make_id(nodeId?)` mints the archive, label and sensor ids: a
[Snowflake ID](https://en.wikipedia.org/wiki/Snowflake_ID) encoded in Base-62,
always 11 alphanumeric characters, safe in a filename, a URL or a DOM id, and
roughly time-ordered.

| Bits | Field | Range |
| ---: | :--- | :--- |
| 41 | timestamp, ms since 2024-01-01 | ~69 years |
| 10 | node id | 0–1023 |
| 12 | sequence within the millisecond | 0–4095 |

A node mints 4,096 ids per millisecond and then spins until the clock advances;
distinct `nodeId`s never collide. Ids leak creation time and node, and
`make_id()` throws if the system clock moves backwards rather than risk a
duplicate.

## Rules

Every refusal names the rule it broke (#182). `load()` and `setManifest()`
throw an `R49Error` — an ordinary `Error` whose `message` is for a person and
whose `rule` is for a program — and `imageMismatches()` reports the two image
rules rather than throwing, so a file with a stray image still opens in the
editor that can fix it. Match on `rule`, never on `message`: the ids are the
contract a second implementation and the conformance cases share, and the
wording is free to change.

| Rule | Refused when |
| :--- | :--- |
| `archive/empty` | the bytes are empty |
| `archive/not-zip` | the bytes are not a readable zip |
| `archive/no-manifest` | the zip has no `manifest.json` |
| `manifest/not-json` | `manifest.json` is not strict UTF-8 JSON: it does not parse, holds a byte that is not UTF-8, or starts with a byte-order mark |
| `manifest/version` | `version` is not 4 |
| `manifest/unknown-key` | a key the format does not define, at any depth |
| `manifest/duplicate-id` | two labels in one image, or two sensors, share an id |
| `manifest/provenance` | `provenance` absent or unknown, or `proposed_by` contradicts it |
| `manifest/schema` | any other shape the format does not allow, including a number that is not finite (`1e400` parses as `Infinity`) |
| `images/missing` | the manifest names an image the zip lacks (reported) |
| `images/orphan` | the zip holds an image no entry names (reported) |

When a manifest breaks several, an unknown key is named first — its message,
"may have been written by a newer version… reload the app", is the one a
reader can act on — and otherwise the first issue found.

`CORPUS_RULES` names what the corpus validator blocks on beyond the format
(`path/shape`, `path/slug`, `path/owner`, `archive/id`, `archive/id-collision`,
`labels/provenance`, `labels/class`). Nothing here enforces them; their ids
live beside the format's so `RULES` is the one closed set a refusal can name.
