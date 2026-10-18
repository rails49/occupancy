# @occupancy/classifier

Runs the trained occupancy CNN over a layout photograph. Given a point on the
image and the image's resolution, it crops a patch around that point, scales it
to what the model was trained on, and returns the labels it detects there —
typically some combination of `track`, `train`, `coupling`, and `other`.

The model itself is an ONNX file produced by `classifier/resnet/`, shipped with
a `config.json` describing its input geometry and normalization.

## Interface

Three entry points, each with its own surface:

| Import | Provides |
| :--- | :--- |
| `@occupancy/classifier` | `ClassifierConfig` — the model config both classifiers take |
| `@occupancy/classifier/browser` | `BrowserClassifier` — ONNX Runtime Web, crops via `<canvas>` |
| `@occupancy/classifier/node` | `NodeClassifier` — ONNX Runtime Node, crops via `sharp` |

The split is deliberate and load-bearing: importing the root entry point never
pulls `onnxruntime-node` or `sharp` into a browser bundle. Import the platform
you are on, not the root.

See [`src/index.ts`](src/index.ts) for the root surface. Anything not exported
from an entry point is internal and may change without notice. Per-symbol
documentation lives on the declarations in `src/base.ts`, `src/browser.ts`, and
`src/node.ts`, where your editor will show it on hover.

The convention and the reasoning behind it are in [`../CLAUDE.md`](../CLAUDE.md).

## Use it

This is a private workspace package — it is never published. Depend on it from
another package in this monorepo:

```json
"dependencies": {
  "@occupancy/classifier": "workspace:*"
}
```

## Example

In the browser:

```typescript
import { BrowserClassifier } from '@occupancy/classifier/browser';
import type { ClassifierConfig } from '@occupancy/classifier';

const config: ClassifierConfig = await (await fetch('/models/config.json')).json();
const classifier = new BrowserClassifier(config);
await classifier.load('/models/model_int8.ort');

// `image` is anything drawable: <img>, <video>, ImageBitmap, canvas.
const labels = await classifier.classify(image, { x: 512, y: 300 }, imageDpt);
// => ['track', 'train']

await classifier.release();
```

In Node the shape is identical; only the import and the inputs differ —
`NodeClassifier.load()` takes a path to the model, and `classify()` takes a
`Buffer` or a `sharp` pipeline.

## The dpt argument

`classify()` needs to know the image's resolution in **dots per track** — how
many pixels span one track gauge. That is what lets it crop the same physical
area regardless of camera distance or layout scale.

Get it from the layout manifest with `getDPT()` in `@rails49/r49`. The value
in `ClassifierConfig.dpt` is the resolution the *model* was trained at; the
classifier scales between the two. Passing a wrong `img_dpt` silently produces
poor predictions rather than an error, so it is worth getting right.

## Notes

Classification is multi-label, not multi-class: every label whose probability
reaches 0.5 is returned, so the result may be empty or hold several labels.

`classify()` returns `[]` if no model has been loaded — it does not throw. The
constructor, by contrast, validates `ClassifierConfig` strictly and throws on a
malformed one.
