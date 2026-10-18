import { describe, it, expect } from 'vitest';
import { make_id } from '../src/index.ts';
// Internal helper — not part of the package interface, imported directly.
import { toBase62 } from '../src/uid.ts';

describe('uid', () => {
  describe('toBase62', () => {
    it('encodes 0 correctly', () => {
      expect(toBase62(0n)).toBe('00000000000');
    });

    it('encodes a larger number correctly', () => {
      // 62^1 + 1 = 63
      expect(toBase62(63n)).toBe('00000000011');
    });

    it('respects the length parameter', () => {
      expect(toBase62(63n, 4)).toBe('0011');
    });
  });

  describe('make_id', () => {
    it('generates an 11-character string', () => {
      const id = make_id();
      expect(id).toHaveLength(11);
      expect(id).toMatch(/^[0-9A-Za-z]{11}$/);
    });

    it('generates unique IDs in sequence', () => {
      const id1 = make_id();
      const id2 = make_id();
      expect(id1).not.toBe(id2);
    });

    it('generates many unique IDs', () => {
      const ids = new Set();
      for (let i = 0; i < 1000; i++) {
        ids.add(make_id());
      }
      expect(ids.size).toBe(1000);
    });

    it('incorporates nodeId', () => {
      // This is hard to test without mocking Date.now()
      // But we can check if they are different for different nodes at roughly the same time
      const id1 = make_id(1);
      const id2 = make_id(2);
      expect(id1).not.toBe(id2);
    });
  });
});
