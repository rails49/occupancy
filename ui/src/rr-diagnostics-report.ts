import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Frame } from '@occupancy/detector';
import {
  KIND_COLOR,
  KIND_LABEL,
  LABEL_INK,
  describeFinding,
  findingBounds,
} from './diagnostics.js';
import type { ArchiveDiagnostics, Finding, FindingKind, ImageDiagnostics } from './diagnostics.js';
import { matteTokens } from './matte.js';
import './rr-viewer.js';
import '@shoelace-style/shoelace/dist/components/button/button.js';
import '@shoelace-style/shoelace/dist/components/checkbox/checkbox.js';
import '@shoelace-style/shoelace/dist/components/range/range.js';

type SortKey =
  | 'name'
  | 'labels'
  | 'disagreements'
  | 'missed'
  | 'phantom'
  | 'duplicate'
  | 'pose-off'
  | 'conf';

/** Crops per expanded row. Past this the strip is a scroll, not a summary. */
const MAX_CROPS = 8;

const KINDS: readonly FindingKind[] = ['agreed', 'pose-off', 'missed', 'phantom', 'duplicate'];

/**
 * The archive-level diagnostics report: scorecard, one sortable row per image,
 * and a crop strip behind each row (#87).
 *
 * The **document** half of the diagnostics mode — it answers "how is the model
 * doing on this corpus" and is what the mode opens to. Judging a single
 * disagreement is the queue's job, reached from a row.
 *
 * **The wording is "agreed", never "accurate".** The percentage describes this
 * archive against this model; `SPEC.md` § Accuracy makes a generalization
 * estimate a property of a held-out protocol that does not exist yet, and a
 * tile reading "accuracy" would be a claim nothing here can support.
 *
 * **Properties:** `diagnostics`, `imageUrls`, `dpt`, `resolution`, `threshold`,
 * `sweeping`.
 *
 * @fires rr-diagnostics-threshold - Confidence floor moved. Detail: { value }
 * @fires rr-diagnostics-review - A row's Review was pressed. Detail: { filename }
 */
@customElement('rr-diagnostics-report')
export class RRDiagnosticsReport extends LitElement {
  @property({ attribute: false }) diagnostics: ArchiveDiagnostics | null = null;
  @property({ attribute: false }) imageUrls: ReadonlyMap<string, string> = new Map();
  @property({ attribute: false }) dpt: number | null = null;
  @property({ attribute: false }) resolution: Frame = { width: 1920, height: 1080 };
  @property({ type: Number }) threshold = 0.25;
  /** True while inference is still running, so the numbers are partial. */
  @property({ type: Boolean }) sweeping = false;

  @state() private _sort: SortKey = 'disagreements';
  @state() private _expanded: string | null = null;
  @state() private _onlyDisagreements = false;

