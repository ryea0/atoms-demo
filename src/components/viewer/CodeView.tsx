'use client';

/**
 * 代码视图（Task 21）：按扩展名选语言，Shiki 高亮。
 *
 * 流式态（.claude/rules/03 不逐字符重渲染整棵树）：已到内容以 120ms 合批后高亮，
 * 避免「每个 delta 一次高亮」的抖动与开销；定版内容立即高亮，不引入延迟。
 * 高亮失败（语言不支持 / 资源加载失败）降级为纯文本 pre，内容始终可见。
 */
import { useEffect, useState } from 'react';
import { highlightToHtml, HIGHLIGHT_DEBOUNCE_MS, resolveLanguage } from '@/lib/client/highlight';
import { useDebouncedValue } from '@/lib/client/use-debounced-value';

export interface CodeViewProps {
  /** 文件全文（流式期间为已到内容） */
  content: string;
  /** 文件路径（据此取语言） */
  path: string;
  /** 是否流式生成中 */
  streaming: boolean;
}

export function CodeView({ content, path, streaming }: CodeViewProps): React.ReactElement {
  const language = resolveLanguage(path);
  const debounceMs = streaming ? HIGHLIGHT_DEBOUNCE_MS : 0;
  const deferredContent = useDebouncedValue(content, debounceMs);

  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void highlightToHtml(deferredContent, language)
      .then((highlighted) => {
        if (!cancelled) setHtml(highlighted);
      })
      .catch((error: unknown) => {
        console.error('[viewer] 代码高亮失败，降级为纯文本：', error);
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deferredContent, language]);

  if (html === null) {
    // 高亮未就绪 / 失败：纯文本兜底，内容不丢失
    return (
      <pre data-testid="code-fallback" className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
        {deferredContent}
      </pre>
    );
  }

  // shiki 输出为本地生成的自包含 HTML（内容已转义，非用户可控外部输入），自带浅色主题底色
  return (
    <div
      className="text-xs leading-relaxed [&_pre]:m-0 [&_pre]:p-0"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
