'use client';

/**
 * Mermaid 视图（Task 21）：架构图 / 流程图渲染（.mmd / .mermaid）。
 *
 * 依赖纪律（.claude/rules/02）：mermaid 体量大且 import 期就触碰浏览器 API，
 * 因此三层隔离——本组件由 ViewerTabs 经 next/dynamic(ssr:false) 懒加载；
 * 组件内部再用 dynamic import 拉取 mermaid（首次渲染才加载），SSR 阶段绝不求值。
 *
 * 失败降级（brief 明确要求）：mermaid.render 抛错 → 不吞掉，显示源码 +
 * 「图表语法错误」提示条（语法修正后内容更新会自动重试渲染）。
 */
import { useEffect, useState } from 'react';
import type { Mermaid } from 'mermaid';
import { HIGHLIGHT_DEBOUNCE_MS } from '@/lib/client/highlight';
import { useDebouncedValue } from '@/lib/client/use-debounced-value';

export interface MermaidViewProps {
  /** 图表源码 */
  content: string;
  /** 是否流式生成中（true 时按 120ms 合批后再尝试渲染） */
  streaming?: boolean;
}

/** mermaid 模块懒加载单例（initialize 只做一次） */
let mermaidLoader: Promise<Mermaid> | null = null;

function loadMermaid(): Promise<Mermaid> {
  if (mermaidLoader === null) {
    mermaidLoader = import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'default' });
      return mermaid;
    });
  }
  return mermaidLoader;
}

/** 渲染实例 id 必须唯一（mermaid 以 id 挂临时节点） */
let renderSequence = 0;

interface MermaidState {
  /** 最近一次渲染成功的 SVG（渲染失败时保留旧图，避免闪空） */
  svg: string | null;
  /** 最近一次渲染是否失败（true 时显示源码 + 提示条） */
  failed: boolean;
}

const IDLE_STATE: MermaidState = { svg: null, failed: false };

export function MermaidView({ content, streaming = false }: MermaidViewProps): React.ReactElement {
  // 流式期间 mermaid 渲染很重（布局 + 排版），与高亮同口径 120ms 合批
  const shown = useDebouncedValue(content, streaming ? HIGHLIGHT_DEBOUNCE_MS : 0);
  const [state, setState] = useState<MermaidState>(IDLE_STATE);

  useEffect(() => {
    if (shown.trim() === '') return;
    let cancelled = false;
    renderSequence += 1;
    const renderId = `atoms-mermaid-${renderSequence}`;

    void loadMermaid()
      .then((mermaid) => mermaid.render(renderId, shown))
      .then((result) => {
        if (!cancelled) setState({ svg: result.svg, failed: false });
      })
      .catch((error: unknown) => {
        console.error('[viewer] mermaid 渲染失败，降级显示源码：', error);
        if (!cancelled) setState((prev) => ({ svg: prev.svg, failed: true }));
      });

    return () => {
      cancelled = true;
    };
  }, [shown]);

  return (
    <div className="flex h-full flex-col gap-2 px-4 py-3">
      {state.failed ? (
        <p
          role="alert"
          className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs"
        >
          <span className="font-medium">图表语法错误</span>
          <span>已显示源码，修正后自动重新渲染</span>
        </p>
      ) : null}

      {state.svg === null ? null : (
        <div
          className="[&_svg]:max-w-full flex min-h-0 flex-1 items-start justify-center overflow-auto"
          // mermaid 输出（securityLevel=strict 已消毒）为本地生成的自包含 SVG
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      )}

      {state.failed ? (
        <pre className="bg-panel border-border font-mono max-h-1/2 overflow-auto rounded-lg border p-3 text-xs leading-relaxed">
          {shown}
        </pre>
      ) : null}
    </div>
  );
}
