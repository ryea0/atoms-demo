'use client';

/**
 * Markdown 视图（Task 21）：react-markdown 渲染 PM/架构师产物（PRD、设计说明）。
 *
 * - 代码块走与 CodeView 同一套 Shiki 高亮（resolveLanguage 收敛语言白名单）
 * - 引用块渲染为「引用」徽章提示条（对标 Atoms 原版的引用卡）
 * - 表格/标题/列表用产品 token 排版；流式期间（streaming）按 120ms 合批重解析，
 *   避免逐 delta 重建整棵 markdown 树（.claude/rules/03）
 *
 * 已知限制：未引入 remark-gfm，管道表格按普通段落展示（新增依赖需走统一评审，见任务报告）。
 */
import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { highlightToHtml, HIGHLIGHT_DEBOUNCE_MS, resolveLanguage, type HighlightLanguage } from '@/lib/client/highlight';
import { useDebouncedValue } from '@/lib/client/use-debounced-value';

export interface MarkdownViewProps {
  /** 文件全文（流式期间为已到内容） */
  content: string;
  /** 是否流式生成中（true 时渲染按 120ms 合批） */
  streaming?: boolean;
}

/** 代码块语言提取（```tsx → tsx），无信息串回退纯文本 */
function fenceLanguage(className: string | undefined): HighlightLanguage {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return resolveLanguage(match?.[1] ?? '');
}

/** 围栏代码块：Shiki 高亮，失败降级纯文本 */
function CodeBlock({ code, language }: { code: string; language: HighlightLanguage }): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void highlightToHtml(code, language)
      .then((highlighted) => {
        if (!cancelled) setHtml(highlighted);
      })
      .catch((error: unknown) => {
        console.error('[viewer] 代码块高亮失败：', error);
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (html === null) {
    return (
      <pre className="bg-panel border-border font-mono my-3 overflow-x-auto rounded-lg border p-3 text-xs leading-relaxed">
        {code}
      </pre>
    );
  }
  // shiki 输出为本地生成的自包含 HTML（内容已转义，非用户可控外部输入）
  return (
    <div
      className="my-3 text-xs [&_pre]:m-0 [&_pre]:rounded-lg [&_pre]:p-3"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const MARKDOWN_COMPONENTS: Components = {
  // 代码块由 code 渲染器接管，pre 只做透传（避免 pre>pre 嵌套）
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    // 有语言标记 = 围栏代码块；否则是行内 code
    if (className === undefined || className === '') {
      return <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
    }
    return <CodeBlock code={String(children ?? '').replace(/\n$/, '')} language={fenceLanguage(className)} />;
  },
  blockquote: ({ children }) => (
    <blockquote className="border-brand/40 bg-brand/5 my-3 rounded-r-lg border-l-2 py-1.5 pr-3 pl-3">
      <span className="bg-brand/10 text-brand mr-2 inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium">
        引用
      </span>
      <div className="text-muted-foreground [&>p]:inline inline text-sm">{children}</div>
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="border-border my-3 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="bg-panel border-border border-b px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="border-border border-b px-3 py-1.5 text-sm">{children}</td>,
  a: ({ children, href }) => (
    <a href={href} className="text-brand decoration-brand/40 underline underline-offset-2">
      {children}
    </a>
  ),
};

const TYPOGRAPHY_CLASSES =
  'text-foreground max-w-none text-sm leading-relaxed [&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold ' +
  '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold ' +
  '[&_h4]:mt-3 [&_h4]:mb-1.5 [&_h4]:text-sm [&_h4]:font-semibold [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 ' +
  '[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_hr]:border-border [&_hr]:my-4';

export function MarkdownView({ content, streaming = false }: MarkdownViewProps): React.ReactElement {
  const shown = useDebouncedValue(content, streaming ? HIGHLIGHT_DEBOUNCE_MS : 0);

  return (
    <div className={TYPOGRAPHY_CLASSES}>
      <Markdown components={MARKDOWN_COMPONENTS}>{shown}</Markdown>
    </div>
  );
}
