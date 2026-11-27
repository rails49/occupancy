import { describe, it, expect, vi, afterEach } from 'vitest';
import { heightAt, keep, kept } from '../src/detailsHeight.js';

// The height of the live view's Details panel, which the divider above it
// sets (#398).

/** The live view's box: 700 px tall, with its bottom edge at 740. */
const VIEW = { left: 0, right: 1000, top: 40, bottom: 740, width: 1000, height: 700 };

describe('detailsHeight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("measures the height from the view's bottom edge", () => {
    expect(heightAt(VIEW, { x: 500, y: 440 })).toBe(300);
  });

  it('holds the height to a least of 96 px', () => {
    expect(heightAt(VIEW, { x: 500, y: 730 })).toBe(96);
  });

  it('leaves the rest of the view 192 px', () => {
    expect(heightAt(VIEW, { x: 500, y: 50 })).toBe(508);
  });

  it('holds the least in a view too small for both', () => {
    const small = { left: 0, right: 1000, top: 0, bottom: 200, width: 1000, height: 200 };

    expect(heightAt(small, { x: 500, y: 100 })).toBe(96);
  });

  it('keeps no height until one is kept', () => {
    expect(kept()).toBeNull();
  });

  it('keeps a height in localStorage under occupancy.details', () => {
    keep(300);

    expect(localStorage.getItem('occupancy.details')).toBe('300');
    expect(kept()).toBe(300);
  });

  it('keeps no height in a browser that refuses the store', () => {
    const refuse = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);

    keep(300);

    expect(kept()).toBeNull();
  });
});
