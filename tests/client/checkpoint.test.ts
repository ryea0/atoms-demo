/**
 * Task 25 检查点选择纯函数：时间线「回到此任务前」的 run → 检查点映射口径。
 * 打点在任务前（afterRunId=打点时刻最大 run id），故目标 = afterRunId < run.id 中最大者。
 */
import { describe, expect, it } from 'vitest';
import { checkpointIdForRun, checkpointLabelOf } from '@/lib/client/checkpoint';
import type { Checkpoint } from '@/lib/db/provider/types';

function cp(id: number, afterRunId: number, label = `任务前:task-${id}`): Checkpoint {
  return { id, projectId: 1, label, agentRunId: null, afterRunId, createdAt: 1_700_000_000_000 + id };
}

describe('checkpointIdForRun', () => {
  it('取 afterRunId < run.id 里最大者（该任务开跑前的打点）', () => {
    const checkpoints = [cp(1, 0), cp(2, 5), cp(3, 12)];
    expect(checkpointIdForRun(checkpoints, 20)).toBe(3);
    expect(checkpointIdForRun(checkpoints, 6)).toBe(2);
    expect(checkpointIdForRun(checkpoints, 1)).toBe(1);
  });

  it('afterRunId 并列取 id 大者（最近一次打点）', () => {
    expect(checkpointIdForRun([cp(4, 3), cp(2, 3), cp(1, 0)], 9)).toBe(4);
  });

  it('打点晚于该 run 的检查点不参与（否则会「回滚到未来」）', () => {
    expect(checkpointIdForRun([cp(1, 50), cp(2, 60)], 42)).toBeNull();
  });

  it('无检查点返回 null', () => {
    expect(checkpointIdForRun([], 1)).toBeNull();
  });
});

describe('checkpointLabelOf', () => {
  it('「任务前:{taskKey}」折算成任务键；其余 label 原样', () => {
    expect(checkpointLabelOf(cp(1, 0, '任务前:engineer-app'))).toBe('engineer-app');
    expect(checkpointLabelOf(cp(2, 0, '手动打标'))).toBe('手动打标');
  });
});
