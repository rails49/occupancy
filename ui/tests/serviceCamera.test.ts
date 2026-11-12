import { describe, it, expect, vi, afterAll, afterEach, beforeAll } from 'vitest';
import { serviceCamera } from '../src/serviceCamera.js';
import { FRAME_BYTES, errorAnswer, multipartAnswer, useNodeFileGlobals } from './liveFixture.js';

// The service's camera as the editor's camera button reads it (#381): a stubbed
// `fetch` over real multipart bodies.

const fileGlobals = useNodeFileGlobals();
beforeAll(() => fileGlobals.install());
afterAll(() => fileGlobals.restore());

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** A `latest` answer for frame `id`, or with no frame where `id` is null. */
function answer(id: string | null): Response {
  return multipartAnswer(
    { version: 1, frame_id: id, captured_at: id === null ? null : '2026-11-12T10:00:00Z', l1: {} },
    id === null ? null : FRAME_BYTES
  );
}

/** Answer each `latest` with the next of `ids`, then hold. Returns the URLs asked. */
function serve(ids: (string | null | 'error')[]): string[] {
  const asked: string[] = [];
  global.fetch = vi.fn(async (url: string) => {
    asked.push(String(url));
    const id = ids.shift();
    if (id === undefined) return new Promise<Response>(() => {});
    if (id === 'error') return errorAnswer(500);
    return answer(id);
  }) as unknown as typeof fetch;
  return asked;
}

describe('serviceCamera', () => {
  it('hands over the next frame, its id and its bytes', async () => {
    serve(['f-1']);
    const frame = await serviceCamera('/live').next();

    expect(frame!.id).toBe('f-1');
    expect(new Uint8Array(await frame!.bytes.arrayBuffer())).toEqual(FRAME_BYTES);
  });

  it('asks for a frame newer than the last one it saw', async () => {
    const asked = serve(['f-1', 'f-2']);
    const camera = serviceCamera('/live');

    await camera.next();
    const second = await camera.next();

    expect(second!.id).toBe('f-2');
    expect(asked[1]).toContain('after=f-1');
  });

  // `after` holds the request about 1 s at the service, then answers with the
  // frame it has: the same one, which is not a newer frame.
  it('asks again when the service answers with the frame it already sent', async () => {
    serve(['f-1', 'f-1', 'f-2']);
    const camera = serviceCamera('/live');

    await camera.next();

    expect((await camera.next())!.id).toBe('f-2');
  });

  it('gives nothing when the answer carries no frame', async () => {
    serve([null]);
    const camera = serviceCamera('/live');

    expect(await camera.next()).toBeNull();
    expect(camera.ready).toBe(false);
  });

  it('gives nothing when the service cannot be read', async () => {
    serve(['error']);
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await serviceCamera('/live').next()).toBeNull();
  });

  describe('watch', () => {
    it('is ready while the answers carry a frame, and says when that changes', async () => {
      serve(['f-1', null, 'f-2']);
      const camera = serviceCamera('/live', 1);
      const seen: boolean[] = [];

      camera.watch(() => seen.push(camera.ready));
      await vi.waitFor(() => expect(seen).toEqual([true, false, true]));
      camera.stop();
    });

    it('is not ready when the service cannot be read', async () => {
      serve(['f-1', 'error']);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const camera = serviceCamera('/live', 1);
      const seen: boolean[] = [];

      camera.watch(() => seen.push(camera.ready));
      await vi.waitFor(() => expect(seen).toEqual([true, false]));
      camera.stop();
    });

    it('asks nothing once stopped', async () => {
      const asked = serve(['f-1', 'f-2', 'f-3']);
      const camera = serviceCamera('/live', 1);

      camera.watch(() => camera.stop());
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(asked).toHaveLength(1);
    });
  });
});
