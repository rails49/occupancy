# config.yaml is authored, and detector.classes is append-only

*Superseded by [rails49/detector ADR 0009](https://github.com/rails49/detector/blob/main/docs/adr/0009-config-yaml-is-authored-and-classes-is-append-only.md).*

`config.yaml` is the one authored source for values that must agree across stages. `config.json` and `lib/config` are generated from it and never edited by hand; `lib/config` is committed so a fresh clone typechecks before any generator runs.

`detector.classes` is append-only. A list position is a YOLO class index, so reordering or deleting an entry invalidates trained weights while the file still validates. A label maps to the longest entry in `classes` that is a dotted prefix of its class, so adding a subclass needs no relabeling.

Decided in [#8](https://github.com/rails49/occupancy/issues/8).
