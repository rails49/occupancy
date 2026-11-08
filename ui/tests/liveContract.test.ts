import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from 'vitest';
import {
  LIVE_BASE,
  LiveError,
  eventsUrl,
  findService,
  l0AgeMs,
  latestUrl,
  manifestUrl,
  parsePayload,
  readLatest,
} from '../src/liveContract.js';
import type { LivePayload } from '../src/liveContract.js';
import {
  errorAnswer,
  htmlAnswer,
  jsonAnswer,
  MULTIPART_TYPE,
  multipartAnswer,
  useNodeFileGlobals,
} from './liveFixture.js';

// The wire, read in one place (#331). The bodies are real multipart bodies
// built byte by byte in `liveFixture.ts`, so `response.formData()` — the
// browser parser this reader leans on, and the one the human step checks on an
// iPhone — is what runs here.

const fileGlobals = useNodeFileGlobals();
beforeAll(() => fileGlobals.install());
afterAll(() => fileGlobals.restore());

const DETECTION = {
  centre: { x: 100, y: 200 },
  length: 180,
  width: 42,
  angle: 0.5,
  class: 'stock',
  confidence: 0.84,
};

const FULL: LivePayload = {
  version: 1,
  frame_id: 'f-7',
  captured_at: '2026-11-05T10:00:01.500Z',
  l1: {
    Soccupied01: { state: 'occupied', confidence: 0.77 },
    Sclear00001: { state: 'clear' },
    Sunknown001: { state: 'unknown', reason: 'the classifier found no track here' },
  },
  l0: {
    frame_id: 'f-5',
    captured_at: '2026-11-05T10:00:01.100Z',
    detections: [DETECTION],
  },
};

/** The fields `LIVE.md` requires, and nothing else. */
const BARE: LivePayload = { version: 1, frame_id: 'f-1', captured_at: '2026-11-05T10:00:00Z', l1: {} };

/** The json part with no frame, as `LIVE.md`'s example has it. */
const NO_FRAME: LivePayload = {
  version: 1,
  frame_id: null,
  captured_at: null,
  l1: { Sunknown001: { state: 'unknown', reason: 'no frames' } },
};

describe('the live contract, as URLs', () => {
  it('asks the page\'s own origin, under one constant base', () => {
    expect(LIVE_BASE).toBe('/live');
    expect(manifestUrl()).toBe('/live/archive/manifest.json');
    expect(latestUrl()).toBe('/live/latest');
    expect(eventsUrl()).toBe('/live/events');
  });

  it('sends the previous id back unchanged, escaped for the query', () => {
    // The id is the service's token: this page never parses, orders or compares
    // it, which is what lets a restarted service recover.
    expect(latestUrl(LIVE_BASE, 'f-7')).toBe('/live/latest?after=f-7');
    expect(latestUrl(LIVE_BASE, 'a b&c')).toBe('/live/latest?after=a%20b%26c');
  });
});

