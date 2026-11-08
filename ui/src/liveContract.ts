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

/** `timings`: milliseconds per stage and rates, any of them. The `detect_ms` group comes with a detector. */
export interface LiveTimings {
  readonly capture_ms?: number;
  readonly decode_ms?: number;
  readonly cut_ms?: number;
  readonly classify_ms?: number;
  readonly rate_fps?: number;
  readonly detect_ms?: number;
  readonly l0_rate_fps?: number;
  readonly l0_age_ms?: number;
}

/** `camera`: the service's camera, any of these. */
export interface LiveCamera {
  readonly state?: 'ok' | 'lost';
  readonly rate_fps?: number;
  readonly frame_age_ms?: number;
}

/** `drift`: a reading against its tolerance, or why there is none. `px` is in the reference image's pixels. */
export type LiveDrift =
  | { readonly px: number; readonly tolerance_px: number; readonly past: boolean }
  | { readonly unmeasured: string };

/** One message a profile last published for a sensor. `time` is the service's clock. */
export interface LiveMessage {
  readonly message: string | Readonly<Record<string, unknown>>;
  readonly time: string;
}

/**
 * The optional fields of the JSON part other than `l0` (#332), as `LIVE.md` §
 * Optional fields states them. A field the service did not send is absent, and
 * so is one of the wrong shape. Maps are keyed by sensor id.
 *
 * `patches` holds each sensor's patch part itself, not its name. A sensor with
 * no entry, or whose entry names a part the answer lacks, has none.
 */
export interface LiveDetails {
  readonly scores?: ReadonlyMap<string, number>;
  readonly threshold?: number;
  readonly patches?: ReadonlyMap<string, Blob>;
  readonly changes?: ReadonlyMap<string, number>;
  readonly timings?: LiveTimings;
  readonly camera?: LiveCamera;
  readonly drift?: LiveDrift;
  /** Sensor id to profile name to its last message. */
  readonly last_messages?: ReadonlyMap<string, ReadonlyMap<string, LiveMessage>>;
}

/** A `latest` answer: the JSON part, and the frame where there was one. */
export interface LiveAnswer {
  readonly payload: LivePayload;
  /**
   * The `frame` part, or `null` for an answer with only the `json` part —
   * which is how the service says it has no frame to send.
   */
  readonly frame: Blob | null;
  /** The optional fields, each absent where not sent or of the wrong shape. */
  readonly details: LiveDetails;
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

/**
 * Where to ask for the next frame. `after` is the previous answer's
 * `frame_id`, sent back unchanged; `patches` asks for the patch parts.
 */
export function latestUrl(
  base: string = LIVE_BASE,
  after: string | null = null,
  patches = false
): string {
  const query = [
    ...(after === null ? [] : [`after=${encodeURIComponent(after)}`]),
    ...(patches ? ['patches=1'] : []),
  ];
  return query.length === 0 ? `${base}/latest` : `${base}/latest?${query.join('&')}`;
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
  const data = parseJson(text);
  const payload = parsePayload(data);
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
  return { payload, frame, details: parseDetails(data as Record<string, unknown>, form) };
}

/**
 * Each optional field `parse` accepts, by name. A parser returns `undefined`
 * for a value of the wrong shape.
 */
const OPTIONAL_FIELDS: {
  readonly [K in Exclude<keyof LiveDetails, 'patches'>]: (value: unknown) => LiveDetails[K];
} = {
  scores: value => idMap(value, fraction),
  threshold: fraction,
  changes: value => idMap(value, count),
  timings: value =>
    knownNumbers<LiveTimings>(value, [
      'capture_ms',
      'decode_ms',
      'cut_ms',
      'classify_ms',
      'rate_fps',
      'detect_ms',
      'l0_rate_fps',
      'l0_age_ms',
    ]),
  camera: parseCamera,
  drift: parseDrift,
  last_messages: value => idMap(value, profiles => idMap(profiles, parseMessage)),
};

/**
 * The optional fields of a JSON part `parsePayload` accepted. Each field of
 * the wrong shape is left out and logged; the rest of the answer stands.
 * `patches` names parts of `form`, and each sensor gets the part named.
 */
function parseDetails(data: Record<string, unknown>, form: FormData): LiveDetails {
  const details: Record<string, unknown> = {};
  const take = (field: string, parse: (value: unknown) => unknown) => {
    if (data[field] === undefined) return;
    const parsed = parse(data[field]);
    if (parsed === undefined) {
      console.warn(`The occupancy service sent \`${field}\` in the wrong shape; it is ignored.`);
      return;
    }
    details[field] = parsed;
  };
  for (const [field, parse] of Object.entries(OPTIONAL_FIELDS)) take(field, parse);
  take('patches', value => parsePatches(value, form));
  return details as LiveDetails;
}

/** Sensor id to its patch part, or `undefined` for a `patches` of the wrong shape. */
function parsePatches(value: unknown, form: FormData): ReadonlyMap<string, Blob> | undefined {
  const names = idMap(value, name => (typeof name === 'string' && name !== '' ? name : undefined));
  if (names === undefined) return undefined;
  const patches = new Map<string, Blob>();
  for (const [id, name] of names) {
    const part = form.get(name);
    if (part instanceof Blob) patches.set(id, part);
  }
  return patches;
}

/** An object's entries as a map, or `undefined` where it is not an object or any value fails `parse`. */
function idMap<T>(value: unknown, parse: (entry: unknown) => T | undefined): Map<string, T> | undefined {
  if (!isRecord(value)) return undefined;
  const map = new Map<string, T>();
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parse(entry);
    if (parsed === undefined) return undefined;
    map.set(key, parsed);
  }
  return map;
}

/** An object holding any of `keys`, each a number from 0. Other keys are dropped. */
function knownNumbers<T>(value: unknown, keys: readonly string[]): T | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (!nonNegative(value[key])) return undefined;
    out[key] = value[key];
  }
  return out as T;
}

function parseCamera(value: unknown): LiveCamera | undefined {
  const numbers = knownNumbers<LiveCamera>(value, ['rate_fps', 'frame_age_ms']);
  if (numbers === undefined || !isRecord(value)) return undefined;
  if (value.state === undefined) return numbers;
  if (value.state !== 'ok' && value.state !== 'lost') return undefined;
  return { state: value.state, ...numbers };
}

function parseDrift(value: unknown): LiveDrift | undefined {
  if (!isRecord(value)) return undefined;
  if (value.unmeasured !== undefined) {
    return typeof value.unmeasured === 'string' && value.unmeasured !== ''
      ? { unmeasured: value.unmeasured }
      : undefined;
  }
  const { px, tolerance_px: tolerance, past } = value;
  if (!nonNegative(px) || !nonNegative(tolerance) || typeof past !== 'boolean') return undefined;
  return { px, tolerance_px: tolerance, past };
}

function parseMessage(value: unknown): LiveMessage | undefined {
  if (!isRecord(value) || typeof value.time !== 'string') return undefined;
  const { message } = value;
  if (typeof message !== 'string' && !isRecord(message)) return undefined;
  return { message, time: value.time };
}

/** A number from 0 to 1, or `undefined`. */
function fraction(value: unknown): number | undefined {
  return nonNegative(value) && value <= 1 ? value : undefined;
}

/** An integer from 0, or `undefined`. */
function count(value: unknown): number | undefined {
  return nonNegative(value) && Number.isInteger(value) ? value : undefined;
}

function nonNegative(value: unknown): value is number {
  return finite(value) && value >= 0;
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
