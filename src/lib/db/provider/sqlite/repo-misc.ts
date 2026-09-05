/**
 * SQLite 杂项仓库（DESIGN §12 按仓库分组实现之一）：项目级检查点 + llm_calls 计量 + 个人偏好。
 * 约定（CLAUDE.md 规则 6/9/10、.claude/rules/05、DESIGN §3.10）：
 * - 检查点 = checkpoints + checkpoint_files 两表：打点时读当前 files 全量并落快照行，整体一个短事务；
 *   恢复同样一个短事务（better-sqlite3 事务回调同步执行，事务内只做纯 DB 读写，严禁 await/IO/LLM 调用）
 * - 恢复 upsert 语义：快照内已有文件行——当前内容先按当时版本号入档 file_versions（回滚可撤销）再覆盖；
 *   文件行已消失则重建；快照外的文件（打点之后新增）一律不动
 * - checkpoint_files 无 project_id，归属一律先经 checkpoints 回查（联表/前置校验），绝不信任裸 checkpointId
 * - preferences 唯一约束 (scope,target_id)：二次写走 onConflictDoUpdate，不撞索引
 */
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { checkpointFiles, checkpoints, fileVersions, files, llmCalls, preferences } from './schema';
import type { SqliteDb } from './storage';
import type {
  Checkpoint,
  LlmUsageRow,
  MiscRepo,
  PreferenceScope,
  RecordLlmCallInput,
} from '../types';

/** 行 → 领域类型映射：把 schema 形状挡在仓库层内 */
function toCheckpoint(row: typeof checkpoints.$inferSelect): Checkpoint {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    agentRunId: row.agentRunId,
    afterRunId: row.afterRunId,
    createdAt: row.createdAt,
  };
}