describe('findService', () => {
  afterEach(() => vi.unstubAllGlobals());

  const stubFetch = (answer: Response | Error) => {
    const fetchMock = vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('finds a service in a JSON manifest, and hands back the answer', async () => {
    // The answer and not a boolean, so #333 can read its ETag and open it as an
    // archive without fetching the manifest twice.
    const fetchMock = stubFetch(jsonAnswer({ version: 4 }));

    const response = await findService();

    expect(fetchMock).toHaveBeenCalledWith('/live/archive/manifest.json');
    expect(response).to.not.be.null;
    expect(await response!.json()).toEqual({ version: 4 });
  });

  it('finds none in a 200 text/html answer', async () => {
    // The cloud copy of this page answers every unknown path with its own HTML,
    // so `response.ok` alone would find a service on a static host.
    stubFetch(htmlAnswer());
    expect(await findService()).to.be.null;
  });

  it('finds none in a 404', async () => {
    stubFetch(new Response('nope', { status: 404, headers: { 'content-type': 'application/json' } }));
    expect(await findService()).to.be.null;
  });

  it('finds none when the request fails outright', async () => {
    stubFetch(new TypeError('Failed to fetch'));
    expect(await findService()).to.be.null;
  });
});

describe('readLatest', () => {
  it('reads a full answer: the json part, and the frame part', async () => {
    const { payload, frame } = await readLatest(multipartAnswer(FULL));

    expect(payload.frame_id).toBe('f-7');
    expect(payload.l1.Soccupied01).toEqual({ state: 'occupied', confidence: 0.77 });
    expect(payload.l1.Sclear00001).toEqual({ state: 'clear' });
    expect(payload.l1.Sunknown001).toEqual({
      state: 'unknown',
      reason: 'the classifier found no track here',
    });
    expect(payload.l0!.detections).toEqual([DETECTION]);
    expect(frame).to.not.be.null;
    expect(frame!.size).toBeGreaterThan(0);
  });

  it('reads an answer with only the json part as no frame', async () => {
    // Which is how the service says it has none. Each sensor carries its reason.
    const { payload, frame } = await readLatest(multipartAnswer(NO_FRAME, null));

    expect(frame).to.be.null;
    expect(payload.frame_id).to.be.null;
    expect(payload.captured_at).to.be.null;
    expect(payload.l1.Sunknown001).toEqual({ state: 'unknown', reason: 'no frames' });
  });

  it('refuses a frame with no `frame_id`, and a `frame_id` with no frame', async () => {
    await expect(readLatest(multipartAnswer({ ...FULL, frame_id: null }))).rejects.toThrow(
      /a frame came with no `frame_id`/
    );
    await expect(readLatest(multipartAnswer({ ...NO_FRAME, frame_id: 'f-1' }, null))).rejects.toThrow(
      /no frame names a `frame_id`/
    );
  });

  it('refuses an answer with no frame where a sensor is not unknown', async () => {
    const answer = multipartAnswer({ ...NO_FRAME, l1: { S1: { state: 'clear' } } }, null);
    await expect(readLatest(answer)).rejects.toThrow(/not `unknown`/);
  });

  it('refuses a plain JSON answer, which is not the multipart form', async () => {
    await expect(readLatest(jsonAnswer(NO_FRAME))).rejects.toThrow(/application\/json/);
  });

  it('refuses the page\'s own HTML, which is what the door answers when the service is down', async () => {
    await expect(readLatest(htmlAnswer())).rejects.toThrow(LiveError);
    await expect(readLatest(htmlAnswer())).rejects.toThrow(/text\/html/);
  });

  it('refuses a non-2xx answer, naming the status', async () => {
    await expect(readLatest(errorAnswer(500))).rejects.toThrow(/500/);
  });

  it('refuses a malformed body', async () => {
    const broken = new Response('--r49LiveBoundary\r\nnot a part', {
      headers: { 'content-type': MULTIPART_TYPE },
    });
    await expect(readLatest(broken)).rejects.toThrow(LiveError);
    await expect(readLatest(multipartAnswer('{ not json'))).rejects.toThrow(LiveError);
  });

  it('refuses a version it does not read', async () => {
    // A service that moved on is a service whose fields this reader would
    // misread, and a sensor state built from a field that changed meaning is
    // worse than `unknown`.
    await expect(readLatest(multipartAnswer({ ...FULL, version: 2 }))).rejects.toThrow(/version 2/);
    await expect(readLatest(multipartAnswer({ frame_id: 'x' }))).rejects.toThrow(/version/);
  });
});

describe('parsePayload', () => {
  it('refuses a field of the wrong type rather than passing it on', async () => {
    // This is the network, and a field of the wrong type reaches a sensor
    // marker or a box drawn on the photograph. `unknown` with a reason beats a
    // box at NaN.
    const cases: [unknown, RegExp][] = [
      [[], /not an object/],
      [{ ...BARE, frame_id: 7 }, /`frame_id` is neither a string nor null/],
      [{ ...BARE, captured_at: undefined }, /`captured_at` is neither a string nor null/],
      [{ ...BARE, l1: undefined }, /`l1` is not an object/],
      [{ ...BARE, l1: [] }, /`l1` is not an object/],
      [{ ...BARE, l1: { S1: { state: 'busy' } } }, /reads "busy"/],
      [{ ...BARE, l1: { S1: { state: 'occupied' } } }, /no confidence/],
      [{ ...BARE, l1: { S1: { state: 'unknown' } } }, /no reason/],
      [{ ...BARE, l1: { S1: { state: 'unknown', reason: '' } } }, /no reason/],
      [{ ...BARE, l0: { frame_id: 'a', captured_at: 'b', detections: {} } }, /not a list/],
      [
        { ...BARE, l0: { frame_id: 'a', captured_at: 'b', detections: [{ ...DETECTION, length: 'x' }] } },
        /`length` is not a number/,
      ],
      [
        { ...BARE, l0: { frame_id: 'a', captured_at: 'b', detections: [{ ...DETECTION, centre: {} }] } },
        /has no centre/,
      ],
    ];
    for (const [data, pattern] of cases) {
      expect(() => parsePayload(data), JSON.stringify(data)).toThrow(pattern);
    }
  });

  it('takes an answer with only the required fields, and ignores keys it does not know', async () => {
    // `l0` lands in occupancy-service#8, so a service may be running that never
    // sends it. `LIVE.md`: a reader ignores keys it does not know.
    expect(parsePayload({ ...BARE, scores: { S1: 0.2 } })).toEqual(BARE);
  });

  it('takes `l0` with no detections, as `LIVE.md`\'s example sends it', async () => {
    const l0 = { frame_id: 'f-5', captured_at: '2026-11-05T10:00:01.100Z' };
    expect(parsePayload({ ...BARE, l0 }).l0).toEqual(l0);
  });

  it('accepts `clear` with nothing attached, and attaches nothing', async () => {
    // SPEC § Confidence: `clear` is the absence of evidence.
    const payload = parsePayload({ ...BARE, l1: { S1: { state: 'clear', confidence: 1 } } });
    expect(payload.l1.S1).toEqual({ state: 'clear' });
  });
});

describe('l0AgeMs', () => {
  it('subtracts within the service\'s own clock', async () => {
    // Both times are the service's, so a page whose clock is minutes off still
    // reports the right age.
    expect(l0AgeMs(FULL)).toBe(400);
  });

  it('is null where either time is missing or unreadable', async () => {
    expect(l0AgeMs(BARE)).to.be.null;
    expect(l0AgeMs({ ...BARE, captured_at: FULL.captured_at })).to.be.null;
    expect(
      l0AgeMs({
        ...BARE,
        captured_at: 'not a time',
        l0: { frame_id: 'a', captured_at: '2026-11-05T10:00:01.100Z', detections: [] },
      })
    ).to.be.null;
  });
});
