/**
 * Which tool a click in the viewer means.
 *
 * A closed union rather than a string, because the editor dispatches on it and
 * a fourth tool must be a case to add rather than a fall-through.
 */
export type EditorTool = 'calibration' | 'sensor' | 'car' | 'centerline';

/**
 * One tool's presentation, and whether calibration gates it.
 *
 * One list drives the rail's buttons and the session's gate, so a tool cannot be
 * rendered enabled and dispatched as disabled — the two would be the same bug
 * the gate exists to prevent, one layer down.
 */
export interface ToolSpec {
  readonly tool: EditorTool;
  /** Bootstrap icon name. */
  readonly icon: string;
  readonly label: string;
  /**
   * Whether the tool needs a DPT before it can be used.
   *
   * False for calibration alone — it is the tool that *produces* the DPT, so
   * gating it would be a deadlock.
   *
   * > The sensor tool is gated with the car tool, which goes one step beyond
   * > `SPEC.md` § Labeling Workflow ("sensors can be placed at any time"): a
   * > sensor point needs no DPT to draw. Issue #31 asks for both, on the ground
   * > that a sensor placed on an uncalibrated layout answers nothing until the
   * > layout is calibrated anyway. This flag is per tool so it is one flag to
   * > flip if that is revisited.
   */
  readonly needsDpt: boolean;
  /**
   * Whether the tool needs the image on screen to be labeled complete.
   *
   * True for the centerline tool alone, and it is the one gate that depends on
   * the **image** rather than on the archive: tracing stops before track under a
   * car, and a car it does not know about is a car it would trace straight
   * through. `labeled_complete` is the only claim that every car on an image is
   * labeled (`SPEC.md` § Labeling completeness), so it is the only honest
   * precondition.
   *
   * The asymmetry that follows is in `EditSession._settle`: a DPT-gated tool
   * drops back to calibration, because nothing the user does to the *image* can
   * recover it, while this gate is recovered by selecting another image — and
   * dropping the tool here would end a run the moment it switched images, which
   * is exactly what tracing a run across several images requires.
   */
  readonly needsLabeledComplete: boolean;
}

export const TOOLS: readonly ToolSpec[] = [
  {
    tool: 'calibration',
    icon: 'crosshair',
    label: 'Calibration point',
    needsDpt: false,
    needsLabeledComplete: false,
  },
  {
    tool: 'sensor',
    icon: 'broadcast-pin',
    label: 'Sensor',
    needsDpt: true,
    needsLabeledComplete: false,
  },
  { tool: 'car', icon: 'train-front', label: 'Car', needsDpt: true, needsLabeledComplete: false },
  {
    tool: 'centerline',
    icon: 'bezier2',
    label: 'Track centerline',
    needsDpt: true,
    needsLabeledComplete: true,
  },
];

/**
 * Why the gated tools are off: the tooltip of each disabled tool.
 *
 * It names **DPT** rather than the width rectangle. The rectangle is why the
 * *car* tool is gated, but a sensor is a single point and would draw fine
 * uncalibrated — blaming the rectangle would put a false reason on the one tool
 * whose gating is a deliberate deviation.
 */
export const GATE_REASON = 'Calibrate first — the labeling tools need DPT.';

/**
 * Why the centerline tool is off on an image that is not labeled complete.
 *
 * It names the flag rather than the tracing rule, because the flag is what the
 * person can act on: the checkbox under the photograph is one click away, and
 * "every car labeled" is what ticking it claims.
 */
export const COMPLETE_REASON =
  'Mark this image labeled complete first — tracing must know where the cars are.';
