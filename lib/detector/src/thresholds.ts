import { DETECTOR_CONFIDENCE_THRESHOLD, MIN_DPT as LAYOUT_MIN_DPT } from '@occupancy/config';

/**
 * The DPT below which a car is too few pixels across for this detector to
 * place it reliably. The editor warns below it and never blocks.
 *
 * The detector's requirement, not the format's: `@rails49/r49` warns below its
 * own recommended DPT, and this is set separately (ADR 0018). Authored as
 * `layout.min_dpt` in `config.yaml` until the split (ADR 0019).
 */
export const MIN_DPT: number = LAYOUT_MIN_DPT;

/**
 * The confidence below which `detect` drops a detection, unless a call
 * overrides it with `minConfidence`. The live view takes the default, and the
 * diagnostics view reports at this value until its user moves the threshold.
 *
 * A placeholder: setting it needs held-out recall, which nothing measures
 * (ADR 0007). Authored as `detector.confidence_threshold` in `config.yaml`,
 * which the ONNX exporter reads too, until the split (ADR 0019).
 */
export const CONFIDENCE_THRESHOLD: number = DETECTOR_CONFIDENCE_THRESHOLD;
