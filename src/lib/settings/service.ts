/**
 * 设置页服务层（Task 24 / P3.5）：Route Handler 与 /settings 页面共用的业务逻辑。
 * handler 只做 解析→校验→调用本层→响应；本层负责脱敏、级联语义、probe 与导入模型编排。
 *
 * 密钥红线（.claude/rules/07）：LlmProviderRow.apiKey 绝不出本层——对外一律 ProviderView（脱敏尾 4 位），
 * probe 的 key 只进 probeProvider 的请求头，错误信息已由 probe 内部 sanitize。
 *
 * 服务端专用（经 @/lib/db 引入 better-sqlite3），不得进入客户端 bundle。
 */
import { createStorage } from '@/lib/db';
import { probeProvider } from '@/lib/llm/probe';
import type {
  AgentRole,
  LlmModelRow,
  LlmProviderRow,
  PatchLlmModelInput,
  PatchLlmProviderInput,
  PreferenceScope,
  StorageProvider,
} from '@/lib/db/provider/types';
import { agentRoles, maskApiKey, normalizePreferences, type UserPreferences, type UserPreferencesPatch } from './types';
import type {
  BindingView,
  ImportResultView,
  ModelView,
  ProbeView,
  ProviderView,
  SettingsSnapshot,
} from './types';

/** 探测结果回显的模型预览上限（全量在「导入模型」时落库，无需整页塞给前端） */
const PROBE_MODEL_PREVIEW_LIMIT = 20;

/** 存储按 dbFile 路径 memoize（工厂内部处理），此处只做取用 */
function storage(): StorageProvider {
  return createStorage();
}

function toProviderView(row: LlmProviderRow): ProviderView {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl,
    apiKeyMasked: maskApiKey(row.apiKey),
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}

function toModelView(row: LlmModelRow): ModelView {
  return {
    id: row.id,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName,
    priceInput: row.priceInput,
    priceOutput: row.priceOutput,
    enabled: row.enabled,
  };
}

/* ---------------- Provider ---------------- */

export async function listProviderViews(): Promise<ProviderView[]> {
  const rows = await storage().listLlmProviders();
  return rows.map(toProviderView);
}

export async function listModelViews(): Promise<ModelView[]> {
  const rows = await storage().listLlmModels();
  return rows.map(toModelView);
}

/** 新增服务商：enabled 缺省视为启用（zod 层不做默认值，语义集中在本层） */
export async function createProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
}): Promise<ProviderView> {
  const row = await storage().createLlmProvider({
    name: input.name,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    enabled: input.enabled ?? true,
  });
  return toProviderView(row);
}

export async function updateProvider(providerId: number, patch: PatchLlmProviderInput): Promise<ProviderView | null> {
  const row = await storage().updateLlmProvider(providerId, patch);
  return row === null ? null : toProviderView(row);
}

/** 删除服务商：其下模型与角色绑定经外键级联一并清除（绑定消失后 resolveRoleModel 回退 env） */
export async function deleteProvider(providerId: number): Promise<boolean> {
  return storage().deleteLlmProvider(providerId);
}

/* ---------------- Model ---------------- */

export async function updateModel(modelId: number, patch: PatchLlmModelInput): Promise<ModelView | null> {
  const row = await storage().updateLlmModel(modelId, patch);
  return row === null ? null : toModelView(row);
}

export async function deleteModel(modelId: number): Promise<boolean> {
  return storage().deleteLlmModel(modelId);
}

/* ---------------- 测试连接 / 导入模型 ---------------- */

