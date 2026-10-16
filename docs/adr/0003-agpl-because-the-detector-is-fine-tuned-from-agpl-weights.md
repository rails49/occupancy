# AGPL-3.0, because the detector is fine-tuned from AGPL weights

The project, including its trained weights, is AGPL-3.0. The detector is fine-tuned from the Ultralytics YOLO26 DOTA checkpoint, which is AGPL-3.0. With 46 images it cannot be trained from random initialisation, so the weights derive from a licensed work, and the client-side app distributes them to every visitor. Keeping the code MIT and licensing the weights separately was rejected: both are served from one site as one product.

The licence follows the detector family and is revisited only if that changes. Decided in [#10](https://github.com/rails49/occupancy/issues/10).
