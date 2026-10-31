/**
 * Which tool a click in the viewer means.
 *
 * A closed union rather than a string, because the editor dispatches on it and
 * a fourth tool must be a case to add rather than a fall-through.
 */
export type EditorTool = 'calibration' | 'sensor' | 'car' | 'track';

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
}

export const TOOLS: readonly ToolSpec[] = [
  { tool: 'calibration', icon: 'crosshair', label: 'Calibration point', needsDpt: false },
  { tool: 'sensor', icon: 'broadcast-pin', label: 'Sensor', needsDpt: true },
  { tool: 'car', icon: 'train-front', label: 'Car', needsDpt: true },
  { tool: 'track', icon: 'bezier2', label: 'Track', needsDpt: true },
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
