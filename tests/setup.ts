/// <reference types="vitest/globals" />
import '@testing-library/jest-dom/vitest';

// projectEventBus 的 globalThis 锚点（split-brain 加固，见 src/lib/agents/events.ts 尾注）
// 在测试里按文件复位：vitest 同 worker 顺序复跑多个测试文件时模块注册表按文件隔离、
// globalThis 不隔离——不复位会让后一个文件读到前一个文件的环形缓冲/订阅者，
// 破坏「每文件全新总线」的既有测试语义。
delete (globalThis as { __atomsProjectEventBus?: unknown }).__atomsProjectEventBus;

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
