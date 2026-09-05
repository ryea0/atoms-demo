/**
 * SQLite agent_runs 仓库（DESIGN §12 按仓库分组实现之一）。
 * 约定（CLAUDE.md 规则 7/9、.claude/rules/05）：
 * - summary 是子任务间唯一交接物（任务间零历史共享，只传 summary + 按需重读文件），因此更新必须可部分推进
 * - 所有查询强制 project_id 过滤；updateAgentRun 按 brief 原签名只收 id，可选 projectId
 *   提供时叠加项目作用域（防御回放/批量场景混入他项目 id，同 repo-messages.markDelivered 的处理）
 * - 回滚 = restoreCheckpoint 恢复 files 后，由编排器再调 markRunsRolledBack 把 ≤ uptoRunId 的任务改标
 */
import { and, asc, eq, lte } from 'drizzle-orm';
import { agentRuns } from './schema';
import type { SqliteDb } from './storage';
import type { AgentRun, CreateAgentRunInput, RunsRepo, UpdateAgentRunPatch } from '../types';

/** 行 → 领域类型映射：把 schema 形状挡在仓库层内 */
function toAgentRun(row: typeof agentRuns.$inferSelect): AgentRun {
  return {
    id: row.id,
    projectId: row.projectId,
    taskKey: row.taskKey,
    agent: row.agent,
    task: row.task,
    status: row.status,
    summary: row.summary,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    error: row.error,
  };
}

export function createRunsRepo(db: SqliteDb): RunsRepo {
  return {
    /** 建任务记录：status 由库默认值兜底为 pending，started_at 由编排器真正开跑时补 */
    async createAgentRun(input: CreateAgentRunInput): Promise<AgentRun> {
      const rows = await db
        .insert(agentRuns)
        .values({
          projectId: input.projectId,
          taskKey: input.taskKey,
          agent: input.agent,
          task: input.task,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('任务记录写入失败：insert 未返回行');
      return toAgentRun(row);
    },

    /**
     * 部分推进：undefined = 不写该列，null = 显式清空（summary/error/时间戳均可回空）。
     * 空 patch 直接返回（drizzle 空 set 会抛错）；未命中（含被 projectId 作用域挡下）按无操作处理，
     * 与 markDelivered 一致——调用方持有 id 即视为已校验，静默吞掉越权写。
     */
    async updateAgentRun(id: number, patch: UpdateAgentRunPatch, projectId?: number): Promise<void> {
      const set: Partial<typeof agentRuns.$inferInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.summary !== undefined) set.summary = patch.summary ?? null;
      if (patch.error !== undefined) set.error = patch.error ?? null;
      if (patch.startedAt !== undefined) set.startedAt = patch.startedAt ?? null;
      if (patch.endedAt !== undefined) set.endedAt = patch.endedAt ?? null;
      if (Object.keys(set).length === 0) return;
      await db
        .update(agentRuns)
        .set(set)
        .where(
          projectId === undefined
            ? eq(agentRuns.id, id)
            : and(eq(agentRuns.id, id), eq(agentRuns.projectId, projectId)),
        );
    },

    /** 任务时间线（created_at 正序，并列按 id 稳定排序） */
    async listAgentRuns(projectId: number): Promise<AgentRun[]> {
      const rows = await db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.projectId, projectId))
        .orderBy(asc(agentRuns.createdAt), asc(agentRuns.id));
      return rows.map(toAgentRun);
    },

    /** 检查点回滚配套：只改状态，不抹 summary/时间戳（时间线展示与事后追溯都要用） */
    async markRunsRolledBack(projectId: number, uptoRunId: number): Promise<void> {
      await db
        .update(agentRuns)
        .set({ status: 'rolled_back' })
        .where(and(eq(agentRuns.projectId, projectId), lte(agentRuns.id, uptoRunId)));
    },
  };
}
