/**
 * The live contract: what an occupancy service answers, and how this page reads
 * it (#331).
 *
 * **The contract is not this repository's.** It is `occupancy-service`'s, stated
 * in its `LIVE.md`, and both words are that project's
 * (`GLOSSARY.md` § Occupancy). What lives here is one reader for it, so that the
 * wire — the paths, the content types, the part names, the field names and the
 * version — is described in exactly one file. `occupancyService.ts` runs the
 * loop over it and `rr-app` runs {@link findService}; neither names a path or a
 * part.
 *
 * **Everything is on the page's own origin.** `/live` is one constant and not a
 * setting: a cross-origin service is out of scope, and the app fetches from
 * origin anyway (ADR 0006).
 *
 * **A failure is never a rejection a caller may skip.** {@link readLatest}
 * throws a {@link LiveError} naming what was wrong with the answer, and the
 * caller turns that into `unknown` for every sensor — `ResultSource.resultFor`
 * never rejects, and a loop that skipped a frame instead would leave the last
 * good answers frozen on screen.
 */

import type { Detection } from '@rails49/detector';

/**
 * Where a service answers, on the page's own origin.
 *
 * One constant, not a setting (#331 § Out of scope). A base somebody could type
 * would be a second way for the page to be wrong about what it is watching, and
 * the service is served through the same door as the page.
 */
export const LIVE_BASE = '/live';

/**
 * The only `version` of the contract this page reads.
 *
 * Checked rather than assumed: a service that moved on is a service whose
 * fields this reader would misread, and reporting `unknown` with a reason is
 * better than drawing a sensor state built from a field that changed meaning.
 */
export const LIVE_VERSION = 1;

/**
 * How long to wait for a complete `latest` answer before calling the request
 * failed.
 *
 * The service long-polls, so a wait is normal and a *silence* is not. Five
 * seconds is long enough that a slow frame on a slow link still lands and short
 * enough that a service that died mid-answer is reported rather than leaving the
 * screen on the last frame indefinitely.
 */
export const LATEST_TIMEOUT_MS = 5000;

/** One sensor's state as the service publishes it. */
export type LiveSensorState =
  | { readonly state: 'occupied'; readonly confidence: number }
  | { readonly state: 'clear' }
  | { readonly state: 'unknown'; readonly reason: string };

/**
 * L0 for the newest frame the service inferred.
 *
 * Its own `frame_id` and `captured_at`, because it is **not** necessarily the
 * frame being served: a service infers on its own cadence and publishes the
 * newest boxes it has, so the two times are what say how far behind the boxes
 * are. Both are the service's clock.
 *
 * `detections` is `Detection` as this page already has it, in
 * `camera.resolution` pixels (`SPEC.md` § Output encoding) — the same six
 * fields, so nothing is converted on the way in.
 */
export interface LiveL0 {
  readonly frame_id: string;
  readonly captured_at: string;
  readonly detections: readonly Detection[];
}

/**
 * The JSON part of a `latest` answer.
 *
 * Every field but `version` is optional, and that is the contract rather than
 * defensiveness: an answer with no frames carries a `reason` and no `frame_id`,
 * a service with no DPT publishes no `l0` at all, and `occupancy-service#8` is
 * the issue that lands `l0` — so a service may be running that does not send
 * the field yet.
 */
export interface LivePayload {
  readonly version: number;
  /** The served frame's id, sent back unchanged as `after`. Absent with no frames. */
  readonly frame_id?: string;
  /** When the service captured the served frame, ISO 8601 on its own clock. */
  readonly captured_at?: string;
  /** L1, keyed by sensor id, as the service answered it. */
  readonly sensors?: Readonly<Record<string, LiveSensorState>>;
  /** L0 for the newest frame inferred, absent where the service publishes none. */
  readonly l0?: LiveL0;
  /** Why there are no frames, in the service's words. */
  readonly reason?: string;
}

/** A `latest` answer: the JSON part, and the frame where there was one. */
export interface LiveAnswer {
  readonly payload: LivePayload;
  /**
   * The `frame` part, or `null` for a **JSON-only** answer — which is how the
   * service says it has no frames to send.
   */
  readonly frame: Blob | null;
}

/**
 * An answer this page refuses to read, with what was wrong with it.
 *
 * A named class so a caller can tell a contract failure from a programming
 * error without matching on message text.
 */
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
 * Whether this origin serves an occupancy service, as its answer to the
 * manifest.
 *
 * **Returns the answer, not a boolean**, so that a caller that wants the
 * manifest itself does not fetch it twice — #333 opens it as an archive and
 * reads its `ETag` from here.
 *
 * Only a JSON content type counts. The cloud copy of this page answers every
 * unknown path with 200 `text/html` (its SPA fallback), so `response.ok` alone
 * would find a service on a static host. Any other answer, and any network
 * failure, is "no service" — and silently: the page without one is the page as
 * it has always been, and a toast on every load of the deployed site would be
 * noise about a feature that is not missing.
 */
