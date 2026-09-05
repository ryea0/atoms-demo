/**
 * 设置页测试（Task 24 / P3.5）：
 * - Provider CRUD 往返（api_key 只写不读：列表/详情一律脱敏尾 4 位，原始 key 绝不回显）
 * - probe 路由（外部 HTTP 一律 fetch 桩：latency>0、错误脱敏）
 * - models/import 去重（二次导入全 skipped）
 * - bindings PUT 空值清除绑定 → resolveRoleModel 回退 env（T27 契约在 HTTP 层复验）
 * - usageAll 全局聚合 + loadSettingsSnapshot 组装
 * - UI render smoke（ProvidersPanel / ModelBindPanel 关键元素）
 *
 * 测试策略：直调 Route Handler（Next 15 动态路由 params 是 Promise，测试里显式传）；
 * DB 用临时文件库——createSqliteStorage 按路径 memoize，路由/服务层/测试看到同一实例。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { createStorage } from '@/lib/db';
import type { StorageProvider } from '@/lib/db/provider/types';
import { resolveRoleModel } from '@/lib/llm/resolve';
import { loadSettingsSnapshot } from '@/lib/settings/service';
import type { BindingView, ModelView, ProviderView } from '@/lib/settings/types';
import * as providersRoute from '@/app/api/settings/providers/route';
import * as providerRoute from '@/app/api/settings/providers/[id]/route';
import * as probeRoute from '@/app/api/settings/providers/[id]/probe/route';
import * as importRoute from '@/app/api/settings/providers/[id]/models/import/route';
import * as modelRoute from '@/app/api/settings/models/[id]/route';
import * as bindingsRoute from '@/app/api/settings/bindings/route';
import { ProvidersPanel } from '@/components/settings/ProvidersPanel';
import { ModelBindPanel } from '@/components/settings/ModelBindPanel';

/* ------------------------------------------------------------------ */
/* 临时文件库：每个用例一份全新库（路由与服务层经 memoize 共享同一实例）          */
/* ------------------------------------------------------------------ */

/** jsdom 没有 ResizeObserver（Radix Switch 等组件需要），就地补一个最小桩 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // 边界兜底：把桩挂到全局（jsdom 环境缺该构造器）
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

let opened: StorageProvider | null = null;
let dataDir = '';

/** 关掉上一个实例（close 会把自己移出路径缓存）→ 换新的临时库文件并预热 */
function useFreshDb(): void {
  opened?.close();
  opened = null;
  if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true });
  dataDir = mkdtempSync(join(tmpdir(), 'atoms-settings-'));
  process.env.DB_FILE = join(dataDir, 'app.db');
  opened = createStorage();
}

beforeAll(useFreshDb);
beforeEach(useFreshDb);
afterAll(() => {
  opened?.close();
  opened = null;
  if (dataDir !== '') rmSync(dataDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

/** 测试用 env 字面量（与 resolve.test.ts 同理：显式补 NODE_ENV） */
function testEnv(partial: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: 'test', ...partial };
}

/** 动态路由上下文（Next 15：params 为 Promise） */
function ctx(id: number | string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id: String(id) }) };
}

/** 构造 JSON 请求（无 body 时省略 content-type，避免空 body 解析歧义） */
function jsonRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://test.local${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 响应体收窄为对象 */
async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 结构化错误取值 */
function errorOf(payload: Record<string, unknown>): { code: string; message: string } {
  return payload['error'] as { code: string; message: string };
}

/** 同步墙钟下保证 latencyMs > 0 的最小等待 */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON 响应桩 */
function jsonResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

/** /models 响应桩 */
function modelsResponse(ids: string[]): Response {
  return jsonResponse(200, JSON.stringify({ data: ids.map((id) => ({ id })) }));
}

