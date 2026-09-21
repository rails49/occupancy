import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { COMPACT_MAX_HEIGHT_PX, compactStripStyles } from './layout.js';
import { lookTokens, railButtonStyles } from './look.js';
import '@shoelace-style/shoelace/dist/components/icon-button/icon-button.js';
import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';

/**
 * Which tool a click in the viewer means.
 *
 * A closed union rather than a string, because the editor dispatches on it and
 * a fourth tool must be a case to add rather than a fall-through.
 */
export type EditorTool = 'calibration' | 'sensor' | 'car';

/** What a palette selection reports. */
export interface ToolSelectDetail {
  readonly tool: EditorTool;
}

/**
 * One tool's presentation, and whether calibration gates it.
 *
 * One list drives the buttons and the gate, so a tool cannot be rendered
 * enabled and dispatched as disabled — the two would be the same bug the gate
 * exists to prevent, one layer down.
 */
interface ToolSpec {
  readonly tool: EditorTool;
  /** Bootstrap icon name, as Shoelace's `sl-icon-button` takes it. */
  readonly icon: string;
  readonly label: string;
  /**
   * Whether the tool needs a DPT before it can be used.
   *
   * False for calibration alone — it is the tool that *produces* the DPT, so
   * gating it would be a deadlock.
   */
  readonly needsDpt: boolean;
}

const TOOLS: readonly ToolSpec[] = [
  { tool: 'calibration', icon: 'crosshair', label: 'Calibration point', needsDpt: false },
  { tool: 'sensor', icon: 'broadcast-pin', label: 'Sensor', needsDpt: true },
  { tool: 'car', icon: 'train-front', label: 'Car', needsDpt: true },
];

/**
 * Why the gated tools are off, stated where the user is trying to click.
 *
 * The DPT bar already says the archive is uncalibrated; this says what that
 * costs, next to the buttons it costs it at. A disabled control with no reason
 * reads as a broken editor.
 *
 * It names **DPT** rather than the width rectangle. The rectangle is why the
 * *car* tool is gated, but a sensor is a single point and would draw fine
 * uncalibrated — blaming the rectangle would put a false reason on the one tool
 * whose gating is a deliberate deviation. It is also kept to one short line:
 * the column is 100px wide and the strip it becomes on a short window is one
 * row tall, and a paragraph fits neither.
 */
const GATE_REASON = 'Calibrate first — the labeling tools need DPT.';

/**
 * The editor's tool palette, and the calibration gate.
 *
 * Selecting a tool decides what a click in the viewer means; the editor holds
 * the active tool and dispatches on it. **While DPT is unresolved the labeling
 * tools are disabled and the reason is stated** — car width is derived from DPT
 * rather than stored (`SPEC.md` § Location Data), so an uncalibrated archive
 * cannot render the width rectangle that is the only feedback telling a user
 * whether their clicks cover the car. Labeling without it produces a corpus
 * nobody can trust.
 *
 * The gate is on **existence, never on completion** (`SPEC.md` § Labeling
 * Workflow): two calibration points at a nonzero separation — exactly "DPT
 * resolves" — is the whole of it, and every stage stays re-enterable, so
 * `calibrated` going false again disables the tools immediately.
 *
 * > The sensor tool is gated with the car tool, which goes one step beyond
 * > `SPEC.md` § Labeling Workflow ("sensors can be placed at any time"): a
 * > sensor point needs no DPT to draw. Issue #31 asks for both, on the ground
 * > that a sensor placed on an uncalibrated layout answers nothing until the
 * > layout is calibrated anyway. `needsDpt` is per tool so it is one flag to
 * > flip if that is revisited.
 *
 * The `car` tool authors a two-click span through `rr-editor-view` (#32); this
 * element only says which tool a click means.
 *
 * **Properties:** `tool`, `calibrated`.
 *
 * @fires rr-tool-select - A tool was chosen. Detail: {@link ToolSelectDetail}
 */
