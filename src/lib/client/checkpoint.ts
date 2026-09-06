/**
 * 检查点选择纯函数（Task 25，DESIGN §3.10 时间线回滚入口）。
 *
 * 时间线的「回到此任务前」以任务（agent_runs 行）为粒度，而检查点在**任务开跑前**打点、
 * 记录的是打点时刻的最大 run id（afterRunId）。因此「该任务生成前」的检查点 =
 * afterRunId < run.id 里 afterRunId 最大的那个（并列取 id 大者，即最近一次打点）。
 * 纯函数 + 只读入参，Workspace 与测试共用同一口径。
 */
import type { Checkpoint } from '@/lib/db/provider/types';

/** run → 「回到此任务前」检查点 id；打点前的 run（无更早检查点）返回 null */
export function checkpointIdForRun(checkpoints: readonly Checkpoint[], runId: number): number | null {
  let best: Checkpoint | null = null;
  for (const checkpoint of checkpoints) {
    // 打点晚于该任务开跑（afterRunId ≥ runId）说明它不在这条 run 之前
    if (checkpoint.afterRunId >= runId) continue;
    if (best === null || checkpoint.afterRunId > best.afterRunId || (checkpoint.afterRunId === best.afterRunId && checkpoint.id > best.id)) {
      best = checkpoint;
    }
  }
  return best?.id ?? null;
}

/** 检查点 label → 时间线文案（任务前:{taskKey} → 任务键；其余原样） */
export function checkpointLabelOf(checkpoint: Checkpoint): string {
  const prefix = '任务前:';
  return checkpoint.label.startsWith(prefix) ? checkpoint.label.slice(prefix.length) : checkpoint.label;
}
