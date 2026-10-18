# @occupancy/r49

Reads and writes `.r49` railroad layout archives — a zip holding a
`manifest.json` plus the layout photographs it describes. This is the format
`ui/` opens and saves, and the one `dataset/` reads when preparing training
data.

Manifests are validated against the v3 schema on load, so a successfully loaded
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

A v3 manifest carries the layout (name, scale, optional calibration), the
camera (resolution, optional model), and the image list with per-image labels.

Calibration is two points `p0`/`p1` and the physical distance `size_mm` between
them. That, combined with the modelling scale, is what `getDPT()` turns into an
image resolution the classifier can scale its crops against — so an uncalibrated
layout classifies poorly. `getGauge()` and `Scale2Number` expose the scale table
(G, O, S, HO, T, N, Z) if you need the arithmetic yourself.

Only v3 is supported. Earlier archives are not readable.

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