  static styles = [
    matteTokens,
    css`
    :host {
      display: block;
      overflow-y: auto;
      background: var(--sl-color-neutral-0);
      color: var(--sl-color-neutral-900);
      font: 13px/1.45 var(--sl-font-sans, system-ui), sans-serif;
    }

    .scorecard {
      display: flex;
      flex-wrap: wrap;
      gap: 0.6rem;
      padding: 1.1rem 1.25rem 0.9rem;
    }

    .tile {
      flex: 1 1 9rem;
      background: var(--sl-color-neutral-50);
      border: 1px solid var(--sl-color-neutral-200);
      border-top: 3px solid var(--tint, var(--sl-color-neutral-400));
      border-radius: 6px;
      padding: 0.6rem 0.75rem;
    }

    /* A finding's colour as **text**, pushed toward the pane's own ink far
       enough to read on it. The kinds are one vocabulary shared with the boxes
       drawn on the photograph (diagnostics.ts § KIND_COLOR), where a
       saturated mid-tone is right against any image — but the same mid-tone as
       small text on a white pane is not, and amber sets the number: #ffb300 is
       1.9:1 on white and 4.1:1 once mixed. --sl-color-neutral-1000 is black
       in the light theme and white in the dark one, so one declaration darkens
       it under one preference and lightens it under the other. A swatch, a bar
       segment and a border take the colour undiluted — a filled shape carries
       at any lightness, and diluting it would put two greens on one screen. */
    .tile .n,
    .crop .cap b,
    td.kind {
      color: color-mix(in srgb, var(--tint, var(--kind)) 65%, var(--sl-color-neutral-1000));
    }

    .tile .n {
      font-size: 1.9rem;
      font-weight: 700;
      line-height: 1.1;
      font-variant-numeric: tabular-nums;
    }

    .tile .t {
      color: var(--sl-color-neutral-600);
      font-size: 0.75rem;
    }

    .bar {
      display: flex;
      height: 0.75rem;
      margin: 0 1.25rem 0.4rem;
      border-radius: 6px;
      overflow: hidden;
      background: var(--sl-color-neutral-200);
    }

    .legend {
      margin: 0 1.25rem 0.75rem;
      color: var(--sl-color-neutral-600);
      font-size: 0.75rem;
      display: flex;
      gap: 0.9rem;
      flex-wrap: wrap;
      align-items: center;
    }

    .legend i {
      display: inline-block;
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 2px;
      margin-right: 0.3rem;
    }

    .flag {
      color: var(--sl-color-warning-800);
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 1.5rem;
      margin: 0 1.25rem 0.75rem;
      padding: 0.6rem 0.75rem;
      background: var(--sl-color-neutral-50);
      border: 1px solid var(--sl-color-neutral-200);
      border-radius: 6px;
      flex-wrap: wrap;
    }

    sl-range {
      flex: 1 1 14rem;
      --track-color-active: var(--sl-color-primary-600);
    }

    .table-wrap {
      overflow-x: auto;
      margin: 0 1.25rem 2.5rem;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      /* Fixed, or an expanded crop strip widens the table and shoves the
         right-hand columns out of view. */
      table-layout: fixed;
      min-width: 44rem;
    }

    th {
      text-align: right;
      padding: 0.45rem 0.6rem;
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--sl-color-neutral-600);
      border-bottom: 1px solid var(--sl-color-neutral-200);
      cursor: pointer;
      white-space: nowrap;
      user-select: none;
    }

    th:first-child,
    td:first-child {
      text-align: left;
      width: 32%;
    }

    th:last-child,
    td:last-child {
      text-align: center;
      width: 5.5rem;
    }

    th[aria-sort] {
      color: var(--sl-color-primary-600);
    }

    td {
      text-align: right;
      padding: 0.35rem 0.6rem;
      border-bottom: 1px solid var(--sl-color-neutral-100);
      font-variant-numeric: tabular-nums;
    }

    tr.row:hover td {
      background: var(--sl-color-neutral-50);
    }

    tr.row[data-open='true'] td {
      background: var(--sl-color-neutral-100);
    }

    .name {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      cursor: pointer;
    }

    .name img {
      width: 2.1rem;
      height: 1.6rem;
      object-fit: cover;
      border-radius: 3px;
      background: var(--photo-matte);
      flex-shrink: 0;
    }

    .zero {
      color: var(--sl-color-neutral-500);
    }

    .strong {
      font-weight: 700;
    }

    .crops td {
      padding: 0 0.6rem 0.9rem;
      background: var(--sl-color-neutral-50);
    }

    .crop-strip {
      display: flex;
      gap: 0.6rem;
      overflow-x: auto;
      padding: 0.75rem 0 0.25rem;
    }

    .crop {
      width: 13rem;
      flex-shrink: 0;
      border: 1px solid var(--sl-color-neutral-200);
      border-top: 3px solid var(--kind, var(--sl-color-neutral-400));
      border-radius: 5px;
      overflow: hidden;
      background: var(--photo-matte);
      text-align: left;
    }

    .crop rr-viewer {
      display: block;
      height: 7.4rem;
    }

    .crop .cap {
      padding: 0.3rem 0.45rem;
      background: var(--sl-color-neutral-50);
    }

    .crop .cap b {
      display: block;
      font-size: 0.75rem;
    }

    .crop .cap span {
      color: var(--sl-color-neutral-600);
      font-size: 0.7rem;
    }

    .empty {
      padding: 2.5rem;
      text-align: center;
      color: var(--sl-color-neutral-600);
    }
  `,
  ];

