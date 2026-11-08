/**
 * This page's reader for the live contract, which `occupancy-service`'s
 * `LIVE.md` states (#331). It is the only file here that names a path, a part
 * or a field of the contract. `occupancyService.ts` runs the loop over it and
 * `rr-app` runs {@link findService}.
 *
 * {@link readLatest} throws a {@link LiveError} naming what was wrong with an
 * answer, and the caller turns that into `unknown` for every sensor.
 */

import type { Detection } from '@rails49/detector';

/** Where a service answers, on the page's own origin (ADR 0006). One constant, not a setting. */
export const LIVE_BASE = '/live';

/** The only `version` of the contract this page reads. Any other is a failed request. */
export const LIVE_VERSION = 1;

/**
 * How long to wait for a complete `latest` answer before calling the request
 * failed. `latest` with `after` waits up to about 1 s at the service.
 */
export const LATEST_TIMEOUT_MS = 5000;

/** One sensor's state as the service publishes it. */
export type LiveSensorState =
  | { readonly state: 'occupied'; readonly confidence: number }
  | { readonly state: 'clear' }
  | { readonly state: 'unknown'; readonly reason: string };

/**
 * L0 for the newest frame the service inferred, which may be earlier than the
 * frame served. Both times are the service's clock.
 *
 * `detections` is `Detection`, in `camera.resolution` pixels. `LIVE.md` leaves
 * everything in `l0` but its id and time to rails49/occupancy-service#8, so
 * `detections` may be absent; then no boxes are drawn and no cars counted.
 */
export interface LiveL0 {
  readonly frame_id: string;
  readonly captured_at: string;
  readonly detections?: readonly Detection[];
}

/**
 * The JSON part of a `latest` answer, as `LIVE.md` § The JSON part states it.
 *
 * With no frame, `frame_id` and `captured_at` are `null` and every sensor is
 * `unknown` with the service's reason. `l0` is optional: a service with no DPT
 * publishes none. Optional fields this page does not read are ignored.
 */
export interface LivePayload {
  readonly version: number;
  /** The served frame's id, sent back unchanged as `after`. `null` with no frame. */
  readonly frame_id: string | null;
  /** When the served frame reached the service, RFC 3339 on its own clock. `null` with no frame. */
  readonly captured_at: string | null;
  /** L1, keyed by sensor id, as the service answered it. */
  readonly l1: Readonly<Record<string, LiveSensorState>>;
  /** L0 for the newest frame inferred, absent where the service publishes none. */
  readonly l0?: LiveL0;
}

/** A `latest` answer: the JSON part, and the frame where there was one. */
export interface LiveAnswer {
  readonly payload: LivePayload;
  /**
   * The `frame` part, or `null` for an answer with only the `json` part —
   * which is how the service says it has no frame to send.
   */
  readonly frame: Blob | null;
}

/** An answer this page refuses to read, with what was wrong with it. */
export class LiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveError';
  }
}

/** Whether a response's content type is JSON, whatever parameters follow it. */
function isJson(response: Response): boolean {
  const type = mimeType(response);
  return type === 'application/json' || type.endsWith('+json');
}

/** Whether a response's content type is the multipart form `latest` answers with. */
function isMultipart(response: Response): boolean {
  return mimeType(response) === 'multipart/form-data';
}

/** The content type's essence: lower-cased, with the boundary and charset dropped. */
function mimeType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * The manifest `Response` where this origin serves an occupancy service, else
 * `null`. #333 reads its `ETag` and opens it.
 *
 * Only a 2xx with a JSON content type counts: the cloud copy of this page
 * answers every unknown path with 200 `text/html`. Any other answer, and any
 * network failure, is no service, with no toast.
 */
export async function findService(base: string = LIVE_BASE): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetch(manifestUrl(base));
  } catch {
    return null;
  }
  if (!response.ok) return null;
  return isJson(response) ? response : null;
}

/** Where the service's manifest lives. */
export function manifestUrl(base: string = LIVE_BASE): string {
  return `${base}/archive/manifest.json`;
}

/** Where to ask for the next frame. `after` is the previous answer's `frame_id`, sent back unchanged. */
export function latestUrl(base: string = LIVE_BASE, after: string | null = null): string {
  return after === null
    ? `${base}/latest`
    : `${base}/latest?after=${encodeURIComponent(after)}`;
}

/** Where the service's event stream lives. */
export function eventsUrl(base: string = LIVE_BASE): string {
  return `${base}/events`;
}

/**
 * Read one `latest` answer with `response.formData()`. If that fails on a real
 * iPhone (#331's device check), this function parses the body itself, as
 * rails49/control#950 does.
 *
 * @throws {LiveError} a non-2xx answer, a content type other than the
 *         multipart form (a proxy answers with this page's HTML when the
 *         service behind it is down), a body that will not parse, a missing
 *         `json` part, a `version` this page does not read, or an answer whose
 *         frame and fields disagree with `LIVE.md`.
 */
