import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from 'vitest';
import {
  LIVE_BASE,
  LiveError,
  archiveBase,
  archiveFileUrl,
  deleteArchiveFile,
  eventsUrl,
  findService,
  l0AgeMs,
  latestUrl,
  manifestUrl,
  parsePayload,
  putArchiveFile,
  readEtag,
  readLatest,
  saveRefusalRule,
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

describe('the archive on a service (#333)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // `R49Archive.load` takes an absolute `http` or `https` base, and what it
  // reads under it has to be the files the writer writes to.
  it('resolves the archive base against this page, on this origin', () => {
    expect(archiveBase('/live')).toBe(new URL('/live/archive', window.location.href).href);
    expect(archiveBase('/live')).toMatch(/^https?:\/\//);
    expect(archiveBase()).toBe(archiveBase(LIVE_BASE));
    expect(new URL(archiveBase()).pathname).toBe('/live/archive');
    expect(new URL(archiveFileUrl(LIVE_BASE, 'a.jpg'), archiveBase()).href).toBe(
      `${archiveBase()}/a.jpg`
    );
  });

  it('percent-encodes each path segment of a file name', () => {
    expect(archiveFileUrl('/live', 'manifest.json')).toBe('/live/archive/manifest.json');
    expect(archiveFileUrl('/live', 'IMG 0001.jpg')).toBe('/live/archive/IMG%200001.jpg');
    expect(archiveFileUrl('/live', 'a#b?c.jpg')).toBe('/live/archive/a%23b%3Fc.jpg');
    // A relative path keeps its separators: the segments are encoded, not the
    // slashes between them.
    expect(archiveFileUrl('/live', 'raw/a b.jpg')).toBe('/live/archive/raw/a%20b.jpg');
  });

  it('reads the ETag an answer carries, and none where it carries none', () => {
    expect(readEtag(jsonAnswer({ version: 4 }, 200, '"v1"'))).toBe('"v1"');
    expect(readEtag(jsonAnswer({ version: 4 }))).to.be.null;
  });

  it('PUTs a file with If-Match and a body that carries a Content-Length', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const body = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    await putArchiveFile('/live', 'IMG 1.jpg', '"v1"', body);

    expect(fetchMock).toHaveBeenCalledWith('/live/archive/IMG%201.jpg', {
      method: 'PUT',
      headers: { 'If-Match': '"v1"', 'Content-Type': 'image/jpeg' },
      body,
    });
  });

  it('DELETEs a file with If-Match', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await deleteArchiveFile('/live', 'img_1.jpg', '"v2"');

    expect(fetchMock).toHaveBeenCalledWith('/live/archive/img_1.jpg', {
      method: 'DELETE',
      headers: { 'If-Match': '"v2"' },
    });
  });

  it('quotes the rule a refusal names, and nothing from a body that has none', async () => {
    expect(await saveRefusalRule(jsonAnswer({ error: 'images/orphan: img_9.jpg' }, 422))).toBe(
      'images/orphan: img_9.jpg'
    );
    expect(await saveRefusalRule(jsonAnswer({ error: '' }, 422))).to.be.null;
    expect(await saveRefusalRule(jsonAnswer({}, 422))).to.be.null;
    expect(await saveRefusalRule(errorAnswer(405))).to.be.null;
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
    // The answer and not a boolean, so #333 can read its `ETag` before it loads
    // the manifest — a save landing between the two leaves the page holding the
    // older one, and its own save is refused.
    const fetchMock = stubFetch(jsonAnswer({ version: 4 }));

    const found = await findService();

    expect(fetchMock).toHaveBeenCalledWith('/live/archive/manifest.json');
    expect(found!.kind).toBe('archive');
    expect(await (found as { manifest: Response }).manifest.json()).toEqual({ version: 4 });
  });

  // `LIVE.md` § No archive (#382).
  const noArchive = (body: unknown) => jsonAnswer(body, 404);

  it('finds a service with no archive, and the railroad it names', async () => {
    stubFetch(noArchive({ error: 'archive/none', railroad: 'Gleis 49' }));
    expect(await findService()).toEqual({ kind: 'no-archive', railroad: 'Gleis 49' });
  });

  it('finds a service with no archive whose path names no railroad', async () => {
    stubFetch(noArchive({ error: 'archive/none' }));
    expect(await findService()).toEqual({ kind: 'no-archive' });
  });

  it('finds a service with no archive and no railroad loaded', async () => {
    stubFetch(noArchive({ error: 'archive/none', railroad: null }));
    expect(await findService()).toEqual({ kind: 'no-railroad' });
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

  it('finds none in a JSON 404 that is not archive/none', async () => {
    stubFetch(noArchive({ error: 'something/else', railroad: 'Gleis 49' }));
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

describe('the optional fields (#332)', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Bytes standing in for a patch image. Never decoded here. */
  const bytes = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);

  /** Every optional field, as `LIVE.md`'s example sends them. */
  const DETAILED = {
    ...FULL,
    scores: { Soccupied01: 0.77, Sclear00001: 0.02 },
    threshold: 0.5,
    patches: { Soccupied01: 'patch-0', Sclear00001: 'patch-1' },
    changes: { Soccupied01: 4, Sclear00001: 0 },
    timings: { capture_ms: 2.5, decode_ms: 11, cut_ms: 1.25, classify_ms: 30, rate_fps: 14.5 },
    camera: { state: 'ok', rate_fps: 15, frame_age_ms: 20 },
    drift: { px: 2, tolerance_px: 9.75, past: false },
    last_messages: {
      Soccupied01: {
        occupancy: { message: { state: 'occupied' }, time: '2026-11-05T10:15:30.140Z' },
        text: { message: 'ON', time: '2026-11-05T10:15:30.141Z' },
      },
    },
  };

  const PATCHES = [
    { name: 'patch-0', bytes: bytes(0) },
    { name: 'patch-1', bytes: bytes(1) },
  ];

  it('reads each field, and each sensor\'s patch from the part `patches` names', async () => {
    const { details } = await readLatest(multipartAnswer(DETAILED, undefined, PATCHES));

    expect(details.scores).toEqual(new Map([['Soccupied01', 0.77], ['Sclear00001', 0.02]]));
    expect(details.threshold).toBe(0.5);
    expect(details.changes).toEqual(new Map([['Soccupied01', 4], ['Sclear00001', 0]]));
    expect(details.timings).toEqual(DETAILED.timings);
    expect(details.camera).toEqual(DETAILED.camera);
    expect(details.drift).toEqual(DETAILED.drift);
    expect(details.last_messages!.get('Soccupied01')).toEqual(
      new Map([
        ['occupancy', { message: { state: 'occupied' }, time: '2026-11-05T10:15:30.140Z' }],
        ['text', { message: 'ON', time: '2026-11-05T10:15:30.141Z' }],
      ])
    );
    const patch = details.patches!.get('Sclear00001')!;
    expect(new Uint8Array(await patch.arrayBuffer())).toEqual(bytes(1));
    expect(details.patches!.size).toBe(2);
  });

  it('gives a sensor whose id holds a `"` its own patch', async () => {
    // A part name cannot carry the id: a browser returns `"` as `%22`.
    const quoted = { ...BARE, patches: { 'C3"A': 'patch-0', 'C3%22A': 'patch-1' } };
    const { details } = await readLatest(multipartAnswer(quoted, undefined, PATCHES));

    expect(new Uint8Array(await details.patches!.get('C3"A')!.arrayBuffer())).toEqual(bytes(0));
    expect(new Uint8Array(await details.patches!.get('C3%22A')!.arrayBuffer())).toEqual(bytes(1));
  });

  it('gives no patch to a sensor with no entry, or to an entry naming a missing part', async () => {
    const partial = { ...BARE, patches: { Soccupied01: 'patch-0', Sclear00001: 'patch-9' } };
    const { details } = await readLatest(multipartAnswer(partial, undefined, PATCHES.slice(0, 1)));

    expect([...details.patches!.keys()]).toEqual(['Soccupied01']);
  });

  it('reads an answer with no optional fields as none, and logs nothing', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { details } = await readLatest(multipartAnswer(BARE));

    expect(details).toEqual({});
    expect(warned).not.toHaveBeenCalled();
  });

  it('reads a detector\'s timings beside the classifier\'s', async () => {
    const timings = { detect_ms: 80, l0_rate_fps: 3, l0_age_ms: 250, rate_fps: 15 };
    const { details } = await readLatest(multipartAnswer({ ...BARE, timings }));
    expect(details.timings).toEqual(timings);
  });

  it('reads drift that could not be measured, with its reason', async () => {
    const { details } = await readLatest(multipartAnswer({ ...BARE, drift: { unmeasured: 'no reference' } }));
    expect(details.drift).toEqual({ unmeasured: 'no reference' });
  });

  it('counts a field of the wrong shape as absent, logs it, and keeps L1 and the frame', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wrong: [string, unknown][] = [
      ['scores', { Soccupied01: 1.5 }],
      ['threshold', '0.5'],
      ['patches', { Soccupied01: 7 }],
      ['changes', { Soccupied01: 1.5 }],
      ['timings', { decode_ms: -1 }],
      ['camera', { state: 'sleeping' }],
      ['drift', { px: 2 }],
      ['drift', { unmeasured: '' }],
      // `past` disagrees with the numbers: `LIVE.md`'s `optional/drift`.
      ['drift', { px: 12, tolerance_px: 9.75, past: false }],
      ['drift', { px: 9.75, tolerance_px: 9.75, past: true }],
      ['last_messages', { Soccupied01: { occupancy: { message: 7, time: 'now' } } }],
      ['last_messages', { Soccupied01: [] }],
    ];
    for (const [field, value] of wrong) {
      warned.mockClear();
      const { payload, frame, details } = await readLatest(
        multipartAnswer({ ...FULL, [field]: value }, undefined, PATCHES)
      );

      expect(details, field).toEqual({});
      expect(warned, field).toHaveBeenCalledOnce();
      expect(String(warned.mock.calls[0][0]), field).toContain(field);
      expect(payload.l1.Soccupied01).toEqual({ state: 'occupied', confidence: 0.77 });
      expect(frame).to.not.be.null;
    }
  });

  it('asks for patches only when told to', () => {
    expect(latestUrl(LIVE_BASE, null, true)).toBe('/live/latest?patches=1');
    expect(latestUrl(LIVE_BASE, 'f-7', true)).toBe('/live/latest?after=f-7&patches=1');
    expect(latestUrl(LIVE_BASE, 'f-7', false)).toBe('/live/latest?after=f-7');
  });
});
