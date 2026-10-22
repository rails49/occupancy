import { vi } from 'vitest';

// The DOM polyfills below are guarded on a DOM being there at all: a test file
// that runs `vite build` asks for the node environment, where esbuild refuses
// jsdom's `TextEncoder` (`modelAssets.test.ts`).
const hasDom = typeof window !== 'undefined';

// Mock getAnimations and animate for Shoelace components
if (hasDom && typeof Element.prototype.getAnimations === 'undefined') {
  Element.prototype.getAnimations = () => [];
}
if (hasDom && typeof Element.prototype.animate === 'undefined') {
  Element.prototype.animate = () => ({
    finished: Promise.resolve(),
    cancel: vi.fn(),
    pause: vi.fn(),
    play: vi.fn(),
    reverse: vi.fn(),
    onfinish: null,
    oncancel: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as any);
}

// Mock ResizeObserver
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}

// Mock IntersectionObserver
if (typeof global.IntersectionObserver === 'undefined') {
  global.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
}

// Mock URL.createObjectURL and revokeObjectURL
if (typeof global.URL.createObjectURL === 'undefined') {
  global.URL.createObjectURL = vi.fn();
}
if (typeof global.URL.revokeObjectURL === 'undefined') {
  global.URL.revokeObjectURL = vi.fn();
}

// Mock window.matchMedia
if (hasDom && typeof window.matchMedia === 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
