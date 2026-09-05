/**
 * 展示格式化工具（Task 17）：相对时间 / token 数 / 状态中文标签。
 * 纯函数、无副作用，客户端组件直接 import（不触碰服务端模块）。
 */
import type { ProjectStatus } from '@/lib/db/provider/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期 */
export function formatRelativeTime(timestamp: number, now: number = Date.now()): string {
  const diff = now - timestamp;
  if (diff < MINUTE_MS) return '刚刚';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN');
}

/** token 数：1,250 → 1.3k；12,500 → 12.5k；1,250,000 → 1.3M（不足 1k 原样） */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return `${k >= 100 ? Math.round(k) : Math.round(k * 10) / 10}k`;
  }
  return `${Math.round((tokens / 1_000_000) * 10) / 10}M`;
}

/** 项目状态中文标签（与徽章配色映射一起构成状态展示的单一事实来源） */
export function statusLabel(status: ProjectStatus): string {
  const labels: Record<ProjectStatus, string> = {
    draft: '草稿',
    running: '生成中',
    paused: '已暂停',
    done: '已完成',
    failed: '失败',
  };
  return labels[status];
}

/** 状态 → shadcn Badge variant（不引入魔法色值，配色走既有 token） */
export function statusBadgeVariant(status: ProjectStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  const variants: Record<ProjectStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    draft: 'outline',
    running: 'default',
    paused: 'outline',
    done: 'secondary',
    failed: 'destructive',
  };
  return variants[status];
}

/** 模式标签：fast=快速（预置模板加速）/ full=完整（全量流水线） */
export function modeLabel(mode: 'fast' | 'full'): string {
  return mode === 'fast' ? '快速' : '完整';
}
