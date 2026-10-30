# L1 is geometry over L0, biased toward occupied

*Amended by [ADR 0023](0023-occupied-has-a-two-gauge-margin.md).*

Occupancy is reported in two layers. L0 is every detection as the model emitted it. L1 is each sensor's state, computed from L0 by testing whether the sensor lies strictly inside a detection's oriented box, with the box's width replaced by the car width. L1 calls no second model, so it cannot contradict the boxes drawn beside it.

Errors lean toward occupied. Any covering detection counts, low-confidence ones included, and the car width replaces the predicted width because an under-predicted width is the unsafe direction. A miss costs a collision; a phantom costs a blocked route, and that was accepted, including the deadlock a persistent phantom can cause in a controller's schedule. Unknown means the system could not look; it is never a confidence outcome. Clear carries no confidence.

Decided in [#7](https://github.com/rails49/occupancy/issues/7).
