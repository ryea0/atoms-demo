'use client';

/**
 * 值级 debounce（Task 21 查看器流式渲染用）。
 *
 * 流式期间内容高频到达，但重活（Shiki 高亮 / markdown 重解析 / mermaid 重渲染）不必逐 delta 做：
 * 延迟窗口内的多次更新只保留最后一次（trailing），窗口结束才真正消费。
 * delayMs <= 0 表示立即同步（非流式内容直达，不引入可感知延迟）。
 */
import { useEffect, useState } from 'react';

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [deferred, setDeferred] = useState<T>(value);

  useEffect(() => {
    if (delayMs <= 0) {
      setDeferred(value);
      return;
    }
    const timer = setTimeout(() => setDeferred(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return deferred;
}
