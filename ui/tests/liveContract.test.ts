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
  sensors: {
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
    expect(payload.sensors!.Soccupied01).toEqual({ state: 'occupied', confidence: 0.77 });
    expect(payload.sensors!.Sclear00001).toEqual({ state: 'clear' });
    expect(payload.sensors!.Sunknown001).toEqual({
      state: 'unknown',
      reason: 'the classifier found no track here',
    });
    expect(payload.l0!.detections).toEqual([DETECTION]);
    expect(frame).to.not.be.null;
    expect(frame!.size).toBeGreaterThan(0);
  });

  it('reads a JSON-only answer as no frame at all', async () => {
    // Which is how the service says it has none. L1 and a reason still come.
    const { payload, frame } = await readLatest(
      jsonAnswer({ version: 1, reason: 'the camera is not sending' })
    );

    expect(frame).to.be.null;
    expect(payload.reason).toBe('the camera is not sending');
  });

  it('refuses the page\'s own HTML, which is what the door answers when the service is down', async () => {
    await expect(readLatest(htmlAnswer())).rejects.toThrow(LiveError);
    await expect(readLatest(htmlAnswer())).rejects.toThrow(/text\/html/);
  });

  it('refuses a non-2xx answer, naming the status', async () => {
    await expect(readLatest(errorAnswer(500))).rejects.toThrow(/500/);
  });

  it('refuses a malformed body', async () => {
    const broken = new Response('{ not json', { headers: { 'content-type': 'application/json' } });
    await expect(readLatest(broken)).rejects.toThrow(LiveError);
  });

  it('refuses a multipart answer with no frame part', async () => {
    await expect(readLatest(multipartAnswer(FULL, null))).rejects.toThrow(/`frame` part/);
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
      [{ version: 1, frame_id: 7 }, /`frame_id` is not a string/],
      [{ version: 1, sensors: [] }, /`sensors` is not an object/],
      [{ version: 1, sensors: { S1: { state: 'busy' } } }, /reads "busy"/],
      [{ version: 1, sensors: { S1: { state: 'occupied' } } }, /no confidence/],
      [{ version: 1, sensors: { S1: { state: 'unknown' } } }, /no reason/],
      [{ version: 1, l0: { frame_id: 'a', captured_at: 'b', detections: {} } }, /not a list/],
      [
        { version: 1, l0: { frame_id: 'a', captured_at: 'b', detections: [{ ...DETECTION, length: 'x' }] } },
        /`length` is not a number/,
      ],
      [
        { version: 1, l0: { frame_id: 'a', captured_at: 'b', detections: [{ ...DETECTION, centre: {} }] } },
        /has no centre/,
      ],
    ];
    for (const [data, pattern] of cases) {
      expect(() => parsePayload(data), JSON.stringify(data)).toThrow(pattern);
    }
  });

  it('takes an answer that carries nothing but its version', async () => {
    // Every other field is optional by contract: `l0` lands in
    // occupancy-service#8, so a service may be running that never sends it.
    expect(parsePayload({ version: 1 })).toEqual({ version: 1 });
  });

  it('accepts `clear` with nothing attached, and attaches nothing', async () => {
    // SPEC § Confidence: `clear` is the absence of evidence.
    const payload = parsePayload({ version: 1, sensors: { S1: { state: 'clear', confidence: 1 } } });
    expect(payload.sensors!.S1).toEqual({ state: 'clear' });
  });
});

describe('l0AgeMs', () => {
  it('subtracts within the service\'s own clock', async () => {
    // Both times are the service's, so a page whose clock is minutes off still
    // reports the right age.
    expect(l0AgeMs(FULL)).toBe(400);
  });

  it('is null where either time is missing or unreadable', async () => {
    expect(l0AgeMs({ version: 1 })).to.be.null;
    expect(l0AgeMs({ version: 1, captured_at: FULL.captured_at })).to.be.null;
    expect(
      l0AgeMs({
        version: 1,
        captured_at: 'not a time',
        l0: { frame_id: 'a', captured_at: '2026-11-05T10:00:01.100Z', detections: [] },
      })
    ).to.be.null;
  });
});
