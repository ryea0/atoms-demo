/**
 * resolveRoleModel 测试（Task 27 / DESIGN §5①「三级路由」增强）：
 * DB 绑定（agent_model_bindings，storage 提供时）→ LLM_MODEL_<ROLE> → LLM_MODEL → DEFAULT_MODEL。
 * DB 命中返回该 provider 的连接信息（providerConfig）；env 路径无 providerConfig（走全局 env）。
 * 绑定指向的 provider/model 被 disabled 或缺失 → 视为未命中，继续走 env（不炸）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRoleModel } from '@/lib/llm/resolve';
import { DEFAULT_MODEL } from '@/lib/llm/client';
import { newTestStorageWithDb } from '@/lib/db/test-util';
import { agentModelBindings, llmModels, llmProviders } from '@/lib/db/provider/sqlite/schema';
import type { AgentRole } from '@/lib/db/provider/types';

/** 测试用 env 字面量（与 client.test.ts 同理：显式补 NODE_ENV） */
function testEnv(partial: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...partial };
}

/** 取 insert...returning 的第一行（noUncheckedIndexedAccess 下显式判空） */
function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('预期插入返回至少一行');
  return row;
}

/** 预置一组可用的 provider+model+绑定（可选 disabled），返回可供 resolveRoleModel 使用的 storage */
async function seedBinding(options: {
  role: AgentRole;
  providerEnabled?: boolean;
  modelEnabled?: boolean;
}): Promise<ReturnType<typeof newTestStorageWithDb>['storage']> {
  const { storage, db } = newTestStorageWithDb();
  const provider = firstRow(
    await db
      .insert(llmProviders)
      .values({
        name: 'ark',
        baseUrl: 'https://ark.example.com/v3',
        apiKey: 'sk-db-secret-key-42',
        enabled: options.providerEnabled ?? true,
      })
      .returning(),
  );
  const model = firstRow(
    await db
      .insert(llmModels)
      .values({
        providerId: provider.id,
        modelId: 'doubao-pro-32k',
        displayName: '豆包 Pro 32k',
        enabled: options.modelEnabled ?? true,
      })
      .returning(),
  );
  await db.insert(agentModelBindings).values({ role: options.role, providerId: provider.id, modelId: model.id });
  return storage;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveRoleModel 三级路由', () => {
  it('① 角色级覆盖最优先：LLM_MODEL_<ROLE> 命中，无 providerConfig', async () => {
    const result = await resolveRoleModel('engineer', testEnv({ LLM_MODEL_ENGINEER: 'eng-model', LLM_MODEL: 'global-model' }));

    expect(result).toEqual({ model: 'eng-model' });
    expect(result.providerConfig).toBeUndefined();
  });

  it('② 无角色覆盖 → LLM_MODEL 全局默认，无 providerConfig', async () => {
    const result = await resolveRoleModel('pm', testEnv({ LLM_MODEL: 'global-model' }));

    expect(result).toEqual({ model: 'global-model' });
  });

  it('③ 什么都没配 → 内置 DEFAULT_MODEL（mock 链路可用）', async () => {
    const result = await resolveRoleModel('architect', testEnv());

    expect(result).toEqual({ model: DEFAULT_MODEL });
  });

  it('④ env 取值忽略纯空白（与 resolveModel 同一裁剪语义）', async () => {
    const result = await resolveRoleModel('seo', testEnv({ LLM_MODEL_SEO: '   ', LLM_MODEL: 'global-model' }));

    expect(result.model).toBe('global-model');
  });

  it('⑤ DB 绑定优先于 env，并带出该 provider 的连接信息', async () => {
    const storage = await seedBinding({ role: 'engineer' });

    const result = await resolveRoleModel(
      'engineer',
      testEnv({ LLM_MODEL_ENGINEER: 'env-should-lose' }),
      storage,
    );

    expect(result.model).toBe('doubao-pro-32k');
    expect(result.providerConfig).toEqual({
      baseUrl: 'https://ark.example.com/v3',
      apiKey: 'sk-db-secret-key-42',
    });
  });

  it('⑥ DB 绑定的 model 被 disabled → 视为未命中，回落 env', async () => {
    const storage = await seedBinding({ role: 'engineer', modelEnabled: false });

    const result = await resolveRoleModel('engineer', testEnv({ LLM_MODEL_ENGINEER: 'env-model' }), storage);

    expect(result).toEqual({ model: 'env-model' });
  });

  it('⑦ DB 绑定的 provider 被 disabled → 视为未命中，回落 env', async () => {
    const storage = await seedBinding({ role: 'leader', providerEnabled: false });

    const result = await resolveRoleModel('leader', testEnv({ LLM_MODEL: 'global-model' }), storage);

    expect(result).toEqual({ model: 'global-model' });
  });

  it('⑧ storage 提供但无绑定 → 走 env 路径', async () => {
    const { storage } = newTestStorageWithDb();

    const result = await resolveRoleModel('engineer', testEnv({ LLM_MODEL: 'global-model' }), storage);

    expect(result).toEqual({ model: 'global-model' });
  });

  it('⑨ storage 查询失败 → console.error 留痕并降级 env（不静默吞、不炸生成链路）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = {
      async getAgentModelBinding(): Promise<null> {
        throw new Error('db down');
      },
      async getLlmProviderById(): Promise<null> {
        return null;
      },
      async getLlmModelById(): Promise<null> {
        return null;
      },
    };

    const result = await resolveRoleModel('engineer', testEnv({ LLM_MODEL: 'global-model' }), broken);

    expect(result).toEqual({ model: 'global-model' });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('⑩ 其它角色不受 engineer 绑定影响（role 精确匹配）', async () => {
    const storage = await seedBinding({ role: 'analyst' });

    const result = await resolveRoleModel('engineer', testEnv({ LLM_MODEL: 'global-model' }), storage);

    expect(result).toEqual({ model: 'global-model' });
  });
});