export async function readLatest(response: Response): Promise<LiveAnswer> {
  if (!response.ok) throw new LiveError(`the service answered ${response.status}`);

  if (!isMultipart(response)) {
    throw new LiveError(
      `the service answered ${mimeType(response) || 'no content type'}, not a multipart frame`
    );
  }

  let form: FormData;
  try {
    form = await response.formData();
  } catch (err) {
    throw new LiveError(`the multipart answer could not be read: ${errorText(err)}`);
  }

  // The part names are `LIVE.md`'s. With no frame the answer is only `json`.
  const json = form.get('json');
  const frame = form.get('frame');
  if (json === null) throw new LiveError('the multipart answer carried no `json` part');
  if (frame !== null && !(frame instanceof Blob)) {
    throw new LiveError('the `frame` part is not a file');
  }

  // `LIVE.md` sends `json` with no filename, so it arrives as a string; a part
  // with one would arrive as a `File`.
  const text = typeof json === 'string' ? json : await json.text();
  const payload = parsePayload(parseJson(text));
  // `LIVE.md`: `frame_id` and `captured_at` are null when there is no frame
  // and only then, and with no frame every sensor is `unknown`.
  if ((frame === null) !== (payload.frame_id === null)) {
    throw new LiveError(
      frame === null ? 'an answer with no frame names a `frame_id`' : 'a frame came with no `frame_id`'
    );
  }
  if (frame === null && Object.values(payload.l1).some(entry => entry.state !== 'unknown')) {
    throw new LiveError('an answer with no frame has a sensor that is not `unknown`');
  }
  return { payload, frame };
}

/**
 * How far behind the served frame the L0 drawn over it is, in milliseconds, or
 * `null` where either time is missing or unreadable. Both times are the
 * service's clock; this page's clock plays no part.
 */
export function l0AgeMs(payload: LivePayload): number | null {
  const frame = payload.captured_at === null ? NaN : Date.parse(payload.captured_at);
  const l0 = payload.l0 === undefined ? NaN : Date.parse(payload.l0.captured_at);
  if (Number.isNaN(frame) || Number.isNaN(l0)) return null;
  return frame - l0;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new LiveError(`the answer is not JSON: ${errorText(err)}`);
  }
}

/** An error's message, or the value as text where it is not an `Error`. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a value is an object with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the JSON part, field by field. Keys this page does not read are dropped. */
export function parsePayload(data: unknown): LivePayload {
  if (!isRecord(data)) throw new LiveError('the answer is not an object');
  if (data.version !== LIVE_VERSION) {
    throw new LiveError(
      `the service speaks version ${JSON.stringify(data.version)}, and this page reads ${LIVE_VERSION}`
    );
  }

  const frameId = nullableString(data, 'frame_id');
  const capturedAt = nullableString(data, 'captured_at');

  if (!isRecord(data.l1)) throw new LiveError('`l1` is not an object');
  const l1: Record<string, LiveSensorState> = {};
  for (const [id, entry] of Object.entries(data.l1)) {
    l1[id] = parseSensorState(id, entry);
  }

  return {
    version: LIVE_VERSION,
    frame_id: frameId,
    captured_at: capturedAt,
    l1,
    ...(data.l0 === undefined ? {} : { l0: parseL0(data.l0) }),
  };
}

function nullableString(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  if (value === null) return null;
  if (typeof value !== 'string' || value === '') {
    throw new LiveError(`\`${field}\` is neither a string nor null`);
  }
  return value;
}

function parseSensorState(id: string, entry: unknown): LiveSensorState {
  if (!isRecord(entry)) throw new LiveError(`sensor \`${id}\` is not an object`);
  switch (entry.state) {
    case 'occupied':
      if (!finite(entry.confidence)) {
        throw new LiveError(`sensor \`${id}\` is occupied with no confidence`);
      }
      return { state: 'occupied', confidence: entry.confidence };
    case 'clear':
      // Any `confidence` is dropped: `clear` carries none (`SPEC.md` § Confidence).
      return { state: 'clear' };
    case 'unknown':
      if (typeof entry.reason !== 'string' || entry.reason === '') {
        throw new LiveError(`sensor \`${id}\` is unknown with no reason`);
      }
      return { state: 'unknown', reason: entry.reason };
    default:
      throw new LiveError(`sensor \`${id}\` reads ${JSON.stringify(entry.state)}`);
  }
}

function parseL0(data: unknown): LiveL0 {
  if (!isRecord(data)) throw new LiveError('`l0` is not an object');
  if (typeof data.frame_id !== 'string') throw new LiveError('`l0.frame_id` is not a string');
  if (typeof data.captured_at !== 'string') {
    throw new LiveError('`l0.captured_at` is not a string');
  }
  const ids = { frame_id: data.frame_id, captured_at: data.captured_at };
  if (data.detections === undefined) return ids;
  if (!Array.isArray(data.detections)) throw new LiveError('`l0.detections` is not a list');
  return { ...ids, detections: data.detections.map((entry, index) => parseDetection(entry, index)) };
}

function parseDetection(data: unknown, index: number): Detection {
  if (!isRecord(data)) throw new LiveError(`detection ${index} is not an object`);
  const centre = data.centre;
  if (!isRecord(centre) || !finite(centre.x) || !finite(centre.y)) {
    throw new LiveError(`detection ${index} has no centre`);
  }
  for (const field of ['length', 'width', 'angle', 'confidence'] as const) {
    if (!finite(data[field])) throw new LiveError(`detection ${index}'s \`${field}\` is not a number`);
  }
  if (typeof data.class !== 'string') throw new LiveError(`detection ${index} has no class`);
  return {
    centre: { x: centre.x as number, y: centre.y as number },
    length: data.length as number,
    width: data.width as number,
    angle: data.angle as number,
    class: data.class,
    confidence: data.confidence as number,
  };
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
