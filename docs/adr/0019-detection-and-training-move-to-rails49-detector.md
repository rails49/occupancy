# Detection and training move to rails49/detector

Resolves [#228](https://github.com/rails49/occupancy/issues/228). Supersedes [ADR 0018](0018-the-r49-format-is-defined-in-rails49-r49.md).

This repository keeps the UI: the editor that creates, edits and views `.r49` archives, and the live view. The detector, its training, the classifier and the training-data export move to `rails49/detector`, which publishes the model and its browser runtime together as `@rails49/detector`. The interface between the two is narrow, but it cannot be the model file alone. The runtime has to match training in letterbox, decode, duplicate-box removal, resampling and tiling, and the car box the editor draws (`carWidthPx`, `spanToPolygon`) is the box the model is trained to output. So `lib/detector` moves with the training code, and the package is all this repository depends on.

What moves: `dataset/`, `detector/`, `classifier/`, `lib/detector` and `lib/classifier`; the `detector.*`, `cnn.*` and `classifier.*` parameters; `layout.standard_width`, because it sets the trained box; `layout.min_dpt`, because it is the detector's requirement; and the config generator with its checks that `detector.classes` is append-only and in the vocabulary. ADRs 0003, 0007, 0009 and 0014 move and keep their numbers there. ADR 0001 is copied.

What stays: the UI, `lib/drift`, `tools/drift-bench`, and `occupancy()` with `SensorState`. Sensors are authored in the editor, training never calls `occupancy()`, and [ADR 0005](0005-l1-is-geometry-over-l0-biased-toward-occupied.md)'s bias toward occupied is a rule about what this app reports. The editor reads `MIN_DPT` and the diagnostics view reads `CONFIDENCE_THRESHOLD` from the package. `config.yaml`, its generator and `lib/config` are deleted: the drift tolerance ([ADR 0013](0013-drift-is-measured-against-the-first-image.md)) is the only parameter left, and it becomes a constant in the UI. The vocabulary comes from `@rails49/r49`.

The package carries the `.ort` model, so one version pins the runtime and the weights, and exposes it through an `exports` entry that the UI build copies. `onnxruntime-web` is a peer dependency, so the runtime's JavaScript and the WASM files this app serves from origin ([ADR 0006](0006-the-onnx-runtime-ships-from-origin.md)) are one version. Releases without a model are `0.0.x`. The first release with a model is `0.1.0`, and it waits for a model measured on held-out images ([ADR 0007](0007-no-automated-model-gate.md)). Until then the deployed live view reports every sensor `unknown`.

`rails49/r49` owns the `.r49` format. This repository and `rails49/detector` each depend on `@rails49/r49` pinned to a version, so a format change is a release there followed by a version bump in each. Readers and writers keep rejecting unknown keys, so a reader on an older version refuses a newer archive until it upgrades. [ADR 0002](0002-the-repository-stays-public.md) is retired: r49's CI no longer checks out this repository.

`rails49/detector` is AGPL-3.0 because the weights derive from an AGPL checkpoint ([rails49/detector ADR 0015](https://github.com/rails49/detector/tree/main/docs/adr)). This repository is MIT; its deploy serves those weights, and the site points to rails49/detector as their source.

## Considered options

- Hand over only the `.ort` file. The browser runtime would be a second copy of training's arithmetic, kept in step by hand.
- One repository per model. `dataset/` feeds both and the classifier is parked, so a second repository adds release overhead and nothing else.
- Publish the model as a GitHub Release asset. The build would need a download step and a second version to keep in step with the package.
- Publish the model trained on the 46 fixture images as a prerelease, so the site keeps showing detections. It would put a model nothing has measured in front of users.
- Keep `occupancy()` in the package. Training never calls it, and sensors are this repository's.