/** 安装一次性 fetch 桩 */
function stubFetch(impl: () => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** 直接经仓库层种数据（provider + 其下模型），返回 id 供 HTTP 断言用 */
async function seedProvider(
  name: string,
  baseUrl: string,
  models: string[],
): Promise<{ providerId: number; modelIds: number[] }> {
  const storage = createStorage();
  const provider = await storage.createLlmProvider({
    name,
    baseUrl,
    apiKey: 'sk-seed-key-98765432',
    enabled: true,
  });
  const modelIds: number[] = [];
  for (const modelId of models) {
    const model = await storage.createLlmModel({
      providerId: provider.id,
      modelId,
      displayName: modelId,
      priceInput: 0,
      priceOutput: 0,
      enabled: true,
    });
    modelIds.push(model.id);
  }
  return { providerId: provider.id, modelIds };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* Provider CRUD                                                        */
/* ------------------------------------------------------------------ */
describe('POST/GET /api/settings/providers（创建 + 列表）', () => {
  it('创建 → 201；列表回显脱敏尾 4 位，原始 key 不出现在响应文本里', async () => {
    const created = await providersRoute.POST(
      jsonRequest('POST', '/api/settings/providers', {
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'sk-live-abcd1234567890',
        enabled: true,
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = await bodyOf(created);
    const provider = createdBody['provider'] as ProviderView;
    expect(provider.name).toBe('DeepSeek');
    expect(provider.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(provider.apiKeyMasked).toBe('****7890');
    expect(provider.enabled).toBe(true);
    expect(JSON.stringify(createdBody)).not.toContain('sk-live-abcd1234567890');

    const list = await providersRoute.GET();
    const listBody = await bodyOf(list);
    const providers = listBody['providers'] as ProviderView[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.apiKeyMasked).toBe('****7890');
    expect(JSON.stringify(listBody)).not.toContain('sk-live-abcd1234567890');
    // 模型清单随列表一起返回（工作台一次取齐，避免第二个只读端点）
    expect(Array.isArray(listBody['models'])).toBe(true);
  });

  it('非法入参（baseUrl 非 http(s)）→ 400 结构化错误；key 缺失 → 400', async () => {
    const badUrl = await providersRoute.POST(
      jsonRequest('POST', '/api/settings/providers', {
        name: 'X',
        baseUrl: 'api.example.com/v1',
        apiKey: 'sk-12345678',
      }),
    );
    expect(badUrl.status).toBe(400);
    expect(errorOf(await bodyOf(badUrl)).code).toBe('invalid_input');

    const noKey = await providersRoute.POST(
      jsonRequest('POST', '/api/settings/providers', { name: 'X', baseUrl: 'https://a.com/v1' }),
    );
    expect(noKey.status).toBe(400);
  });
});

describe('PATCH/DELETE /api/settings/providers/[id]', () => {
  it('patch enabled/name/baseUrl 往返；不存在的 id → 404', async () => {
    const { providerId } = await seedProvider('旧名', 'https://old.example.com/v1', []);

    const patched = await providerRoute.PATCH(
      jsonRequest('PATCH', `/api/settings/providers/${providerId}`, {
        name: '新名',
        baseUrl: 'https://new.example.com/v1',
        enabled: false,
      }),
      ctx(providerId),
    );
    expect(patched.status).toBe(200);
    const provider = (await bodyOf(patched))['provider'] as ProviderView;
    expect(provider.name).toBe('新名');
    expect(provider.baseUrl).toBe('https://new.example.com/v1');
    expect(provider.enabled).toBe(false);

    const missing = await providerRoute.PATCH(
      jsonRequest('PATCH', '/api/settings/providers/999', { enabled: true }),
      ctx(999),
    );
    expect(missing.status).toBe(404);
  });

  it('patch 传空 api_key 不覆盖既有密钥（脱敏值不变）', async () => {
    const { providerId } = await seedProvider('密钥保持', 'https://keep.example.com/v1', []);
    const patched = await providerRoute.PATCH(
      jsonRequest('PATCH', `/api/settings/providers/${providerId}`, { apiKey: '' }),
      ctx(providerId),
    );
    const provider = (await bodyOf(patched))['provider'] as ProviderView;
    expect(provider.apiKeyMasked).toBe('****5432'); // sk-seed-key-98765432 的尾 4 位
  });

  it('delete 级联清掉其下模型与绑定；不存在 → 404', async () => {
    const storage = createStorage();
    const { providerId, modelIds } = await seedProvider('待删', 'https://del.example.com/v1', ['m-a']);
    await storage.upsertAgentModelBinding({ role: 'pm', providerId, modelId: modelIds[0] as number });

    const removed = await providerRoute.DELETE(jsonRequest('DELETE', `/api/settings/providers/${providerId}`), ctx(providerId));
    expect(removed.status).toBe(200);
    expect(await storage.getLlmProviderById(providerId)).toBeNull();
    expect(await storage.getLlmModelById(modelIds[0] as number)).toBeNull();
    expect(await storage.getAgentModelBinding('pm')).toBeNull();

    const missing = await providerRoute.DELETE(jsonRequest('DELETE', '/api/settings/providers/999'), ctx(999));
    expect(missing.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* probe（外部 HTTP 全部桩掉）                                            */
/* ------------------------------------------------------------------ */
describe('POST /api/settings/providers/[id]/probe', () => {
  it('200 → latency>0 + modelCount + models 预览；请求打到去尾斜杠的 {baseUrl}/models 且带 Authorization', async () => {
    const { providerId } = await seedProvider('GLM', 'https://open.bigmodel.cn/api/paas/v4/', []);
    const storage = createStorage();
    const provider = await storage.getLlmProviderById(providerId);
    expect(provider).not.toBeNull();

    const fn = stubFetch(async () => {
      await tick();
      return modelsResponse(['glm-4-plus', 'glm-4-air']);
    });

    const res = await probeRoute.POST(jsonRequest('POST', `/api/settings/providers/${providerId}/probe`), ctx(providerId));
    expect(res.status).toBe(200);
    const probe = (await bodyOf(res))['probe'] as {
      ok: boolean;
      latencyMs: number;
      modelCount: number;
      models: string[];
      error: string | null;
    };
    expect(probe.ok).toBe(true);
    expect(probe.latencyMs).toBeGreaterThan(0);
    expect(probe.modelCount).toBe(2);
    expect(probe.models).toEqual(['glm-4-plus', 'glm-4-air']);
    expect(probe.error).toBeNull();

    const call = fn.mock.calls[0] as unknown[];
    expect(String(call[0])).toBe('https://open.bigmodel.cn/api/paas/v4/models');
    const headers = (call[1] as Record<string, unknown>)['headers'] as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${provider?.apiKey}`);
  });

  it('探测失败 → ok:false 且错误脱敏（原始 api key 不回显）', async () => {
    const { providerId } = await seedProvider('坏网关', 'https://bad.example.com/v1', []);
    stubFetch(async () => jsonResponse(401, JSON.stringify({ error: `bad key sk-seed-key-98765432` })));

    const res = await probeRoute.POST(jsonRequest('POST', `/api/settings/providers/${providerId}/probe`), ctx(providerId));
    expect(res.status).toBe(200);
    const text = JSON.stringify(await bodyOf(res));
    expect(text).not.toContain('sk-seed-key-98765432');
    expect(text).toContain('HTTP 401');
  });

  it('不存在的 provider → 404（不发请求）', async () => {
    const fn = stubFetch(async () => modelsResponse(['m']));
    const res = await probeRoute.POST(jsonRequest('POST', '/api/settings/providers/999/probe'), ctx(999));
    expect(res.status).toBe(404);
    expect(fn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* models/import（去重）                                                 */
/* ------------------------------------------------------------------ */
describe('POST /api/settings/providers/[id]/models/import', () => {
  it('首次导入 imported=2 skipped=0；二次导入全部 skipped（按 model_id 去重）', async () => {
    const { providerId } = await seedProvider('Kimi', 'https://api.moonshot.cn/v1', ['kimi-k2-0905']);
    stubFetch(async () => modelsResponse(['kimi-k2-0905', 'kimi-latest', 'kimi-k2-turbo-preview']));

    const first = await importRoute.POST(
      jsonRequest('POST', `/api/settings/providers/${providerId}/models/import`),
      ctx(providerId),
    );
    expect(first.status).toBe(200);
    expect((await bodyOf(first))['import']).toMatchObject({ discovered: 3, imported: 2, skipped: 1 });

    const second = await importRoute.POST(
      jsonRequest('POST', `/api/settings/providers/${providerId}/models/import`),
      ctx(providerId),
    );
    expect((await bodyOf(second))['import']).toMatchObject({ discovered: 3, imported: 0, skipped: 3 });

    const storage = createStorage();
    const models = await storage.listLlmModels(providerId);
    expect(models.map((m) => m.modelId).sort()).toEqual([
      'kimi-k2-0905',
      'kimi-k2-turbo-preview',
      'kimi-latest',
    ]);
    // 导入的模型默认单价 0（成本核算字段兜底）
    expect(models.every((m) => m.priceInput === 0 && m.priceOutput === 0)).toBe(true);
  });

  it('探测失败 → 502 + 脱敏错误；不存在的 provider → 404', async () => {
    const { providerId } = await seedProvider('超时', 'https://slow.example.com/v1', []);
    stubFetch(async () => {
      await tick();
      return jsonResponse(500, 'boom');
    });
    const failed = await importRoute.POST(
      jsonRequest('POST', `/api/settings/providers/${providerId}/models/import`),
      ctx(providerId),
    );
    expect(failed.status).toBe(502);
    const payload = await bodyOf(failed);
    expect(errorOf(payload).code).toBe('probe_failed');

    const missing = await importRoute.POST(
      jsonRequest('POST', '/api/settings/providers/999/models/import'),
      ctx(999),
    );
    expect(missing.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* models/[id]                                                          */
/* ------------------------------------------------------------------ */
describe('PATCH/DELETE /api/settings/models/[id]', () => {
  it('改显示名/单价/启用态；删除后列表不再返回；不存在的 id → 404', async () => {
    const { modelIds } = await seedProvider('DS', 'https://api.deepseek.com/v1', ['deepseek-chat']);
    const modelId = modelIds[0] as number;

    const patched = await modelRoute.PATCH(
      jsonRequest('PATCH', `/api/settings/models/${modelId}`, {
        displayName: 'DeepSeek Chat',
        priceInput: 0.002,
        priceOutput: 0.008,
        enabled: false,
      }),
      ctx(modelId),
    );
    expect(patched.status).toBe(200);
    const model = (await bodyOf(patched))['model'] as ModelView;
    expect(model.displayName).toBe('DeepSeek Chat');
    expect(model.priceInput).toBe(0.002);
    expect(model.priceOutput).toBe(0.008);
    expect(model.enabled).toBe(false);

    const removed = await modelRoute.DELETE(jsonRequest('DELETE', `/api/settings/models/${modelId}`), ctx(modelId));
    expect(removed.status).toBe(200);
    const storage = createStorage();
    expect(await storage.listLlmModels()).toHaveLength(0);

    const missing = await modelRoute.PATCH(
      jsonRequest('PATCH', '/api/settings/models/999', { enabled: true }),
      ctx(999),
    );
    expect(missing.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* bindings（PUT 空值 → resolveRoleModel 回退 env）                       */
/* ------------------------------------------------------------------ */
describe('GET/PUT /api/settings/bindings', () => {
  it('PUT 绑定后 resolveRoleModel 命中绑定；PUT 空值清除 → 回退 env（T27 契约走 HTTP 层复验）', async () => {
    const storage = createStorage();
    const { providerId, modelIds } = await seedProvider('ARK', 'https://ark.cn-beijing.volces.com/api/v3', ['doubao-pro-32k']);
    const modelId = modelIds[0] as number;

    // 7 个角色都在列表里，未绑定时 modelLabel 为 null
    const empty = await bodyOf(await bindingsRoute.GET());
    const emptyBindings = empty['bindings'] as BindingView[];
    expect(emptyBindings).toHaveLength(7);
    expect(emptyBindings.every((b) => b.modelLabel === null)).toBe(true);

    const put = await bindingsRoute.PUT(
      jsonRequest('PUT', '/api/settings/bindings', { role: 'engineer', providerId, modelId }),
    );
    expect(put.status).toBe(200);
    const engineer = ((await bodyOf(put))['binding'] as BindingView);
    expect(engineer.role).toBe('engineer');
    expect(engineer.modelLabel).toContain('doubao-pro-32k');

    const hit = await resolveRoleModel('engineer', testEnv({ LLM_MODEL: 'env-fallback-model' }), storage);
    expect(hit.model).toBe('doubao-pro-32k');
    expect(hit.providerConfig?.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');

    // 空值 = 清除绑定（跟随全局默认）
    const cleared = await bindingsRoute.PUT(jsonRequest('PUT', '/api/settings/bindings', { role: 'engineer' }));
    expect(cleared.status).toBe(200);
    expect(((await bodyOf(cleared))['binding'] as BindingView).modelLabel).toBeNull();

    const fallback = await resolveRoleModel('engineer', testEnv({ LLM_MODEL: 'env-fallback-model' }), storage);
    expect(fallback.model).toBe('env-fallback-model');
    expect(fallback.providerConfig).toBeUndefined();
  });

  it('model 不属该 provider → 400 invalid_reference；未知 role → 400', async () => {
    const a = await seedProvider('A', 'https://a.example.com/v1', ['a-model']);
    const b = await seedProvider('B', 'https://b.example.com/v1', []);

    const cross = await bindingsRoute.PUT(
      jsonRequest('PUT', '/api/settings/bindings', {
        role: 'pm',
        providerId: b.providerId,
        modelId: a.modelIds[0],
      }),
    );
    expect(cross.status).toBe(400);
    expect(errorOf(await bodyOf(cross)).code).toBe('invalid_reference');

    const unknownRole = await bindingsRoute.PUT(
      jsonRequest('PUT', '/api/settings/bindings', { role: 'not-a-role' }),
    );
    expect(unknownRole.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* usageAll 聚合 + 快照组装                                              */
/* ------------------------------------------------------------------ */
describe('usageAll 聚合 / loadSettingsSnapshot', () => {
  it('按 agent+model 全局聚合 tokens/calls，并带 estimated 调用数标记', async () => {
    const storage = createStorage();
    const project = await storage.createProject({
      sessionId: 's-usage',
      title: '用量项目',
      requirement: '做个看板',
      mode: 'fast',
    });
    await storage.recordLlmCall({
      projectId: project.id,
      agentRole: 'engineer',
      model: 'm-eng',
      promptTokens: 100,
      completionTokens: 50,
      estimated: 1,
      cost: 0,
      latencyMs: 10,
    });
    await storage.recordLlmCall({
      projectId: project.id,
      agentRole: 'engineer',
      model: 'm-eng',
      promptTokens: 10,
      completionTokens: 5,
      estimated: 0,
      cost: 0,
      latencyMs: 10,
    });
    await storage.recordLlmCall({
      projectId: project.id,
      agentRole: 'pm',
      model: 'm-pm',
      promptTokens: 7,
      completionTokens: 3,
      estimated: 0,
      cost: 0,
      latencyMs: 10,
    });

    const rows = await storage.usageAll();
    expect(rows).toEqual([
      { agentRole: 'engineer', model: 'm-eng', tokens: 165, calls: 2, estimatedCalls: 1 },
      { agentRole: 'pm', model: 'm-pm', tokens: 10, calls: 1, estimatedCalls: 0 },
    ]);

    // 快照 = 设置页一次取齐的全量数据（含用量）
    const snapshot = await loadSettingsSnapshot();
    expect(snapshot.usage).toEqual(rows);
    expect(snapshot.providers.length).toBe(0);
    expect(snapshot.models.length).toBe(0);
    expect(snapshot.bindings).toHaveLength(7);
  });
});

/* ------------------------------------------------------------------ */
/* UI render smoke                                                      */
/* ------------------------------------------------------------------ */
describe('UI render smoke', () => {
  const provider: ProviderView = {
    id: 1,
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyMasked: '****7890',
    enabled: true,
    createdAt: 1_700_000_000_000,
  };
  const model: ModelView = {
    id: 11,
    providerId: 1,
    modelId: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    priceInput: 0.002,
    priceOutput: 0.008,
    enabled: true,
  };

  it('ProvidersPanel：预设下拉/添加按钮/测试连接/导入模型/脱敏 key/模型行', () => {
    // 本文件是 .ts（不解析 JSX），用 createElement 构建元素
    render(
      createElement(ProvidersPanel, { providers: [provider], models: [model], onChanged: () => Promise.resolve() }),
    );

    // 预设下拉 + 添加按钮
    const preset = screen.getByLabelText('预设服务商') as HTMLSelectElement;
    expect(Array.from(preset.options).some((option) => option.textContent.includes('豆包'))).toBe(true);
    expect(screen.getByRole('button', { name: '添加服务商' })).toBeInTheDocument();

    // 已有 provider 卡片：脱敏 key、测试连接、导入模型、启用开关、删除
    expect(screen.getByText('****7890')).toBeInTheDocument();
    expect(screen.queryByText('sk-live-abcd1234567890')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '导入模型' })).toBeInTheDocument();
    // provider 卡片与模型行各有一个删除入口
    expect(screen.getAllByRole('button', { name: '删除' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '保存' })).toBeInTheDocument();

    // 该 provider 下的模型行可编辑（显示名/单价）
    expect(screen.getByDisplayValue('DeepSeek Chat')).toBeInTheDocument();
    expect(screen.getByDisplayValue('0.002')).toBeInTheDocument();
  });

  it('ModelBindPanel：渲染 7 个角色行，含「跟随全局默认」空选项', () => {
    const bindings: BindingView[] = [
      { role: 'engineer', providerId: 1, modelId: 11, modelLabel: 'DeepSeek / DeepSeek Chat' },
      { role: 'leader', providerId: null, modelId: null, modelLabel: null },
      { role: 'pm', providerId: null, modelId: null, modelLabel: null },
      { role: 'architect', providerId: null, modelId: null, modelLabel: null },
      { role: 'analyst', providerId: null, modelId: null, modelLabel: null },
      { role: 'seo', providerId: null, modelId: null, modelLabel: null },
      { role: 'ads', providerId: null, modelId: null, modelLabel: null },
    ];
    render(
      createElement(ModelBindPanel, {
        bindings,
        models: [model],
        providers: [provider],
        onChanged: () => Promise.resolve(),
      }),
    );

    expect(screen.getAllByRole('combobox')).toHaveLength(7);
    expect(screen.getAllByRole('option', { name: '跟随全局默认' })).toHaveLength(7);
    expect(screen.getByText('工程师')).toBeInTheDocument();
    const engineerSelect = screen.getByRole('combobox', { name: '工程师使用模型' }) as HTMLSelectElement;
    expect(engineerSelect.value).toBe('1:11'); // 已绑定 → 选中 providerId:modelId
  });
});
