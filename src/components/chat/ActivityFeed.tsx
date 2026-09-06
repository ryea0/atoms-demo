'use client';

/**
 * 聊天区「直播活动行」（T30）：把正在进行的任务播报成次级灰字小行，给消息流补上
 * 「过程感」——打字机藏在查看器里，不点开看不到在干活。
 *
 * 取舍（实现取简）：
 * - 只直播当下：数据由 runningActivitiesOf 从 runs 派生（status==='running'），任务收尾
 *   整行消失；历史任务由时间线（Timeline）管，这里不堆历史行。
 * - 视觉与消息卡区分：无卡片边框，仅脉冲圆点 + 角色 emoji（着色）+ 中文名的小字行。
 * - 「正在写 {path}」可点击 → 走既有 onOpenFile 通道跳转查看器打字机；无路径的任务
 *   只显示任务描述文本。
 */
import type { ReactElement } from 'react';
import { roleRegistry } from '@/lib/agents/registry';
import type { ActivityItem } from '@/lib/client/activity';

export interface ActivityFeedProps {
  /** 正在进行中的活动（ChatPanel 用 runningActivitiesOf(runs) 派生后传入） */
  activities: readonly ActivityItem[];
  /** 点击「正在写 {path}」打开对应文件（T25 跨面板接线通道） */
  onOpenFile?: (path: string) => void;
}

export function ActivityFeed({ activities, onOpenFile }: ActivityFeedProps): ReactElement | null {
  if (activities.length === 0) return null;

  return (
    /* polite：不打断读屏，任务开始/结束时补一句播报 */
    <section
      aria-label="进行中的活动"
      aria-live="polite"
      className="text-muted-foreground flex flex-col gap-1 px-3 text-xs"
    >
      {activities.map((activity) => {
        const meta = roleRegistry[activity.agent];
        const { path } = activity;
        return (
          <p key={activity.runId} className="flex min-w-0 items-center gap-1.5">
            {/* 运行中脉冲点（配色与时间线 running 圆点一致） */}
            <span aria-hidden className="bg-brand size-1.5 shrink-0 animate-pulse rounded-full" />
            <span aria-hidden className="shrink-0" style={{ color: meta.color }}>
              {meta.emoji}
            </span>
            <span className="shrink-0 font-medium">{meta.name}</span>
            {path !== null ? (
              <button
                type="button"
                onClick={() => onOpenFile?.(path)}
                title={`打开 ${path} 查看流式输出`}
                className="truncate font-mono underline-offset-2 hover:text-foreground hover:underline"
              >
                正在写 {path}
              </button>
            ) : (
              <span className="truncate">{activity.task}</span>
            )}
          </p>
        );
      })}
    </section>
  );
}
