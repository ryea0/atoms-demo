'use client';

/**
 * 任务时间线（Task 19，DESIGN §2 聊天区「任务时间线」）：圆点 + 竖线，每任务一行
 * （角色 emoji + 名称 + 状态），⭐ 标记用户 @ 直派的任务（taskKey 前缀 `user-`，
 * 见 leader.ts 的 @ 直派通道），失败任务红字透出错误，「回到此任务前」按钮回调
 * onRollback（T25 接线到检查点回滚，未接线时为禁用占位）。
 */
import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { roleRegistry } from '@/lib/agents/registry';
import type { AgentRun, RunStatus } from '@/lib/db/provider/types';

export interface TimelineProps {
  runs: readonly AgentRun[];
  onRollback?: (runId: number) => void;
  /** 生成进行中：回滚禁用（串行写模型，规则 2——服务端 restore 路由同守卫兜底 409） */
  running?: boolean;
}

/** 任务状态 → 圆点配色 / 标记字符 / 中文标签（brief：pending 灰 / running 蓝脉冲 / done 绿✓ / failed 红 / stopped 灰⏸） */
const STATUS_META: Record<RunStatus, { label: string; dot: string; mark: string; text: string }> = {
  pending: { label: '待执行', dot: 'border border-border bg-background', mark: '', text: 'text-muted-foreground' },
  running: { label: '进行中', dot: 'bg-brand animate-pulse', mark: '', text: 'text-brand' },
  done: { label: '已完成', dot: 'bg-emerald-500', mark: '✓', text: 'text-muted-foreground' },
  failed: { label: '失败', dot: 'bg-destructive', mark: '✕', text: 'text-destructive' },
  stopped: { label: '已停止', dot: 'bg-muted-foreground/40', mark: '⏸', text: 'text-muted-foreground' },
  rolled_back: { label: '已回滚', dot: 'bg-muted-foreground/40', mark: '↩', text: 'text-muted-foreground' },
};

/** 用户 @ 直派的任务键（leader.ts：`user-{agent}-{index}`） */
function isUserPicked(taskKey: string): boolean {
  return taskKey.startsWith('user-');
}

/** engineer 单文件任务键（`engineer:{path}`）→ 展示用的文件路径；其余原样返回 */
function taskLabel(run: AgentRun): string {
  if (run.task !== '') return run.task;
  if (run.taskKey.startsWith('engineer:')) return run.taskKey.slice('engineer:'.length);
  return run.taskKey;
}

export function Timeline({ runs, onRollback, running = false }: TimelineProps) {
  return (
    <section aria-label="任务时间线" className="border-t border-border bg-panel px-3 py-2.5">
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">任务时间线</h3>
      <ol className="flex flex-col">
        {runs.map((run) => {
          const meta = STATUS_META[run.status];
          const role = roleRegistry[run.agent];
          const label = taskLabel(run);
          return (
            /* key 用 agent_runs.id（store 已做负数合成 id 去重），禁用数组索引 */
            <li key={run.id} className="relative flex flex-col gap-0.5 py-1.5 pl-5">
              {/* 竖线（本行的连接段；圆点与其同心） */}
              <span aria-hidden className="absolute left-[6px] top-0 h-full w-px -translate-x-1/2 bg-border" />
              <span
                aria-hidden
                className={cn(
                  'absolute left-0 top-2.5 flex size-3 items-center justify-center rounded-full text-[8px] font-semibold leading-none text-white',
                  meta.dot,
                )}
              >
                {meta.mark}
              </span>

              <div className="flex min-w-0 items-center gap-1.5">
                <span aria-hidden className="shrink-0 text-xs" style={{ color: role.color }}>
                  {role.emoji}
                </span>
                <span className="shrink-0 text-xs font-medium text-foreground">{role.name}</span>
                {isUserPicked(run.taskKey) && (
                  <span className="shrink-0 text-[10px] text-brand">⭐ 用户指定</span>
                )}
                <span className={cn('ml-auto shrink-0 text-[10px]', meta.text)}>{meta.label}</span>
              </div>

              <p className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={label}>
                {label}
              </p>
              {run.error !== null && run.error !== '' && (
                <p className="break-words text-[11px] text-destructive" role="alert">
                  {run.error}
                </p>
              )}

              <Button
                variant="ghost"
                size="xs"
                aria-label={`回到此任务前：${label}`}
                title={
                  running
                    ? '生成进行中，暂不能回滚：请先停止或等待本轮完成'
                    : '回到此任务生成前的检查点（项目级回滚）'
                }
                disabled={onRollback === undefined || running}
                onClick={() => onRollback?.(run.id)}
                className="mt-0.5 -ml-1 w-fit text-muted-foreground max-lg:h-11"
              >
                <Undo2 className="size-3" aria-hidden />
                回到此任务前
              </Button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
