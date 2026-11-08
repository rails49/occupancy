#!/usr/bin/env node
/**
 * A stand-in occupancy service, for checking the live view by hand (#331).
 *
 * It serves the built page and the live contract from one origin, because
 * that is what the page expects: `/live` is on the page's own origin and there
 * is no setting for anything else. One command therefore puts both on the LAN,
 * which is what the check on a real iPhone or iPad needs — see
 * `README.md` § Checking the live view against a service.
 *
 * It is not the service. The real one is rails49/occupancy-service, and the
 * contract it follows is that project's `LIVE.md`. This answers the same three
 * paths with made-up data so that a person can see frames, sensor states, L0
 * boxes and a frame rate on a device, and every optional field of `LIVE.md`
 * with real PNG patches for the Details panel (#332).
 *
 * Node's http and fs only: no dependency, nothing to install, and nothing here
 * is built or typechecked by the gate.
 *
 *     node bin/live-stub.mjs [--port 8080] [--fps 5] [--no-frames] [--churn]
 *
 * `--no-frames` answers `latest` with only the `json` part, which is how the
 * service says it has no frame: the page should keep its last picture, show
 * "No picture from the camera", read every sensor `unknown` with the reason, and
 * drop the rate to 0. `--churn` drops every `events` client every 20 s, which is
 * what the real service does after a save and what makes the page re-read the
 * manifest.
 *
 * `occupancy-service`'s `live-check` passes against it; see `README.md`.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { crc32, deflateSync } from 'node:zlib';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = join(ROOT, 'ui', 'dist');

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at === -1 ? fallback : args[at + 1];
};

const PORT = Number(option('--port', '8080'));
const FPS = Number(option('--fps', '5'));
const NO_FRAMES = flag('--no-frames');
const CHURN = flag('--churn');

/**
 * One real JPEG, 320x240: a dark pane with a length of track across it.
 *
 * Embedded rather than checked in beside this file, so the whole stand-in is
 * one file somebody can read, and real rather than synthesised because the
 * point of the check is that a device decodes what the service sends.
 * Nothing moves in the picture; what moves is the car in `l0`, which is what
 * flips the sensors and is the thing worth watching.
 */
const FRAME_JPEG = Buffer.from(
  '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' +
  'AAAAAAAAAAAAAAAAAAAAAAAAP//Z',

  'base64'
);

/** The frame the service serves, which `camera.resolution` has to agree with. */
const RESOLUTION = { width: 320, height: 240 };

/** The y the track runs along, and where the sensors sit. */
const TRACK_Y = 120;

/**
 * The manifest, answered at `/live/archive/manifest.json`.
 *
 * Calibrated so that DPT resolves to 20: 100 px over 44.84 model mm in N scale
 * (gauge 8.96875 mm). Without a DPT the page has no track width and draws no
 * sensor at its real size.
 */
const MANIFEST = {
  version: 4,
  layout: {
    name: 'live-stub',
    scale: 'N',
    calibration: {
      points: [
        { px: { x: 0, y: 0 }, world: { x: 0, y: 0, z: 0 } },
        { px: { x: 100, y: 0 }, world: { x: 44.84, y: 0, z: 0 } },
      ],
    },
    sensors: [
      { id: 'stub-west', name: 'West', x: 60, y: TRACK_Y },
      { id: 'stub-middle', name: 'Middle', x: 160, y: TRACK_Y },
      { id: 'stub-east', name: 'East', x: 260, y: TRACK_Y },
      // Always `unknown`: the page should show this service's own words for why.
      { id: 'stub-refused', name: 'Refused', x: 160, y: 40 },
    ],
    // Drawn as a centerline while Details is open (#332).
    tracks: [
      {
        nodes: [
          { x: 0, y: TRACK_Y, heading: 0 },
          { x: RESOLUTION.width, y: TRACK_Y, heading: 0 },
        ],
      },
    ],
  },
  camera: { resolution: RESOLUTION },
  images: [],
};

/** How long the car is, in frame pixels. */
const CAR_LENGTH = 90;

/** Frames are numbered from one, so a restart is visibly a different id. */
let frameNumber = 0;
/** Where the car's centre is, which advances with each frame. */
let carX = 0;

/** Whoever is waiting on `latest` for a frame newer than the one they have. */
const waiting = new Set();
/** Every open `events` response. */
const streams = new Set();

/** The reason this stand-in gives for a sensor it cannot answer. */
const REFUSED = 'this stand-in never answers this sensor';
/** The reason every sensor carries with `--no-frames`. */
const NO_FRAME_REASON = 'no frames';

