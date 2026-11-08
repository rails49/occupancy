/**
 * Answers shaped the way an occupancy service's `LIVE.md` shapes them (#331).
 *
 * The multipart bodies here are built **byte by byte**, with a boundary and
 * `Content-Disposition` headers, and handed to a real `Response` — so
 * `response.formData()`, the browser parser the reader leans on, is the thing
 * under test rather than a stand-in for it. A body assembled with `FormData`
 * would prove only that `FormData` round-trips through itself.
 */

import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { jpeg } from './jpegFixture.js';

/**
 * Put Node's `File` and `Blob` on the globals for the body of a suite, and put
 * jsdom's back afterwards.
 *
 * **A jsdom gap, not a shortcut.** `Response.formData()` here is Node's — jsdom
 * implements no fetch — and its multipart parser builds each part with the
 * global `File` and then brand-checks it, which jsdom's `File` fails. Nothing
 * under test is replaced: the bodies are still real multipart bytes and the
 * parser is still the one a browser would run. The source's `instanceof Blob`
 * resolves the global when it runs, so `Blob` goes with `File`.
 *
 * Scoped to the suites that parse a multipart body rather than put in
 * `setup.ts`, because every other test file wants jsdom's two.
 */
export function useNodeFileGlobals(): { install(): void; restore(): void } {
  const jsdom = { File: globalThis.File, Blob: globalThis.Blob };
  return {
    install() {
      globalThis.File = NodeFile as unknown as typeof globalThis.File;
      globalThis.Blob = NodeBlob as unknown as typeof globalThis.Blob;
    },
    restore() {
      globalThis.File = jsdom.File;
      globalThis.Blob = jsdom.Blob;
    },
  };
}

/** A small JPEG, header-valid and never decoded by these tests. */
export const FRAME_BYTES = jpeg();

const BOUNDARY = 'r49LiveBoundary';

/** The content type a multipart answer carries, boundary included. */
export const MULTIPART_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;

/** The parts as one buffer, which is what a `Response` body takes. */
function concat(parts: Uint8Array[]): ArrayBuffer {
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    body.set(part, at);
    at += part.length;
  }
  return body.buffer as ArrayBuffer;
}

const text = (value: string) => new TextEncoder().encode(value);

/** A binary part after the frame, such as `patch-0`, sent with a `filename`. */
export interface ExtraPart {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * A `latest` answer: the `json` part, then the `frame` part, then any others.
 *
 * @param payload what goes in the `json` part, serialised as given — so a test
 *                can send a wrong `version` or a field of the wrong type.
 * @param frame   the `frame` part's bytes, or `null` to leave the part out,
 *                which is how the service says it has no frame.
 * @param extra   further binary parts, as PNGs, such as the patches.
 */
export function multipartAnswer(
  payload: unknown,
  frame: Uint8Array | null = FRAME_BYTES,
  extra: readonly ExtraPart[] = []
): Response {
  const parts: Uint8Array[] = [
    text(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="json"\r\n` +
        'Content-Type: application/json\r\n\r\n'
    ),
    text(JSON.stringify(payload)),
  ];
  if (frame !== null) {
    parts.push(
      text(
        `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="frame"; ` +
          'filename="frame.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'
      ),
      frame
    );
  }
  for (const part of extra) {
    parts.push(
      text(
        `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"; ` +
          `filename="${part.name}.png"\r\nContent-Type: image/png\r\n\r\n`
      ),
      part.bytes
    );
  }
  parts.push(text(`\r\n--${BOUNDARY}--\r\n`));

  return new Response(concat(parts), { headers: { 'content-type': MULTIPART_TYPE } });
}

/** A plain JSON answer, as the manifest is served. */
export function jsonAnswer(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The page's own HTML, which is what the door answers with when the service
 * behind it is down and what the cloud copy answers every unknown path with.
 */
export function htmlAnswer(status = 200): Response {
  return new Response('<!doctype html><title>occupancy</title>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** A service that fell over. */
export function errorAnswer(status = 500): Response {
  return new Response('upstream failed', {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}