export async function findService(base: string = LIVE_BASE): Promise<Response | null> {
  let response: Response;
  try {
    response = await fetch(manifestUrl(base));
  } catch {
    // A refused connection, DNS, an offline page. Not an error to report: there
    // is simply no service here.
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
 * Where to ask for the next frame.
 *
 * `after` is the previous answer's `frame_id`, sent back **unchanged**: it is
 * the service's token and this page never parses, compares or orders it. That
 * is what lets a restarted service recover — see `occupancyService.ts`, which
 * treats a *different* id as new rather than a greater one.
 */
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
 * Read one `latest` answer.
 *
 * The body is parsed with **`response.formData()`** rather than by hand: the
 * browser already has a multipart parser, and the one in rails49/control#950
 * exists only because WebKit refused that type there. If `formData()` turns out
 * to fail on a real iPhone (#331's human step), this function is the one place
 * that changes.
 *
 * @throws {LiveError} a non-2xx answer, a content type that is neither the
 *         multipart form nor JSON — the door answers with this page's HTML when
 *         the service behind it is down — a body that will not parse, a missing
 *         part, or a `version` this page does not read.
 */
export async function readLatest(response: Response): Promise<LiveAnswer> {
  if (!response.ok) throw new LiveError(`the service answered ${response.status}`);

  // A JSON answer with no multipart around it is the service saying it has no
  // frame to send. It still carries L1 and a reason.
  if (isJson(response)) {
    return { payload: parsePayload(await readJson(response)), frame: null };
  }

  if (!isMultipart(response)) {
    throw new LiveError(
      `the service answered ${mimeType(response) || 'no content type'}, not a multipart frame`
    );
  }

  let form: FormData;
  try {
    form = await response.formData();
  } catch (err) {
    throw new LiveError(`the multipart answer could not be read: ${message(err)}`);
  }

  // The part names are `LIVE.md`'s.
  const json = form.get('json');
  const frame = form.get('frame');
  if (json === null) throw new LiveError('the multipart answer carried no `json` part');
  if (!(frame instanceof Blob)) {
    throw new LiveError('the multipart answer carried no `frame` part');
  }

  // A part with a filename arrives as a `File` and one without as a string,
  // and which the service sends is its business.
  const text = typeof json === 'string' ? json : await json.text();
  return { payload: parsePayload(parseJson(text)), frame };
}

/**
 * How far behind the served frame the L0 drawn over it is, in milliseconds, or
 * `null` where either time is missing or unreadable.
 *
 * Both times are the **service's** clock, so the subtraction is within one
 * clock and this page's own is never consulted — a phone whose clock is minutes
 * off still reports the right age.
 */
export function l0AgeMs(payload: LivePayload): number | null {
  const frame = payload.captured_at === undefined ? NaN : Date.parse(payload.captured_at);
  const l0 = payload.l0 === undefined ? NaN : Date.parse(payload.l0.captured_at);
  if (Number.isNaN(frame) || Number.isNaN(l0)) return null;
  return frame - l0;
}

async function readJson(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    throw new LiveError(`the answer could not be read: ${message(err)}`);
  }
  return parseJson(text);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new LiveError(`the answer is not JSON: ${message(err)}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether a value is an object with string keys — the shape every check below starts from. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate the JSON part, field by field.
 *
 * Narrow guards rather than a cast: this is the network, and a field that is
 * the wrong type reaches a sensor marker or a box on the photograph. A refusal
 * here becomes `unknown` for every sensor with a reason the user can read,
 * which is the honest outcome; a cast would draw a box at `NaN`.
 */
export function parsePayload(data: unknown): LivePayload {
  if (!isRecord(data)) throw new LiveError('the answer is not an object');
  if (data.version !== LIVE_VERSION) {
    throw new LiveError(
      `the service speaks version ${JSON.stringify(data.version)}, and this page reads ${LIVE_VERSION}`
    );
  }

  const payload: {
    version: number;
    frame_id?: string;
    captured_at?: string;
    sensors?: Record<string, LiveSensorState>;
    l0?: LiveL0;
    reason?: string;
  } = { version: LIVE_VERSION };

  for (const field of ['frame_id', 'captured_at', 'reason'] as const) {
    const value = data[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw new LiveError(`\`${field}\` is not a string`);
    payload[field] = value;
  }

  if (data.sensors !== undefined && data.sensors !== null) {
    if (!isRecord(data.sensors)) throw new LiveError('`sensors` is not an object');
    const sensors: Record<string, LiveSensorState> = {};
    for (const [id, entry] of Object.entries(data.sensors)) {
      sensors[id] = parseSensorState(id, entry);
    }
    payload.sensors = sensors;
  }

  if (data.l0 !== undefined && data.l0 !== null) payload.l0 = parseL0(data.l0);

  return payload;
}

function parseSensorState(id: string, entry: unknown): LiveSensorState {
  if (!isRecord(entry)) throw new LiveError(`sensor \`${id}\` is not an object`);
  switch (entry.state) {
    case 'occupied':
      // The number is the whole state: a service's classifier reports
      // P(occupied) and no box (ADR 0022), and `SensorState.occupied` carries
      // the confidence for exactly that reason.
      if (typeof entry.confidence !== 'number' || !Number.isFinite(entry.confidence)) {
        throw new LiveError(`sensor \`${id}\` is occupied with no confidence`);
      }
      return { state: 'occupied', confidence: entry.confidence };
    case 'clear':
      // No confidence, and none accepted: `clear` is the absence of evidence
      // (`SPEC.md` § Confidence).
      return { state: 'clear' };
    case 'unknown':
      if (typeof entry.reason !== 'string') {
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
  if (!Array.isArray(data.detections)) throw new LiveError('`l0.detections` is not a list');
  return {
    frame_id: data.frame_id,
    captured_at: data.captured_at,
    detections: data.detections.map((entry, index) => parseDetection(entry, index)),
  };
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

function finite(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}
