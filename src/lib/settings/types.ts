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

/** api key 脱敏：保留尾 4 位（过短的 key 全遮，避免泄露比例过高） */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) return '****';
  return `****${trimmed.slice(-4)}`;
}
