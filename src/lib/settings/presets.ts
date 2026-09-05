/**
 * 服务商预设（Task 24 / P3.5，客户端安全纯常量）：DESIGN §5①「预设豆包/ARK、DeepSeek、GLM、Kimi、OpenAI + 自定义」。
 * baseUrl 为各家 OpenAI 兼容根地址（probe/导入模型直接拼 `{baseUrl}/models`）。
 */
export interface ProviderPreset {
  key: string;
  /** 用户可见中文名（下拉文案） */
  label: string;
  /** 预填的 OpenAI 兼容地址；自定义预设为空串（由用户填写） */
  baseUrl: string;
  /** 预填的展示名 */
  name: string;
}

export const providerPresets: readonly ProviderPreset[] = [
  { key: 'ark', label: '豆包 / 火山方舟 ARK', name: '豆包 ARK', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { key: 'deepseek', label: 'DeepSeek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { key: 'glm', label: '智谱 GLM', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'kimi', label: 'Kimi（月之暗面）', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'openai', label: 'OpenAI', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { key: 'custom', label: '自定义', name: '', baseUrl: '' },
];