export function createMiscRepo(db: SqliteDb): MiscRepo {
  /** 打点：读快照与写快照在同一事务里，快照与 checkpoint 行不会出现「有头无身」的中间态 */
  function snapshotTx(projectId: number, label: string, agentRunId: number | null, afterRunId: number): number {
    return db.transaction((tx) => {
      const snapshot = tx
        .select({ path: files.path, content: files.content })
        .from(files)
        .where(eq(files.projectId, projectId))
        .orderBy(asc(files.path))
        .all();
      const inserted = tx.insert(checkpoints).values({ projectId, label, agentRunId, afterRunId }).returning().all();
      const cp = inserted[0];
      if (!cp) throw new Error('检查点写入失败：insert 未返回行');
      if (snapshot.length > 0) {
        tx.insert(checkpointFiles)
          .values(snapshot.map((row) => ({ checkpointId: cp.id, path: row.path, content: row.content })))
          .run();
      }
      return cp.id;
    });
  }

  /**
   * 恢复：归档在先、覆盖在后（顺序不能反——覆盖后再归档会把快照内容当旧版本存进去）。
   * 返回受影响 fileId，按快照路径升序；受影响 = 快照内路径，快照外的文件既不改也不删。
   */
  function restoreTx(projectId: number, cpId: number): number[] {
    return db.transaction((tx) => {
      const cpRows = tx
        .select({ id: checkpoints.id })
        .from(checkpoints)
        .where(and(eq(checkpoints.id, cpId), eq(checkpoints.projectId, projectId)))
        .limit(1)
        .all();
      const cp = cpRows[0];
      if (!cp) throw new Error(`检查点不存在或归属不符：projectId=${projectId} checkpointId=${cpId}`);

      const snapshot = tx
        .select({ path: checkpointFiles.path, content: checkpointFiles.content })
        .from(checkpointFiles)
        .where(eq(checkpointFiles.checkpointId, cp.id))
        // 返回值契约「受影响 fileId 按快照路径升序」由这里显式排序保证；
        // 打点时恰好按路径插入只是巧合，不能当成契约（否则换插入顺序即静默破坏契约）
        .orderBy(asc(checkpointFiles.path))
        .all();
      const current = tx.select().from(files).where(eq(files.projectId, projectId)).all();
      const byPath = new Map(current.map((row) => [row.path, row]));

      const affected: number[] = [];
      for (const row of snapshot) {
        const existing = byPath.get(row.path);
        if (existing) {
          // 覆盖前先按当时版本号归档 → 回滚本身可再撤销（与文件级 restoreFileVersion 同一套语义）
          tx.insert(fileVersions)
            .values({
              fileId: existing.id,
              version: existing.version,
              content: existing.content,
              editor: existing.lastEditor,
            })
            .run();
          const updated = tx
            .update(files)
            .set({
              content: row.content,
              version: existing.version + 1,
              lastEditor: 'human',
              updatedAt: Date.now(),
            })
            // project_id + version 一并进条件：作用域纪律（规则 9）+ 串行模型下的防御性 CAS
            .where(
              and(
                eq(files.id, existing.id),
                eq(files.projectId, projectId),
                eq(files.version, existing.version),
              ),
            )
            .run();
          // 防御层收口：CAS 未命中必须炸出来（同连接事务内 version 已被读到，串行模型下不可达），
          // 否则内容没恢复成却把 fileId 塞进返回值，调用方会拿到一份「假成功」清单
          if (updated.changes === 0) {
            throw new Error(
              `检查点恢复覆盖未命中：projectId=${projectId} fileId=${existing.id} version=${existing.version}`,
            );
          }
          affected.push(existing.id);
        } else {
          // 文件行已消失（虚拟 FS 无删除 API，此处为兜底路径）：重建并沿用恢复动作主体记 human
          const recreated = tx
            .insert(files)
            .values({ projectId, path: row.path, content: row.content, producedBy: 'human', lastEditor: 'human' })
            .returning()
            .all();
          const fresh = recreated[0];
          if (!fresh) throw new Error(`检查点恢复重建文件失败：projectId=${projectId} path=${row.path}`);
          affected.push(fresh.id);
        }
      }
      return affected;
    });
  }

  return {
    async createCheckpoint(projectId: number, label: string, agentRunId: number | null, afterRunId: number): Promise<number> {
      return snapshotTx(projectId, label, agentRunId, afterRunId);
    },

    async restoreCheckpoint(projectId: number, cpId: number): Promise<number[]> {
      return restoreTx(projectId, cpId);
    },

    /** 打点列表（新→旧，created_at 并列按 id 倒序稳定排序） */
    async listCheckpoints(projectId: number): Promise<Checkpoint[]> {
      const rows = await db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.projectId, projectId))
        .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id));
      return rows.map(toCheckpoint);
    },

    /** 计量落库：与 src/lib/llm/usage.ts 的 MeteringSink 字段一一对应（字段名/类型不可擅改） */
    async recordLlmCall(input: RecordLlmCallInput): Promise<void> {
      await db.insert(llmCalls).values({
        projectId: input.projectId,
        agentRole: input.agentRole,
        model: input.model,
        promptTokens: input.promptTokens,
        completionTokens: input.completionTokens,
        estimated: input.estimated,
        cost: input.cost,
        latencyMs: input.latencyMs,
      });
    },

    /** token 汇总一条 SQL groupBy 取齐（.claude/rules/05：禁 N+1）；角色+模型升序，输出稳定可断言 */
    async usageByProject(projectId: number): Promise<LlmUsageRow[]> {
      return db
        .select({
          agentRole: llmCalls.agentRole,
          model: llmCalls.model,
          tokens: sql<number>`coalesce(sum(${llmCalls.promptTokens} + ${llmCalls.completionTokens}), 0)`,
          calls: count(llmCalls.id),
        })
        .from(llmCalls)
        .where(eq(llmCalls.projectId, projectId))
        .groupBy(llmCalls.agentRole, llmCalls.model)
        .orderBy(asc(llmCalls.agentRole), asc(llmCalls.model))
        .all();
    },

    async getPreference(scope: PreferenceScope, targetId: string): Promise<unknown | null> {
      const rows = await db
        .select({ data: preferences.data })
        .from(preferences)
        .where(and(eq(preferences.scope, scope), eq(preferences.targetId, targetId)))
        .limit(1);
      const row = rows[0];
      return row?.data ?? null;
    },

    async setPreference(scope: PreferenceScope, targetId: string, data: Record<string, unknown>): Promise<void> {
      await db
        .insert(preferences)
        .values({ scope, targetId, data })
        .onConflictDoUpdate({ target: [preferences.scope, preferences.targetId], set: { data } });
    },
  };
}
