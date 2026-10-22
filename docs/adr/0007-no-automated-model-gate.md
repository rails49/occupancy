# No automated model gate

*Superseded by [rails49/detector ADR 0007](https://github.com/rails49/detector/blob/main/docs/adr/0007-no-automated-model-gate.md).*

No test checks a model's accuracy. The CNN regression test and its 99.5% gate were retired with the v4 conversion: v4 deletes the point markers it iterated, and most of its samples had been seen in training, so it measured reproducibility, not generalization. Nothing replaces it until a held-out protocol exists on a higher-DPT corpus; a substitute gate would report a number that predicts nothing. `bin/test.sh` runs on a clean clone with no model present.

Decided in [#8](https://github.com/rails49/occupancy/issues/8) and [#17](https://github.com/rails49/occupancy/issues/17).