  private _sorted(images: readonly ImageDiagnostics[]): ImageDiagnostics[] {
    const rows = this._onlyDisagreements ? images.filter(i => i.disagreements > 0) : [...images];
    const key = this._sort;
    return rows.sort((a, b) => {
      switch (key) {
        case 'name':
          return a.filename.localeCompare(b.filename);
        case 'labels':
          return b.labels.length - a.labels.length;
        // Lowest first: the weakest box in the archive is the one that decides
        // where a threshold should sit, so it belongs at the top.
        case 'conf':
          return (a.worstConfidence ?? 2) - (b.worstConfidence ?? 2);
        case 'disagreements':
          return b.disagreements - a.disagreements;
        default:
          return b.counts[key] - a.counts[key];
      }
    });
  }

  private _header(key: SortKey, text: string) {
    // `nothing`, not `undefined`: an attribute binding set to `undefined`
    // renders `aria-sort=""` rather than removing the attribute, so the
    // `th[aria-sort]` rule below matched every sortable column at once and the
    // sorted column was indistinguishable. `nothing` is the only value that
    // removes an attribute — and an empty `aria-sort` is invalid ARIA besides.
    return html`<th
      aria-sort=${this._sort === key ? 'descending' : nothing}
      @click=${() => {
        this._sort = key;
      }}
    >
      ${text}
    </th>`;
  }

  private _renderCrop(image: ImageDiagnostics, finding: Finding) {
    const url = this.imageUrls.get(image.filename) ?? null;
    return html`
      <div class="crop" style="--kind:${KIND_COLOR[finding.kind]}">
        <rr-viewer
          .src=${url}
          .cars=${finding.label ? [finding.label] : []}
          .carInks=${[finding.kind === 'missed' ? KIND_COLOR.missed : LABEL_INK]}
          .detections=${finding.detection ? [finding.detection] : []}
          .detectionInks=${[KIND_COLOR[finding.kind]]}
          .dpt=${this.dpt}
          .resolution=${this.resolution}
          .zoom=${this.dpt === null ? null : findingBounds(finding, this.dpt, this.resolution)}
        ></rr-viewer>
        <div class="cap">
          <b>${KIND_LABEL[finding.kind]}</b><span>${describeFinding(finding)}</span>
        </div>
      </div>
    `;
  }