/** 对已存服务商发起探测（用库里保存的连接信息）；provider 不存在返回 null（不发请求） */
export async function probeStoredProvider(providerId: number): Promise<ProbeView | null> {
  const provider = await storage().getLlmProviderById(providerId);
  if (provider === null) return null;
  const result = await probeProvider({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  if (!result.ok) {
    return { ok: false, latencyMs: result.latencyMs, modelCount: 0, models: [], error: result.error };
  }
  return {
    ok: true,
    latencyMs: result.latencyMs,
    modelCount: result.models.length,
    models: result.models.slice(0, PROBE_MODEL_PREVIEW_LIMIT),
    error: null,
  };
}

export type ImportOutcome =
  | { ok: true; result: ImportResultView }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'probe_failed'; error: string };

/** 探测并把模型清单去重落库（按 model_id 判重；已存在的一律跳过，不重复计价/不复活已停用模型） */
export async function importProviderModels(providerId: number): Promise<ImportOutcome> {
  const db = storage();
  const provider = await db.getLlmProviderById(providerId);
  if (provider === null) return { ok: false, reason: 'not_found' };

  const probe = await probeProvider({ baseUrl: provider.baseUrl, apiKey: provider.apiKey });
  if (!probe.ok) return { ok: false, reason: 'probe_failed', error: probe.error };

  const existing = new Set((await db.listLlmModels(providerId)).map((row) => row.modelId));
  let imported = 0;
  for (const modelId of probe.models) {
    if (existing.has(modelId)) continue;
    await db.createLlmModel({
      providerId,
      modelId,
      displayName: modelId, // /models 不带展示名与单价，先以 model_id 兜底，设置页可改
      priceInput: 0,
      priceOutput: 0,
      enabled: true,
    });
    existing.add(modelId);
    imported += 1;
  }
  return { ok: true, result: { discovered: probe.models.length, imported, skipped: probe.models.length - imported } };
}

/* ---------------- 角色绑定 ---------------- */

/** 7 角色恒齐全的绑定视图（未绑定 → modelLabel=null，UI 显示「跟随全局默认」） */
export async function listBindingViews(): Promise<BindingView[]> {
  const db = storage();
  const [bindings, models, providers] = await Promise.all([
    db.listAgentModelBindings(),
    db.listLlmModels(),
    db.listLlmProviders(),
  ]);
  const modelById = new Map(models.map((row) => [row.id, row]));
  const providerById = new Map(providers.map((row) => [row.id, row]));

  const labelOf = (role: AgentRole): BindingView => {
    const binding = bindings.find((row) => row.role === role);
    if (binding === undefined) return { role, providerId: null, modelId: null, modelLabel: null };
    const model = modelById.get(binding.modelId);
    const provider = providerById.get(binding.providerId);
    return {
      role,
      providerId: binding.providerId,
      modelId: binding.modelId,
      modelLabel: model !== undefined && provider !== undefined ? `${provider.name} / ${model.displayName}` : null,
    };
  };

  return agentRoles.map(labelOf);
}

export type BindingOutcome =
  | { ok: true; binding: BindingView }
  | { ok: false; reason: 'invalid_reference'; message: string };

/**
 * 保存角色绑定：providerId+modelId 齐全 = 绑定（校验存在性与归属）；任一缺失 = 清除（跟随全局默认）。
 * 校验在前、写入在后，避免撞外键约束拿到裸 SQLite 错误。
 */
export async function putBinding(input: {
  role: AgentRole;
  providerId?: number;
  modelId?: number;
}): Promise<BindingOutcome> {
  const db = storage();

  if (input.providerId === undefined || input.modelId === undefined) {
    await db.deleteAgentModelBinding(input.role);
  } else {
    const [provider, model] = await Promise.all([
      db.getLlmProviderById(input.providerId),
      db.getLlmModelById(input.modelId),
    ]);
    if (provider === null || model === null || model.providerId !== provider.id) {
      return { ok: false, reason: 'invalid_reference', message: '模型不存在或不属于该服务商' };
    }
    await db.upsertAgentModelBinding({ role: input.role, providerId: provider.id, modelId: model.id });
  }

  const bindings = await listBindingViews();
  const binding = bindings.find((row) => row.role === input.role);
  if (binding === undefined) throw new Error('绑定视图缺失角色：' + input.role);
  return { ok: true, binding };
}

/* ---------------- 个人偏好（session 级，DESIGN §3.9/§4.2） ---------------- */

/** 偏好作用域：demo 只用 session 级（DESIGN §4.2），user 级为 schema 预留 */
const PREFERENCE_SCOPE: PreferenceScope = 'session';

/** 读取偏好：无记录/脏数据一律回默认值（normalize 集中收窄，前后端口径一致） */
export async function getPreferences(sessionId: string): Promise<UserPreferences> {
  return normalizePreferences(await storage().getPreference(PREFERENCE_SCOPE, sessionId));
}

/** 保存偏好：patch 缺省键保持既有值（显式判 undefined，避免 undefined 覆盖成脏数据） */
export async function savePreferences(sessionId: string, patch: UserPreferencesPatch): Promise<UserPreferences> {
  const current = await getPreferences(sessionId);
  const next: UserPreferences = {
    editing_enabled: patch.editing_enabled ?? current.editing_enabled,
    default_mode: patch.default_mode ?? current.default_mode,
  };
  await storage().setPreference(PREFERENCE_SCOPE, sessionId, { ...next });
  return next;
}

/* ---------------- 页面快照 ---------------- */

/** /settings 页面初始快照：一次取齐服务商/模型/绑定/用量（各查询独立，互不阻塞） */
export async function loadSettingsSnapshot(): Promise<SettingsSnapshot> {
  const [providers, models, bindings, usage] = await Promise.all([
    listProviderViews(),
    listModelViews(),
    listBindingViews(),
    storage().usageAll(),
  ]);
  return { providers, models, bindings, usage };
}
