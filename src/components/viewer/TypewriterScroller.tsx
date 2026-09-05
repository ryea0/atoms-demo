'use client';

/**
 * 打字机滚动容器（Task 21，.claude/rules/03「流式文本用 ref 操作滚动」）。
 *
 * 流式文件内容高频增长，容器跟随滚到底部才有「打字机」观感；但用户一旦上滚查看历史，
 * 就必须停止抢滚动条，滚回底部再恢复跟随。
 * - 跟随与暂停只改 `following` 一个状态（低频），内容增长本身不进 React state——
 *   父组件把内容长度作为 `scrollKey` 传入，这里在 useLayoutEffect 里用 ref 直接写 scrollTop。
 * - 暂停跟随时给「回到底部」按钮，一键回到流式现场并恢复跟随。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** 距底部多小以内视为「在底部」（px，容忍一次渲染的高度抖动） */
const AT_BOTTOM_THRESHOLD_PX = 24;

export interface TypewriterScrollerProps {
  /** 是否处于流式生成中（非流式时只保留「在底部不抢滚动」的自然行为） */
  streaming: boolean;
  /** 内容长度指纹：变化才触发一次滚动判定（不逐字符 setState） */
  scrollKey: number;
  children: ReactNode;
}

export function TypewriterScroller({ streaming, scrollKey, children }: TypewriterScrollerProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [following, setFollowing] = useState(true);

  useLayoutEffect(() => {
    if (!following) return;
    const element = containerRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [following, scrollKey]);

  const handleScroll = (): void => {
    const element = containerRef.current;
    if (element === null) return;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceToBottom <= AT_BOTTOM_THRESHOLD_PX;
    // 仅在状态翻转时写 state，避免滚动事件风暴导致重渲染
    setFollowing(atBottom);
  };

  const jumpToBottom = (): void => {
    const element = containerRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
    setFollowing(true);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={containerRef}
        data-testid="typewriter-scroller"
        onScroll={handleScroll}
        className="h-full overflow-auto px-4 py-3"
      >
        {children}
      </div>
      {!streaming || following ? null : (
        <button
          type="button"
          onClick={jumpToBottom}
          aria-label="回到底部"
          className="border-border bg-background text-muted-foreground hover:text-foreground absolute right-4 bottom-3 flex h-8 items-center gap-1 rounded-full border px-3 text-xs shadow-sm"
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}
