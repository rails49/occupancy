import { driftVerdict } from './driftSession.js';

/**
 * One live-view drift sample, as a CSV row (#217).
 *
 * `tolerancePx`, `dpt` and `past` are `null` on an uncalibrated layout, where no
 * verdict resolves; `streamWidth` and `streamHeight` are whatever the camera
 * track reports.
 */
export interface DriftRow {
  time: string;
  px: number;
  tolerancePx: number | null;
  dpt: number | null;
  past: boolean | null;
  overridden: boolean;
  streamWidth: number | null;
  streamHeight: number | null;
}

/** CSV header and the row field under it, in column order. */
const COLUMNS: readonly [string, keyof DriftRow][] = [
  ['time', 'time'],
  ['px', 'px'],
  ['tolerance_px', 'tolerancePx'],
  ['dpt', 'dpt'],
  ['past', 'past'],
  ['overridden', 'overridden'],
  ['stream_width', 'streamWidth'],
  ['stream_height', 'streamHeight'],
];

/** A row for a sample taken at `at`, judged by the same `driftVerdict` as the refusal. */
export function driftRow(
  at: Date,
  px: number,
  dpt: number | null,
  overridden: boolean,
  stream: Pick<MediaTrackSettings, 'width' | 'height'>,
): DriftRow {
  const verdict = driftVerdict(px, dpt);
  return {
    time: at.toISOString(),
    px,
    tolerancePx: verdict?.tolerancePx ?? null,
    dpt: verdict ? dpt : null,
    past: verdict?.past ?? null,
    overridden,
    streamWidth: stream.width ?? null,
    streamHeight: stream.height ?? null,
  };
}

/** The rows as CSV text, header first; a `null` is an empty cell. */
export function driftCsv(rows: readonly DriftRow[]): string {
  const header = COLUMNS.map(([name]) => name).join(',');
  const lines = rows.map(row =>
    COLUMNS.map(([, key]) => (row[key] === null ? '' : String(row[key]))).join(','),
  );
  return [header, ...lines].map(line => `${line}\n`).join('');
}

/** `drift-20261018-090507.csv`, in local time, from when the recording started. */
export function driftCsvName(started: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${started.getFullYear()}${pad(started.getMonth() + 1)}${pad(started.getDate())}` +
    `-${pad(started.getHours())}${pad(started.getMinutes())}${pad(started.getSeconds())}`;
  return `drift-${stamp}.csv`;
}

/** Hand the rows to the browser as a CSV download. */
export function downloadDriftCsv(rows: readonly DriftRow[], filename: string): void {
  const url = URL.createObjectURL(new Blob([driftCsv(rows)], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
