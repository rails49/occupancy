# Image change does not decide occupancy

Change detection is not used to decide occupancy. A change detector must adapt its reference image to lighting, but not while a train stands still, and the only rule that does both ties adaptation to the occupancy decision itself: a false trip then persists, and a missed train becomes background. Re-implemented against `lighting.r49`, EX-SensorCAM's metric false-tripped on every sample of a patch of bare table.

Change detection is still used where an error costs a warning, as in drift detection. The analysis is in `docs/research/image-change-detection.md`.
