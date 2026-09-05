/**
 * 设置页前端 API 客户端（客户端安全：只用 fetch 与 DTO 类型，不碰服务端模块）。
 * 统一「请求 → 结构化错误解析 → toast 反馈」；失败已 toast 并返回 null，调用方直接返回即可。
 * 额外返回 boolean（操作型）以区分「成功/失败」驱动本地 loading 态。
 */
import { toast } from 'sonner';
import type { BindingView, ImportResultView, ModelView, ProbeView, ProviderView } from './types';

/** 从结构化错误体里取 message（非结构化响应回退 HTTP 状态码文案） */
function readErrorMessage(payload: unknown, status: number): string {
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === 'string' && error.message !== '') return error.message;
  }
  return `请求失败（HTTP ${status}）`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(url, init);
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(readErrorMessage(payload, res.status));
      return null;
    }
    return payload as T;
  } catch (error) {
    toast.error(`网络错误：${error instanceof Error ? error.message : '未知错误'}`);
    return null;
  }
}

function jsonInit(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** Provider/模型清单（服务商面板刷新用） */
export function fetchProviderList(): Promise<{ providers: ProviderView[]; models: ModelView[] } | null> {
  return request('/api/settings/providers');
}

/** 绑定视图（7 角色恒齐全） */
export function fetchBindings(): Promise<{ bindings: BindingView[] } | null> {
  return request('/api/settings/bindings');
}

export function createProvider(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  enabled: boolean;
}): Promise<boolean> {
  return request('/api/settings/providers', jsonInit('POST', input)).then((payload) => payload !== null);
}

export function updateProvider(
  providerId: number,
  patch: { name?: string; baseUrl?: string; apiKey?: string; enabled?: boolean },
): Promise<boolean> {
  return request(`/api/settings/providers/${providerId}`, jsonInit('PATCH', patch)).then((payload) => payload !== null);
}

export function deleteProvider(providerId: number): Promise<boolean> {
  return request(`/api/settings/providers/${providerId}`, { method: 'DELETE' }).then((payload) => payload !== null);
}

export function probeProvider(providerId: number): Promise<ProbeView | null> {
  return request<{ probe: ProbeView }>(`/api/settings/providers/${providerId}/probe`, { method: 'POST' }).then(
    (payload) => payload?.probe ?? null,
  );
}

export function importProviderModels(providerId: number): Promise<ImportResultView | null> {
  return request<{ import: ImportResultView }>(`/api/settings/providers/${providerId}/models/import`, {
    method: 'POST',
  }).then((payload) => payload?.import ?? null);
}

export function updateModel(
  modelId: number,
  patch: { displayName?: string; priceInput?: number; priceOutput?: number; enabled?: boolean },
): Promise<boolean> {
  return request(`/api/settings/models/${modelId}`, jsonInit('PATCH', patch)).then((payload) => payload !== null);
}

export function deleteModel(modelId: number): Promise<boolean> {
  return request(`/api/settings/models/${modelId}`, { method: 'DELETE' }).then((payload) => payload !== null);
}

/** 保存/清除绑定：providerId/modelId 任一缺失 = 跟随全局默认 */
export function putBinding(input: {
  role: string;
  providerId?: number;
  modelId?: number;
}): Promise<BindingView | null> {
  return request<{ binding: BindingView }>('/api/settings/bindings', jsonInit('PUT', input)).then(
    (payload) => payload?.binding ?? null,
  );
}
