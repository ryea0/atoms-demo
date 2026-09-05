/**
 * 设置页 DTO（Task 24 / P3.5，客户端安全）：
 * 只允许类型、纯常量与纯函数——绝不 import db/env/llm 等服务端模块（会被前端组件直接引用）。
 *
 * 密钥红线（.claude/rules/07）：api_key 只写不读，跨边界的 ProviderView 只带 apiKeyMasked（尾 4 位），
 * 原始 key 只存在于服务端 LlmProviderRow，任何响应/日志都不回显。
 */
import type { AgentRole } from '@/lib/db/provider/types';

/** 绑定表固定行序（与 src/lib/agents/registry.ts 的 roleRegistry 键序一致） */
export const agentRoles = ['leader', 'pm', 'architect', 'engineer', 'analyst', 'seo', 'ads'] as const satisfies readonly AgentRole[];

/** 服务商视图（对外形态）：apiKeyMasked = 脱敏尾 4 位 */
export interface ProviderView {
  id: number;
  name: string;
  baseUrl: string;
  apiKeyMasked: string;
  enabled: boolean;
  createdAt: number;
}

/** 模型视图（全局清单，单价用于 llm_calls 成本核算） */
export interface ModelView {
  id: number;
  providerId: number;
  modelId: string;
  displayName: string;
  priceInput: number;
  priceOutput: number;
  enabled: boolean;
}

/** 角色绑定视图：7 角色恒齐全；modelLabel=null = 未绑定（跟随全局默认） */
export interface BindingView {
  role: AgentRole;
  providerId: number | null;
  modelId: number | null;
  modelLabel: string | null;
}

/** 用量卡片聚合行（全局，跨项目）：estimatedCalls>0 表示该组含估算调用 */
export interface UsageCardRow {
  agentRole: AgentRole;
  model: string;
  tokens: number;
  calls: number;
  estimatedCalls: number;
}

/** 测试连接结果：失败时 error 已脱敏（不含 api key） */
export interface ProbeView {
  ok: boolean;
  latencyMs: number;
  modelCount: number;
  models: string[];
  error: string | null;
}

/** 导入模型结果：discovered=探测到，imported=新落库，skipped=已存在被去重 */
export interface ImportResultView {
  discovered: number;
  imported: number;
  skipped: number;
}

/** /settings 页面一次取齐的全量数据（RSC 初始快照） */
export interface SettingsSnapshot {
  providers: ProviderView[];
  models: ModelView[];
  bindings: BindingView[];
  usage: UsageCardRow[];
}

/**
 * 个人偏好（DESIGN §3.9/§4.2，session 级）。字段名即持久化/HTTP 契约
 * （`preferences.editing_enabled`，与设计文档逐字一致，故用 snake_case）。
 */
export interface UserPreferences {
  /** 人工编辑能力开关（默认开）：关 = 纯只读查看器，agent 永不遇软锁 */
  editing_enabled: boolean;
  /** 默认生成模式（默认 fast）：新建项目表单/快速链路的缺省值 */
  default_mode: 'fast' | 'full';
}

/** 偏好局部补丁（HTTP PUT 入参；缺省键 = 不改既有值） */
export interface UserPreferencesPatch {
  editing_enabled?: boolean;
  default_mode?: 'fast' | 'full';
}

/** 默认偏好：编辑能力默认开（DESIGN §3.9「开=完整人机共编」） */
export const DEFAULT_USER_PREFERENCES: UserPreferences = { editing_enabled: true, default_mode: 'fast' };

/**
 * unknown → 偏好（存储层 json 反序列化结果是 unknown，字段级收窄；缺失/类型不符回默认值）。
 * 纯函数：客户端拿不到偏好或拿到脏数据时也走这里兜底，前后端口径一致。
 */
export function normalizePreferences(data: unknown): UserPreferences {
  if (typeof data !== 'object' || data === null) return { ...DEFAULT_USER_PREFERENCES };
  const raw = data as Record<string, unknown>;
  return {
    editing_enabled: typeof raw['editing_enabled'] === 'boolean' ? raw['editing_enabled'] : DEFAULT_USER_PREFERENCES.editing_enabled,
    default_mode: raw['default_mode'] === 'full' || raw['default_mode'] === 'fast'
      ? raw['default_mode']
      : DEFAULT_USER_PREFERENCES.default_mode,
  };
}

/** api key 脱敏：保留尾 4 位（过短的 key 全遮，避免泄露比例过高） */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) return '****';
  return `****${trimmed.slice(-4)}`;
}
