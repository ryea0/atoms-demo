/**
 * SQLite 模型管理只读仓库（DESIGN §12 按仓库分组实现之一；DESIGN §5①/§7 全局表）。
 * 范围刻意最小：三个按主键/唯一键的读取，供 src/lib/llm/resolve.ts 的三级路由消费；
 * T24 的设置页 CRUD（provider/model/绑定增删改、probe 导入模型）在此之上扩展，不改动既有语义。
 * 这三张表是全局表（无 project_id），不存在项目级作用域问题；api_key 只在服务端流转（rules/07）。
 */
import { eq } from 'drizzle-orm';
import { agentModelBindings, llmModels, llmProviders } from './schema';
import type { SqliteDb } from './storage';
import type { AgentModelBindingRow, AgentRole, LlmModelRow, LlmProviderRow, LlmReadRepo } from '../types';

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