@customElement('rr-tool-palette')
export class RRToolPalette extends LitElement {
  /** The active tool. The editor owns it; this element only reports changes. */
  @property({ type: String }) tool: EditorTool = 'calibration';
  /** Whether DPT resolves. False disables every gated tool. */
  @property({ type: Boolean }) calibrated = false;

  static styles = [
    lookTokens,
    railButtonStyles,
    css`
    :host {
      display: flex;
      flex-direction: column;
      gap: 0.3em;
      align-items: center;
      user-select: none;
      width: 100%;
      box-sizing: border-box;
      /* Matches rr-toolbar's density (#53). The bottom padding is stated in
         this shorthand rather than on its own line above it, where a
         padding-bottom was being overridden by this very declaration and so
         had never applied. */
      padding: 0 0.3em 0.45em;
    }

    .tool-group {
      display: flex;
      flex-direction: column;
      gap: 0.4em;
      padding: 0.3em 0;
      background-color: var(--rail-group);
      border-radius: 8px;
      width: calc(100% - 8px);
      align-items: center;
    }

    sl-icon-button {
      font-size: 1.85em;
      color: white;
      cursor: pointer;
      transition: transform 0.1s;
    }

    sl-icon-button:hover {
      transform: scale(1.1);
    }

    /* The active tool, which is the one piece of state a palette has to make
       obvious: a click means something different depending on it. */
    sl-icon-button.active::part(base) {
      background: rgba(255, 255, 255, 0.22);
      border-radius: 8px;
    }

    sl-icon-button[disabled] {
      opacity: 0.35;
      cursor: default;
    }

    sl-icon-button[disabled]:hover {
      transform: none;
    }

    .gate-reason {
      /* A literal, like the greens above and the ones in rr-toolbar: this strip
         is explicitly outside the Shoelace palette, and an --sl-* warning token
         is picked for legibility on neutral chrome, not on a dark green. */
      color: #fef3c7;
      font-size: var(--sl-font-size-x-small);
      line-height: 1.35;
      text-align: center;
      padding: 0 0.25em;
    }

  `,

    // The turn itself, shared with rr-toolbar. After the rules above, which is
    // what lets it override them.
    compactStripStyles,

    css`
      @media (max-height: ${COMPACT_MAX_HEIGHT_PX}px) {
        /* Turning moves the reason from under the buttons to beside them. It
           keeps its size — it is a disabled control's stated reason and has to
           stay legible at the size the control is hardest to reach at — and
           spends width instead, capped so it wraps to a second short line
           rather than pushing the strip across the window. */
        .gate-reason {
          text-align: left;
          max-width: 24ch;
        }
      }
    `,
  ];

  private _onSelect(spec: ToolSpec) {
    if (this._disabled(spec) || spec.tool === this.tool) return;
    this.dispatchEvent(
      new CustomEvent<ToolSelectDetail>('rr-tool-select', {
        detail: { tool: spec.tool },
        bubbles: true,
        composed: true,
      })
    );
  }

  private _disabled(spec: ToolSpec): boolean {
    return spec.needsDpt && !this.calibrated;
  }

  render() {
    return html`
      <div class="tool-group">
        ${TOOLS.map(spec => {
          const disabled = this._disabled(spec);
          return html`
            <!-- The tooltip carries the tool's name only. A disabled
                 sl-icon-button takes no pointer events, so a tooltip on one
                 never opens — the gate's reason has to be in the page, which
                 is what .gate-reason below is for. -->
            <sl-tooltip content=${spec.label}>
              <sl-icon-button
                id="tool-${spec.tool}"
                name=${spec.icon}
                label=${spec.label}
                class=${spec.tool === this.tool ? 'active' : ''}
                ?disabled=${disabled}
                aria-pressed=${spec.tool === this.tool ? 'true' : 'false'}
                @click=${() => this._onSelect(spec)}
              ></sl-icon-button>
            </sl-tooltip>
          `;
        })}
      </div>

      ${this.calibrated ? '' : html`<div class="gate-reason">${GATE_REASON}</div>`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-tool-palette': RRToolPalette;
  }

  interface HTMLElementEventMap {
    'rr-tool-select': CustomEvent<ToolSelectDetail>;
  }
}
