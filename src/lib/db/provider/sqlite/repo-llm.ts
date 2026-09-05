/**
 * SQLite 模型管理仓库（DESIGN §12 按仓库分组实现之一；DESIGN §5①/§7 全局表）。
 * 只读面（LlmReadRepo）供 src/lib/llm/resolve.ts 的三级路由消费；写面（LlmAdminRepo，T24）
 * 服务设置页 CRUD 与 probe 导入模型。既有读语义不变。
 * 这三张表是全局表（无 project_id），不存在项目级作用域问题；api_key 只在服务端流转（rules/07）。
 */
import { asc, count, eq, sql } from 'drizzle-orm';
import { agentModelBindings, llmCalls, llmModels, llmProviders } from './schema';
import type { SqliteDb } from './storage';
import type {
  AgentModelBindingRow,
  AgentRole,
  CreateLlmModelInput,
  CreateLlmProviderInput,
  LlmAdminRepo,
  LlmModelRow,
  LlmProviderRow,
  LlmReadRepo,
  LlmUsageGlobalRow,
  PatchLlmModelInput,
  PatchLlmProviderInput,
  UpsertAgentModelBindingInput,
} from '../types';

/** 行 → 领域类型映射：把 schema 形状挡在仓库层内 */
function toProvider(row: typeof llmProviders.$inferSelect): LlmProviderRow {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKey: row.apiKey,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function toModel(row: typeof llmModels.$inferSelect): LlmModelRow {
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    priceInput: row.priceInput,
    priceOutput: row.priceOutput,
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function toBinding(row: typeof agentModelBindings.$inferSelect): AgentModelBindingRow {
  return {
    id: row.id,
    role: row.role,
    providerId: row.providerId,
    modelId: row.modelId,
    createdAt: row.createdAt,
  };
}

export function createLlmReadRepo(db: SqliteDb): LlmReadRepo {
  return {
    /** 角色绑定（role 唯一约束保证至多一行；无绑定返回 null） */
    async getAgentModelBinding(role: AgentRole): Promise<AgentModelBindingRow | null> {
      const rows = await db
        .select()
        .from(agentModelBindings)
        .where(eq(agentModelBindings.role, role))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : toBinding(row);
    },

    async getLlmProviderById(providerId: number): Promise<LlmProviderRow | null> {
      const rows = await db.select().from(llmProviders).where(eq(llmProviders.id, providerId)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toProvider(row);
    },

    async getLlmModelById(modelId: number): Promise<LlmModelRow | null> {
      const rows = await db.select().from(llmModels).where(eq(llmModels.id, modelId)).limit(1);
      const row = rows[0];
      return row === undefined ? null : toModel(row);
    },
  };
}

/**
 * 写仓库（T24 设置页）：局部更新只落 patch 里出现的键（缺省键不动库里既有值）；
 * 删除按返回 boolean 表达「是否真的删了」（路由层映射 404）。
 */
export function createLlmAdminRepo(db: SqliteDb): LlmAdminRepo {
  async function updateProviderRow(
    providerId: number,
    patch: PatchLlmProviderInput,
  ): Promise<LlmProviderRow | null> {
    const set: Partial<typeof llmProviders.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
    if (patch.apiKey !== undefined && patch.apiKey !== '') set.apiKey = patch.apiKey; // 空 key = 未提供，不覆盖
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (Object.keys(set).length === 0) {
      const current = await db.select().from(llmProviders).where(eq(llmProviders.id, providerId)).limit(1);
      const row = current[0];
      return row === undefined ? null : toProvider(row);
    }
    const rows = await db.update(llmProviders).set(set).where(eq(llmProviders.id, providerId)).returning();
    const row = rows[0];
    return row === undefined ? null : toProvider(row);
  }

  async function updateModelRow(modelId: number, patch: PatchLlmModelInput): Promise<LlmModelRow | null> {
    const set: Partial<typeof llmModels.$inferInsert> = {};
    if (patch.displayName !== undefined) set.displayName = patch.displayName;
    if (patch.priceInput !== undefined) set.priceInput = patch.priceInput;
    if (patch.priceOutput !== undefined) set.priceOutput = patch.priceOutput;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (Object.keys(set).length === 0) {
      const current = await db.select().from(llmModels).where(eq(llmModels.id, modelId)).limit(1);
      const row = current[0];
      return row === undefined ? null : toModel(row);
    }
    const rows = await db.update(llmModels).set(set).where(eq(llmModels.id, modelId)).returning();
    const row = rows[0];
    return row === undefined ? null : toModel(row);
  }

  return {
    async createLlmProvider(input: CreateLlmProviderInput): Promise<LlmProviderRow> {
      const rows = await db.insert(llmProviders).values(input).returning();
      const row = rows[0];
      if (!row) throw new Error('服务商写入失败：insert 未返回行');
      return toProvider(row);
    },

    async listLlmProviders(): Promise<LlmProviderRow[]> {
      const rows = await db.select().from(llmProviders).orderBy(asc(llmProviders.id));
      return rows.map(toProvider);
    },

    async updateLlmProvider(providerId: number, patch: PatchLlmProviderInput): Promise<LlmProviderRow | null> {
      return updateProviderRow(providerId, patch);
    },

    /** 子表（llm_models / agent_model_bindings）经外键 onDelete cascade 一并清除（foreign_keys=ON） */
    async deleteLlmProvider(providerId: number): Promise<boolean> {
      const rows = await db.delete(llmProviders).where(eq(llmProviders.id, providerId)).returning();
      return rows.length > 0;
    },

    async createLlmModel(input: CreateLlmModelInput): Promise<LlmModelRow> {
      const rows = await db.insert(llmModels).values(input).returning();
      const row = rows[0];
      if (!row) throw new Error('模型写入失败：insert 未返回行');
      return toModel(row);
    },

    async listLlmModels(providerId?: number): Promise<LlmModelRow[]> {
      const base = db.select().from(llmModels);
      const rows =
        providerId === undefined
          ? await base.orderBy(asc(llmModels.providerId), asc(llmModels.modelId))
          : await base.where(eq(llmModels.providerId, providerId)).orderBy(asc(llmModels.modelId));
      return rows.map(toModel);
    },

    async updateLlmModel(modelId: number, patch: PatchLlmModelInput): Promise<LlmModelRow | null> {
      return updateModelRow(modelId, patch);
    },

    async deleteLlmModel(modelId: number): Promise<boolean> {
      const rows = await db.delete(llmModels).where(eq(llmModels.id, modelId)).returning();
      return rows.length > 0;
    },

    async upsertAgentModelBinding(input: UpsertAgentModelBindingInput): Promise<AgentModelBindingRow> {
      const rows = await db
        .insert(agentModelBindings)
        .values(input)
        .onConflictDoUpdate({
          target: agentModelBindings.role,
          set: { providerId: input.providerId, modelId: input.modelId },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('角色绑定写入失败：insert 未返回行');
      return toBinding(row);
    },

    async deleteAgentModelBinding(role: AgentRole): Promise<boolean> {
      const rows = await db.delete(agentModelBindings).where(eq(agentModelBindings.role, role)).returning();
      return rows.length > 0;
    },

    async listAgentModelBindings(): Promise<AgentModelBindingRow[]> {
      const rows = await db.select().from(agentModelBindings).orderBy(asc(agentModelBindings.role));
      return rows.map(toBinding);
    },

    /** 全局（跨项目）用量聚合：一条 SQL groupBy，estimatedCalls=sum(estimated)（rules/05 禁 N+1） */
    async usageAll(): Promise<LlmUsageGlobalRow[]> {
      return db
        .select({
          agentRole: llmCalls.agentRole,
          model: llmCalls.model,
          tokens: sql<number>`coalesce(sum(${llmCalls.promptTokens} + ${llmCalls.completionTokens}), 0)`,
          calls: count(llmCalls.id),
          estimatedCalls: sql<number>`coalesce(sum(${llmCalls.estimated}), 0)`,
        })
        .from(llmCalls)
        .groupBy(llmCalls.agentRole, llmCalls.model)
        .orderBy(asc(llmCalls.agentRole), asc(llmCalls.model));
    },
  };
}
