# One model in the live path

The live view loads one model, the YOLO26n-OBB detector. L1 is computed from the detector's boxes, which leaves the CNN classifier with no consumer there. The classifier package, `TRAIN.ipynb` and the crop derivation are kept so the classifier stays retrainable, but nothing loads it.

Decided in [#7](https://github.com/rails49/occupancy/issues/7).