const frameId = () => `stub-${frameNumber}`;

/** Each sensor's entry as last sent on `events`, by id. */
let published = l1();
/** How many times each sensor's L1 has changed. */
const changes = Object.fromEntries(MANIFEST.layout.sensors.map(sensor => [sensor.id, 0]));
/** The last message the `occupancy` profile published per sensor, as `last_messages` holds it. */
const lastMessages = {};

/** A PNG chunk: length, type, data and CRC. */
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A real PNG, `size` square, one RGB colour with a darker border. */
function png(size, [r, g, b]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
      row.push(...(edge ? [r >> 1, g >> 1, b >> 1] : [r, g, b]));
    }
    rows.push(Buffer.from(row));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A patch per state, so the panel's patches change as the car passes. */
const PATCH_PNGS = {
  occupied: png(48, [220, 60, 60]),
  clear: png(48, [60, 180, 90]),
  unknown: png(48, [140, 150, 165]),
};

setInterval(() => {
  frameNumber++;
  carX = (carX + 14) % (RESOLUTION.width + CAR_LENGTH);
  for (const resolveWaiter of waiting) resolveWaiter();
  waiting.clear();
  // `events` carries each change.
  const now = l1();
  for (const [id, entry] of Object.entries(now)) {
    if (JSON.stringify(entry) === JSON.stringify(published[id])) continue;
    for (const stream of streams) sendEvent(stream, id, entry);
    changes[id]++;
    lastMessages[id] = { occupancy: { message: entry, time: new Date().toISOString() } };
  }
  published = now;
}, Math.max(20, Math.round(1000 / FPS)));

if (CHURN) {
  setInterval(() => {
    for (const stream of streams) stream.end();
    streams.clear();
  }, 20_000);
}

/** The car as one detection, in `camera.resolution` pixels. */
function car() {
  return {
    centre: { x: carX, y: TRACK_Y },
    length: CAR_LENGTH,
    width: 42,
    angle: 0,
    class: 'stock',
    confidence: 0.91,
  };
}

/** L1: one entry per sensor in the manifest, as `LIVE.md` requires. */
function l1() {
  const box = car();
  const states = {};
  for (const sensor of MANIFEST.layout.sensors) {
    if (NO_FRAMES) {
      states[sensor.id] = { state: 'unknown', reason: NO_FRAME_REASON };
    } else if (sensor.id === 'stub-refused') {
      states[sensor.id] = { state: 'unknown', reason: REFUSED };
    } else {
      const covered = Math.abs(sensor.x - box.centre.x) < box.length / 2;
      states[sensor.id] = covered
        ? { state: 'occupied', confidence: box.confidence }
        : { state: 'clear' };
    }
  }
  return states;
}

/** Each sensor's made-up P(occupied): how much of the car covers it. */
function scores() {
  const box = car();
  return Object.fromEntries(
    MANIFEST.layout.sensors.map(sensor => {
      const off = Math.abs(sensor.x - box.centre.x) / box.length;
      return [sensor.id, Math.round(Math.max(0.02, Math.min(0.98, 1.5 - 2 * off)) * 100) / 100];
    })
  );
}

/**
 * The JSON part of a `latest` answer, with every optional field.
 *
 * @param patchIds the sensors whose patch goes in this answer, in part order;
 *                 empty unless `?patches=1` was asked.
 */
function payload(patchIds) {
  // `LIVE.md`: these three do not come from the served frame, so an answer
  // with no frame may carry them.
  const optional = {
    last_messages: lastMessages,
    camera: NO_FRAMES ? { state: 'lost' } : { state: 'ok', rate_fps: FPS, frame_age_ms: 12 },
    drift: NO_FRAMES ? { unmeasured: 'no frames' } : { px: 1.5, tolerance_px: 9.75, past: false },
  };
  if (NO_FRAMES) {
    return { version: 1, frame_id: null, captured_at: null, l1: l1(), ...optional };
  }
  const now = Date.now();
  return {
    version: 1,
    frame_id: frameId(),
    captured_at: new Date(now).toISOString(),
    l1: l1(),
    l0: {
      // The previous frame, so the page's L0 age readout has something to show.
      frame_id: `stub-${frameNumber - 1}`,
      captured_at: new Date(now - Math.round(1000 / FPS)).toISOString(),
      detections: [car()],
    },
    scores: scores(),
    threshold: 0.5,
    ...(patchIds.length > 0
      ? { patches: Object.fromEntries(patchIds.map((id, i) => [id, `patch-${i}`])) }
      : {}),
    changes,
    timings: { capture_ms: 2.5, decode_ms: 11, cut_ms: 1.25, classify_ms: 30, rate_fps: FPS },
    ...optional,
  };
}