  render() {
    const diagnostics = this.diagnostics;
    if (!diagnostics || diagnostics.images.length === 0) {
      return html`<div class="empty">
        ${this.sweeping ? 'Scoring the first images…' : 'This layout has no images to check.'}
      </div>`;
    }

    const total = KINDS.reduce((sum, kind) => sum + diagnostics.counts[kind], 0);
    const agreedPct = diagnostics.labels
      ? (diagnostics.counts.agreed / diagnostics.labels) * 100
      : 0;

    return html`
      <div class="scorecard">
        <div class="tile" style="--tint:var(--sl-color-neutral-900)">
          <div class="n">${diagnostics.images.length}</div>
          <div class="t">images · ${diagnostics.labels} labels</div>
        </div>
        <div class="tile" style="--tint:${KIND_COLOR.agreed}">
          <div class="n">${agreedPct.toFixed(0)}%</div>
          <!-- "agreed", never "accurate" — see the class comment. -->
          <div class="t">of labels agreed (${diagnostics.counts.agreed})</div>
        </div>
        <div class="tile" style="--tint:${KIND_COLOR.missed}">
          <div class="n">${diagnostics.counts.missed}</div>
          <div class="t">missed cars</div>
        </div>
        <div class="tile" style="--tint:${KIND_COLOR.phantom}">
          <div class="n">${diagnostics.counts.phantom}</div>
          <div class="t">phantom boxes</div>
        </div>
        <div class="tile" style="--tint:${KIND_COLOR.duplicate}">
          <div class="n">${diagnostics.counts.duplicate}</div>
          <!-- Its own tile, not folded into phantoms: a duplicate is the model
               seeing one car twice, which is a different fault with a different
               fix than seeing a car that is not there. -->
          <div class="t">duplicate boxes</div>
        </div>
        <div class="tile" style="--tint:${KIND_COLOR['pose-off']}">
          <div class="n">${diagnostics.counts['pose-off']}</div>
          <div class="t">poses off</div>
        </div>
      </div>

      <div class="bar">
        ${KINDS.map(
          kind => html`<span
            style="width:${total ? (diagnostics.counts[kind] / total) * 100 : 0}%;background:${KIND_COLOR[
              kind
            ]}"
          ></span>`
        )}
      </div>

      <div class="legend">
        ${KINDS.map(
          kind => html`<span><i style="background:${KIND_COLOR[kind]}"></i>${KIND_LABEL[kind]}</span>`
        )}
        ${diagnostics.incompleteImages > 0
          ? html`<span class="flag"
              >⚠ ${diagnostics.incompleteImages}
              image${diagnostics.incompleteImages === 1 ? '' : 's'} not marked labeled complete —
              a phantom there may be a car nobody has labelled</span
            >`
          : ''}
      </div>

      <div class="controls">
        <sl-range
          label="Confidence floor"
          min="5"
          max="95"
          step="1"
          value=${Math.round(this.threshold * 100)}
          .tooltipFormatter=${(value: number) => `${value}%`}
          @sl-input=${(e: Event) => {
            const value = Number((e.target as HTMLInputElement).value) / 100;
            this.dispatchEvent(
              new CustomEvent('rr-diagnostics-threshold', {
                detail: { value },
                bubbles: true,
                composed: true,
              })
            );
          }}
        ></sl-range>
        <sl-checkbox
          ?checked=${this._onlyDisagreements}
          @sl-change=${(e: Event) => {
            this._onlyDisagreements = (e.target as HTMLInputElement).checked;
          }}
          >Only images with disagreements</sl-checkbox
        >
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              ${this._header('name', 'Image')} ${this._header('labels', 'Labels')}
              ${this._header('disagreements', 'Disagree')} ${this._header('missed', 'Missed')}
              ${this._header('phantom', 'Phantom')} ${this._header('duplicate', 'Duplicate')}
              ${this._header('pose-off', 'Pose off')} ${this._header('conf', 'Lowest conf')}
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            ${this._sorted(diagnostics.images).map(image => this._renderRow(image))}
          </tbody>
        </table>
      </div>
    `;
  }

  private _renderRow(image: ImageDiagnostics) {
    const open = this._expanded === image.filename;
    const cell = (n: number, kind: FindingKind) =>
      html`<td class=${n === 0 ? 'zero' : 'kind'} style=${n ? `--kind:${KIND_COLOR[kind]}` : ''}>
        ${n}
      </td>`;
    const disagreeing = image.findings.filter(f => f.kind !== 'agreed');

    return html`
      <tr class="row" data-open=${String(open)}>
        <td>
          <div
            class="name"
            @click=${() => {
              this._expanded = open ? null : image.filename;
            }}
          >
            <img src=${this.imageUrls.get(image.filename) ?? ''} alt="" />
            <span
              >${image.filename}
              ${image.labeledComplete ? '' : html`<span class="flag">⚠ incomplete</span>`}</span
            >
          </div>
        </td>
        <td>${image.labels.length}</td>
        <td class=${image.disagreements ? 'strong' : 'zero'}>
          ${image.disagreements}
        </td>
        ${cell(image.counts.missed, 'missed')} ${cell(image.counts.phantom, 'phantom')}
        ${cell(image.counts.duplicate, 'duplicate')}
        ${cell(image.counts['pose-off'], 'pose-off')}
        <td class=${image.worstConfidence === null ? 'zero' : ''}>
          ${image.worstConfidence === null ? '—' : `${Math.round(image.worstConfidence * 100)}%`}
        </td>
        <td>
          <sl-button
            size="small"
            variant="default"
            ?disabled=${image.disagreements === 0}
            @click=${() =>
              this.dispatchEvent(
                new CustomEvent('rr-diagnostics-review', {
                  detail: { filename: image.filename },
                  bubbles: true,
                  composed: true,
                })
              )}
            >Review</sl-button
          >
        </td>
      </tr>
      ${open
        ? html`<tr class="crops">
            <td colspan="9">
              <div class="crop-strip">
                ${disagreeing.length === 0
                  ? html`<div class="empty">Every label on this image agreed.</div>`
                  : disagreeing
                      .slice(0, MAX_CROPS)
                      .map(finding => this._renderCrop(image, finding))}
                ${disagreeing.length > MAX_CROPS
                  ? html`<div class="empty">
                      +${disagreeing.length - MAX_CROPS} more — open Review
                    </div>`
                  : ''}
              </div>
            </td>
          </tr>`
        : ''}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'rr-diagnostics-report': RRDiagnosticsReport;
  }
}
