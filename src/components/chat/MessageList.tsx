'use client';

/**
 * 消息流（Task 19）：用户气泡（右对齐浅底 + @ chips）、assistant 消息、干预队列卡
 * （待注入 / 已注入 {文件}）、软锁裁决卡（三按钮发精确指令文本，匹配 orchestrator.rulingOf）、
 * 回滚通知卡、领导汇报卡与产物工具卡。顶层运行错误的失败红条由 ChatPanel 呈现（state.error）。
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { roleRegistry } from '@/lib/agents/registry';
import type { AgentRole, AgentRun, FileEditor, Message } from '@/lib/db/provider/types';
import type { WorkspaceFile } from '@/lib/client/store';
import { ToolCard } from './ToolCard';

export interface MessageListProps {
  messages: readonly Message[];
  files: ReadonlyMap<string, WorkspaceFile>;
  runs: readonly AgentRun[];
  /** done/stopped 已收尾（决定领导汇报卡与裁决按钮可用性） */
  finished: boolean;
  /** 生成进行中（裁决按钮仅在编排器等待裁决时可点） */
  running: boolean;
  onOpenFile?: (path: string) => void;
  /** 以消息形式回发（裁决按钮 / 上层统一 POST /messages） */
  onSend: (content: string) => Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* meta 防御性收窄（库里 json 反序列化结果是 unknown，同 store.ts 的收窄模式） */
/* ------------------------------------------------------------------ */

interface MessageMetaView {
  mentions: AgentRole[];
  kind: string | null;
  path: string | null;
}

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && value in roleRegistry;
}

function metaViewOf(meta: Message['meta']): MessageMetaView {
  const record =
    typeof meta === 'object' && meta !== null ? (meta as unknown as Record<string, unknown>) : {};
  const rawMentions = Array.isArray(record['mentions']) ? record['mentions'] : [];
  const rawKind = record['kind'];
  const rawPath = record['path'];
  return {
    mentions: rawMentions.filter(isAgentRole),
    kind: typeof rawKind === 'string' && rawKind !== '' ? rawKind : null,
    path: typeof rawPath === 'string' && rawPath !== '' ? rawPath : null,
  };
}

/* ------------------------------------------------------------------ */
/* 产物工具卡派生                                                       */
/* ------------------------------------------------------------------ */

type ToolCardItem = {
  path: string;
  summary: string | null;
  version: number;
  lastEditor: FileEditor;
  streaming: boolean;
};

/** engineer 单文件任务（taskKey=`engineer:{path}`）+ 文件态 → 工具卡（同路径取最新 run） */
function toolCardsOf(runs: readonly AgentRun[], files: ReadonlyMap<string, WorkspaceFile>): ToolCardItem[] {
  const prefix = 'engineer:';
  const byPath = new Map<string, ToolCardItem>();
  for (const run of runs) {
    if (!run.taskKey.startsWith(prefix)) continue;
    const path = run.taskKey.slice(prefix.length);
    if (path === '') continue;
    const file = files.get(path);
    byPath.set(path, {
      path,
      summary: run.summary,
      version: file?.version ?? 0,
      lastEditor: file?.lastEditor ?? 'engineer',
      streaming: file?.streaming ?? false,
    });
  }
  return [...byPath.values()];
}

/* ------------------------------------------------------------------ */
/* 小组件（与消息流强相关，同文件内聚）                                   */
/* ------------------------------------------------------------------ */

/** @ 指定成员 chips（用户消息 / 干预消息的 mentions） */
function MentionChips({ mentions, alignEnd }: { mentions: readonly AgentRole[]; alignEnd: boolean }) {
  if (mentions.length === 0) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', alignEnd ? 'justify-end' : 'justify-start')}>
      {mentions.map((role) => {
        const meta = roleRegistry[role];
        return (
          <span
            key={role}
            className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            <span aria-hidden style={{ color: meta.color }}>
              {meta.emoji}
            </span>
            {meta.name}
          </span>
        );
      })}
    </div>
  );
}

/** 干预队列卡：待注入（delivered_at 为空）= 排队中；已注入 = 显示注入边界对应的文件 */
function InterventionCard({ message, view }: { message: Message; view: MessageMetaView }) {
  const pending = message.deliveredAt === null;
  return (
    <div className="flex flex-col items-start gap-1">
      <div
        className={cn(
          'w-full max-w-[92%] rounded-lg border px-2.5 py-2 text-sm',
          pending ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50',
        )}
      >
        <p className={cn('text-[11px] font-medium', pending ? 'text-amber-800' : 'text-emerald-700')}>
          {pending
            ? '📥 排队中，将注入下一任务边界'
            : view.path === null
              ? '已注入下一步骤'
              : `已注入 ${view.path}`}
        </p>
        <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{message.content}</p>
      </div>
      <MentionChips mentions={view.mentions} alignEnd={false} />
    </div>
  );
}