const BOUNDARY = 'liveStubBoundary';

/**
 * One `latest` answer: the `json` part, the `frame` part where there is one,
 * then each patch as `patch-0`, `patch-1`, ... in the order `json.patches` names them.
 */
function writeMultipart(res, json, frame, patchPngs = []) {
  const parts = [
    Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="json"\r\n` +
        `Content-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n`
    ),
  ];
  if (frame !== null) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="frame"; filename="frame.jpg"\r\n` +
          'Content-Type: image/jpeg\r\n\r\n'
      ),
      frame,
      Buffer.from('\r\n')
    );
  }
  for (const [i, bytes] of patchPngs.entries()) {
    parts.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="patch-${i}"; filename="patch-${i}.png"\r\n` +
          'Content-Type: image/png\r\n\r\n'
      ),
      bytes,
      Buffer.from('\r\n')
    );
  }
  parts.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  const body = Buffer.concat(parts);
  res.writeHead(200, {
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function writeJson(res, json, status = 200) {
  const body = Buffer.from(JSON.stringify(json));
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Wait up to about 1 s for the next frame, or until the caller leaves. */
function nextFrame(req) {
  return new Promise(done => {
    const give = () => {
      clearTimeout(timer);
      waiting.delete(give);
      done();
    };
    const timer = setTimeout(give, 1000);
    waiting.add(give);
    req.on('close', give);
  });
}

/**
 * Answer `latest`, as `LIVE.md` states it.
 *
 * With `after` set to the current id, wait up to about 1 s for a newer frame,
 * then answer with what there is. With no frames, wait about 1 s and answer
 * with only the `json` part.
 */
async function latest(req, res, after, patches) {
  if (NO_FRAMES || after === frameId()) await nextFrame(req);
  if (res.writableEnded || req.destroyed) return;
  if (NO_FRAMES) {
    writeMultipart(res, payload([]), null);
    return;
  }
  // `stub-refused` has no patch, so its cell stays empty.
  const states = l1();
  const patchIds = patches ? Object.keys(states).filter(id => id !== 'stub-refused') : [];
  writeMultipart(
    res,
    payload(patchIds),
    FRAME_JPEG,
    patchIds.map(id => PATCH_PNGS[states[id].state])
  );
}

/** One sensor's L1 entry on `events`, with its id in `sensor`. */
function sendEvent(res, id, entry) {
  res.write(`data: ${JSON.stringify({ sensor: id, ...entry })}\n\n`);
}

/** The event stream: every sensor's state on connect, then each change. */
function events(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  for (const [id, entry] of Object.entries(published)) sendEvent(res, id, entry);
  streams.add(res);
  const beat = setInterval(() => res.write(': beat\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(beat);
    streams.delete(res);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ort': 'application/octet-stream',
};

/**
 * Serve the built page, falling back to `index.html`.
 *
 * The COOP/COEP headers are the ones the dev server sets and the deploy sets:
 * ONNX Runtime's threaded WASM needs cross-origin isolation. Nothing in service
 * mode loads a model, but the editor in the same page does.
 */
async function serveStatic(req, res, pathname) {
  const wanted = pathname === '/' ? '/index.html' : pathname;
  const onDisk = join(DIST, normalize(wanted).replace(/^(\.\.[/\\])+/, ''));
  const headers = {
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
  };
  try {
    const body = await readFile(onDisk);
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(onDisk)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    try {
      const body = await readFile(join(DIST, 'index.html'));
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end(`Nothing built at ${DIST}. Run: pnpm --filter @occupancy/ui build\n`);
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  switch (url.pathname) {
    case '/live/archive/manifest.json':
      writeJson(res, MANIFEST);
      return;
    case '/live/latest':
      void latest(req, res, url.searchParams.get('after'), url.searchParams.get('patches') === '1');
      return;
    case '/live/events':
      events(res);
      return;
    default:
      void serveStatic(req, res, url.pathname);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`live-stub: serving ${DIST} and /live on port ${PORT}`);
  console.log(`  this machine:  http://localhost:${PORT}/`);
  console.log('  on the LAN:    http://<this machine’s IP>:' + PORT + '/');
  console.log(`  ${FPS} frames/s, ${NO_FRAMES ? 'no frames' : 'frames on'}${CHURN ? ', churning events' : ''}`);
});
