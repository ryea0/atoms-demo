/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest';

// jsdom 不实现 matchMedia；sonner（toast）等组件挂载时会查询 prefers-color-scheme，
// 缺了会直接抛错。这里给一个恒为 light 的最小实现，够 UI 测试用。
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  const mediaQuery = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
  Object.defineProperty(window, 'matchMedia', { writable: true, value: mediaQuery });
}