/** 软锁裁决卡（DESIGN §3.9）：按钮发送精确指令文本，收窄自由文本关键词碰撞 */
const RULING_TEXTS = { keep: '保留', override: '覆盖', later: '稍后' } as const;

function SoftLockCard({
  message,
  view,
  running,
  onSend,
}: {
  message: Message;
  view: MessageMetaView;
  running: boolean;
  onSend: (content: string) => Promise<boolean>;
}) {
  // 已发送的裁决置灰（失败恢复可再点）；非运行中不可裁决（避免误开新一轮）
  const [sent, setSent] = useState<string | null>(null);
  const disabled = !running || sent !== null;
  const rule = (content: string): void => {
    if (disabled) return;
    setSent(content);
    void onSend(content).then((ok) => {
      if (!ok) setSent(null);
    });
  };

  return (
    <div className="w-full max-w-[92%] rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2 text-sm">
      <p className="flex items-center gap-1 text-[11px] font-medium text-amber-800">
        <span aria-hidden>⚠️</span> 需要你裁决
        {view.path !== null && <span className="font-mono font-normal">{view.path}</span>}
      </p>
      <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{message.content}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" disabled={disabled} onClick={() => rule(RULING_TEXTS.keep)} className="max-lg:h-11">
          保留修改并跳过
        </Button>
        <Button size="sm" disabled={disabled} onClick={() => rule(RULING_TEXTS.override)} className="max-lg:h-11">
          覆盖生成
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => rule(RULING_TEXTS.later)}
          className="max-lg:h-11"
        >
          完成编辑后继续
        </Button>
      </div>
    </div>
  );
}

/** 回滚通知卡（DESIGN §3.10 项目级回滚的聊天区留痕） */
function RestoreCard({ message }: { message: Message }) {
  return (
    <div className="w-full max-w-[92%] rounded-lg border border-border bg-panel px-2.5 py-2 text-sm">
      <p className="text-[11px] font-medium text-muted-foreground">↩️ 回滚通知</p>
      <p className="mt-1 whitespace-pre-wrap break-words text-foreground">{message.content}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 消息流                                                               */
/* ------------------------------------------------------------------ */

export function MessageList({
  messages,
  files,
  runs,
  finished,
  running,
  onOpenFile,
  onSend,
}: MessageListProps) {
  if (messages.length === 0 && runs.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-sm text-muted-foreground">还没有消息。描述你的需求，生成过程会在这里实时直播</p>
      </div>
    );
  }

  const toolCards = toolCardsOf(runs, files);

  return (
    <div className="flex flex-col gap-3 p-3">
      {messages.map((message, index) => {
        const view = metaViewOf(message.meta);
        if (message.role === 'intervention') {
          return <InterventionCard key={message.id} message={message} view={view} />;
        }
        if (message.role === 'assistant' && view.kind === 'softlock') {
          return <SoftLockCard key={message.id} message={message} view={view} running={running} onSend={onSend} />;
        }
        if (message.role === 'assistant' && view.kind === 'restore') {
          return <RestoreCard key={message.id} message={message} />;
        }
        if (message.role === 'system') {
          return (
            <p
              key={message.id}
              className="self-center rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground"
            >
              {message.content}
            </p>
          );
        }

        const isUser = message.role === 'user';
        // 领导汇报卡：收尾后消息流最后一条 assistant 消息（closer 的收尾汇报）
        const isClosingReport = !isUser && finished && index === messages.length - 1;
        return (
          <div key={message.id} className={cn('flex flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
            {isClosingReport && (
              <span className="text-[11px] font-medium text-brand">
                <span aria-hidden>🧭</span> 领导汇报
              </span>
            )}
            <div
              className={cn(
                'max-w-[88%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap text-foreground',
                isUser ? 'rounded-br-sm bg-muted' : 'rounded-bl-sm border border-border bg-background',
                isClosingReport && 'border-brand/40 bg-brand/5',
              )}
            >
              {message.content}
            </div>
            <MentionChips mentions={view.mentions} alignEnd={isUser} />
          </div>
        );
      })}

      {toolCards.length > 0 && (
        /* key 用路径（files 表 per project 唯一） */
        <section aria-label="产物文件" className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">本轮产物</h3>
          {toolCards.map((card) => (
            <ToolCard
              key={card.path}
              path={card.path}
              summary={card.summary}
              version={card.version}
              lastEditor={card.lastEditor}
              streaming={card.streaming}
              onOpen={onOpenFile}
            />
          ))}
        </section>
      )}
    </div>
  );
}
