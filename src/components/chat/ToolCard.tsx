'use client';

/**
 * 产物工具卡（Task 19）：一条 engineer 单文件任务对应的文件产物卡。
 * 📄 = agent/seed 产出、✏️ = 人工最后编辑（DESIGN §3.9 溯源）；点击通过 onOpenFile
 * 交给上层（T25 接线到查看器），本组件不直接操作查看器。
 */
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { FileEditor } from '@/lib/db/provider/types';

export interface ToolCardProps {
  path: string;
  /** 产物摘要（agent_runs.summary，子任务交接物）；null/空串则不渲染摘要行 */
  summary: string | null;
  /** 当前版本号（快照文件行；无文件行时为 0，仅显示 🆕 语义） */
  version: number;
  lastEditor: FileEditor;
  /** 正在流式生成（未定版内容） */
  streaming: boolean;
  onOpen?: (path: string) => void;
}

export function ToolCard({ path, summary, version, lastEditor, streaming, onOpen }: ToolCardProps) {
  const humanEdited = lastEditor === 'human';
  const hasSummary = summary !== null && summary.trim() !== '';
  return (
    <button
      type="button"
      onClick={() => onOpen?.(path)}
      aria-label={`打开 ${path}`}
      title={hasSummary ? `${path}\n${summary ?? ''}` : path}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-left transition-colors hover:bg-accent max-lg:min-h-11"
    >
      <span aria-hidden className="shrink-0 text-sm">
        {humanEdited ? '✏️' : '📄'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-xs text-foreground">{path}</span>
        {hasSummary && <span className="block truncate text-xs text-muted-foreground">{summary}</span>}
      </span>
      {streaming ? (
        <Badge className="shrink-0 animate-pulse">生成中</Badge>
      ) : (
        <Badge variant="outline" className={cn('shrink-0 font-mono', version === 0 && 'text-muted-foreground')}>
          {version === 0 ? '新生成' : `v${version}`}
        </Badge>
      )}
    </button>
  );
}
