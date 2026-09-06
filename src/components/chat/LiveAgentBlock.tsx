'use client';

/**
 * 聊天区「直播转录块」（T31）：把活跃成员的思考流与产出尾流实时播进聊天区，
 * 取代 T30 的单行活动播报（ActivityFeed）——窄屏单栏下过程信息不再只藏在文件树/查看器。
 *
 * 数据来自 store.liveAgents（SSE reasoning/file_start/delta/agent_end/任务级 error 推进，ephemeral）。
 * 取舍：
 * - 只直播当下：块随轮次收口整体清空，历史交时间线与消息流（与 T30 同一口径）。
 * - 思考流默认展开、可折叠；容器滚动贴底用 ref 操作（规则 03：流式文本不逐字符 setState）。
 * - 「正在写 {path}」与「打开文件」都走既有 onOpenFile 通道跳查看器打字机。
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { roleRegistry } from '@/lib/agents/registry';
import type { AgentRole } from '@/lib/db/provider/types';
import type { LiveAgentState } from '@/lib/client/store';

function isAgentRole(value: string): value is AgentRole {
  return value in roleRegistry;
}

/** 状态徽章：思考中… / 正在写 {path}（可点） / 已完成 / 已失败（T32 I1：任务级错误终态） */
function StatusBadge({
  state,
  onOpenFile,
}: {
  state: LiveAgentState;
  onOpenFile?: (path: string) => void;
}): ReactElement {
  if (state.status === 'writing' && state.outputPath !== null) {
    return (
      <button
        type="button"
        onClick={() => onOpenFile?.(state.outputPath ?? '')}
        title={`打开 ${state.outputPath} 查看流式输出`}
        className="truncate font-mono text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        正在写 {state.outputPath}
      </button>
    );
  }
  if (state.status === 'done') {
    return <span className="shrink-0 text-[11px] text-emerald-700">已完成</span>;
  }
  if (state.status === 'failed') {
    return <span className="shrink-0 text-[11px] text-destructive">已失败</span>;
  }
  return (
    <span className="text-muted-foreground shrink-0 animate-pulse text-[11px]">
      {state.status === 'writing' ? '正在写…' : '思考中…'}
    </span>
  );
}

/** 单个成员的直播块：头部（成员 + 动作徽章）+ 💭 思考流 + 📝 产出尾流 */
function LiveAgentCard({
  agent,
  state,
  onOpenFile,
}: {
  agent: AgentRole;
  state: LiveAgentState;
  onOpenFile?: (path: string) => void;
}): ReactElement {
  const meta = roleRegistry[agent];
  const [open, setOpen] = useState(true);
  const thinkingRef = useRef<HTMLDivElement | null>(null);

  // 思考流贴底：只滚容器（ref），不让整棵树跟着流式文本重渲染
  useEffect(() => {
    const element = thinkingRef.current;
    if (element !== null && open) element.scrollTop = element.scrollHeight;
  }, [state.reasoning, open]);

  return (
    <div className="rounded-lg border border-border bg-panel px-2.5 py-2">
      <div className="flex min-w-0 items-center gap-1.5">
        {(state.status === 'thinking' || state.status === 'writing') && (
          <span aria-hidden className="bg-brand size-1.5 shrink-0 animate-pulse rounded-full" />
        )}
        <span aria-hidden className="shrink-0" style={{ color: meta.color }}>
          {meta.emoji}
        </span>
        <span className="shrink-0 text-xs font-medium">{meta.name}</span>
        <span aria-hidden className="text-muted-foreground shrink-0 text-[11px]">
          ·
        </span>
        <StatusBadge state={state} onOpenFile={onOpenFile} />
      </div>

      {state.reasoning !== '' && (
        <div className="mt-1.5">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="text-muted-foreground inline-flex items-center gap-1 text-[11px] hover:text-foreground"
          >
            <span aria-hidden>💭</span> 思考
            <span aria-hidden>{open ? '▾' : '▸'}</span>
          </button>
          {open && (
            <div
              ref={thinkingRef}
              className="text-muted-foreground mt-1 max-h-40 overflow-y-auto rounded-md bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
            >
              {state.reasoning}
            </div>
          )}
        </div>
      )}

      {state.status === 'writing' && state.outputTail !== '' && state.outputPath !== null && (
        <div className="mt-1.5">
          <p className="font-mono text-[11px] text-foreground">📝 {state.outputPath}</p>
          {/* 尾部渐隐预览：只露最后几百字符，完整内容在查看器（顶部盖一层向下的背景渐变） */}
          <div className="relative mt-1 overflow-hidden rounded-md bg-background">
            <div
              aria-hidden
              className="from-panel pointer-events-none absolute inset-x-0 top-0 z-10 h-5 bg-gradient-to-b to-transparent"
            />
            <div className="text-muted-foreground max-h-24 overflow-hidden px-2 pb-1 pt-4 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
              {state.outputTail}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onOpenFile?.(state.outputPath ?? '')}
            className="text-brand mt-1 text-[11px] underline-offset-2 hover:underline"
          >
            打开文件
          </button>
        </div>
      )}

      {state.status === 'done' && state.summary !== undefined && state.summary !== '' && (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-[11px] break-words">{state.summary}</p>
      )}
    </div>
  );
}

export interface LiveAgentBlockProps {
  /** 活跃成员直播转录（store.liveAgents，键=agent；空对象不渲染） */
  live: Record<string, LiveAgentState>;
  /** 打开产出文件（T25 跨面板接线通道，与活动行/工具卡同一出口） */
  onOpenFile?: (path: string) => void;
}

export function LiveAgentBlock({ live, onOpenFile }: LiveAgentBlockProps): ReactElement | null {
  const entries = Object.entries(live).filter((entry): entry is [AgentRole, LiveAgentState] => isAgentRole(entry[0]));
  if (entries.length === 0) return null;

  return (
    /* polite：不打断读屏，块出现/状态变化时补一句播报 */
    <section aria-label="进行中的成员" aria-live="polite" className="flex flex-col gap-2 px-3">
      {entries.map(([agent, state]) => (
        <LiveAgentCard key={agent} agent={agent} state={state} onOpenFile={onOpenFile} />
      ))}
    </section>
  );
}
