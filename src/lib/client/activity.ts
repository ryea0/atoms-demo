/**
 * 聊天区「直播活动行」派生（T30）：从既有 runs 状态里筛出正在进行的任务。
 *
 * 纯函数、无副作用，客户端组件直接 import（不触碰服务端模块）；只消费 store 既有契约
 * （AgentRun.status/taskKey/task），不改 SSE 协议。取舍：只取 status==='running'——
 * 历史任务由时间线（Timeline）管，直播区不堆历史行，任务收尾即整行消失。
 */
import type { AgentRole, AgentRun } from '@/lib/db/provider/types';

/** engineer 单文件任务键前缀（leader 协议口径，与 MessageList.toolCardsOf 一致） */
const ENGINEER_TASK_PREFIX = 'engineer:';

/** 单条进行中的活动（聊天区直播行） */
export interface ActivityItem {
  /** agent_runs.id（SSE 合成节点为负数 id，store 已去重）——列表 key 用 */
  runId: number;
  /** 执行角色（emoji / 中文名经 roleRegistry 取） */
  agent: AgentRole;
  /** `engineer:{path}` 解析出的目标文件；解析不出（非单文件任务）为 null，行不可点击 */
  path: string | null;
  /** 任务描述：run.task 优先，回退文件路径 / 原始 taskKey */
  task: string;
}

/** 取正在进行中的任务（串行 DAG 下通常最多 1 条；多条并存时全量播报，不做取舍猜测） */
export function runningActivitiesOf(runs: readonly AgentRun[]): ActivityItem[] {
  const activities: ActivityItem[] = [];
  for (const run of runs) {
    if (run.status !== 'running') continue;
    const path = run.taskKey.startsWith(ENGINEER_TASK_PREFIX)
      ? run.taskKey.slice(ENGINEER_TASK_PREFIX.length)
      : '';
    activities.push({
      runId: run.id,
      agent: run.agent,
      path: path === '' ? null : path,
      task: run.task !== '' ? run.task : (path === '' ? run.taskKey : path),
    });
  }
  return activities;
}
