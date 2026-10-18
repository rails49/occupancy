# v4 only, and an optional field adds no version

*Superseded by [rails49/r49 ADR 0008](https://github.com/rails49/r49/blob/main/docs/adr/0008-v4-only-and-optional-fields-add-no-version.md).*

`@occupancy/r49` reads and writes manifest version 4 and nothing else. A v3 point marker has neither extent nor orientation, so it cannot be migrated; the six fixtures were converted once by a script that was then deleted. Every schema object is strict, so unknown keys are rejected rather than stripped, because stripping them would delete what a newer build wrote at the next save.

The version changes only when an old file would be misread or a new file would lose data. An added optional field, such as `camera_height_mm`, does neither, and with `version` a literal and no compatibility code, a bump would make every v4 archive fail to load. Optional fields take no zod `.default()`, which would write the key on the first save of any archive opened.

Decided in [#8](https://github.com/rails49/occupancy/issues/8) and [#139](https://github.com/rails49/occupancy/issues/139).
