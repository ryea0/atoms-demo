/**
 * 模型探测（DESIGN §5①「测试连接/导入模型」，参考 hify-provider 的 test-connection 计时）：
 * GET `{baseUrl 去尾斜杠}/models`（OpenAI 兼容 `data[].id`），墙钟计时。
 * 设置页「测试连接」消费 ok + latencyMs，「导入模型」消费 models 落 llm_models（T24）。
 *
 * 安全（.claude/rules/07）：错误信息一律经 sanitize 脱敏（剔除 bearer 头与配置的 api key），
 * 本模块只发一次 GET、不带任何业务数据；latencyMs 始终实测（成功与失败路径都返回墙钟值）。
 * 服务端专用，不得进入客户端 bundle。
 */
import { z } from 'zod';
import { sanitize } from '@/lib/llm/client';

/** 缺省探测超时（DESIGN §5①：10s） */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface ProbeInput {
  /** OpenAI 兼容根地址（如 https://api.example.com/v1）；容忍尾斜杠/空白 */
  baseUrl: string;
  /** 服务商 api key：仅用于本次请求的 Authorization 头，绝不进返回值/日志 */
  apiKey: string;
  timeoutMs?: number;
}

/** 探测结果：ok=false 时 error 已脱敏（不含 api key） */
export type ProbeResult =
  | { ok: true; latencyMs: number; models: string[] }
  | { ok: false; latencyMs: number; error: string };

/** OpenAI 兼容 /models 响应（宽松解析：只取 data[].id，其余字段忽略；data 为空 = 连接可用但无可见模型） */
const modelsSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

/** 错误信息截断：避免把整页 HTML/超长响应塞进 UI 与日志 */
function clip(text: string, max = 300): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…（截断）`;
}

/**
 * unknown → 可读错误文本（脱敏后）。
 * 超时归类：AbortSignal.timeout 实际抛 DOMException name='TimeoutError'（Node 18+/undici），
 * 个别运行时/ polyfill 抛 name='AbortError'——两者同归「探测超时」（与 fallback.ts classifyLlmError 口径一致）。
 */
function describeFailure(error: unknown, timeoutMs: number, apiKey: string): string {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return `探测超时（${timeoutMs}ms）`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `探测请求失败：${clip(sanitize(message, apiKey))}`;
}

/** 探测服务商可用性与其下的模型清单（不发真实补全请求、零业务数据） */
export async function probeProvider(input: ProbeInput): Promise<ProbeResult> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;
  const base = input.baseUrl.trim().replace(/\/+$/, '');
  if (base === '') {
    return { ok: false, latencyMs: elapsed(), error: '缺少 baseUrl（OpenAI 兼容地址，如 https://api.example.com/v1）' };
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetch(`${base}/models`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { ok: false, latencyMs: elapsed(), error: describeFailure(error, timeoutMs, input.apiKey) };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => ''); // 读不到错误体时以空串兜底
    return {
      ok: false,
      latencyMs: elapsed(),
      error: `HTTP ${response.status} ${clip(sanitize(body, input.apiKey))}`.trim(),
    };
  }

  const text = await response.text().catch(() => '');
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, latencyMs: elapsed(), error: `响应非 JSON：${clip(sanitize(text, input.apiKey))}` };
  }

  const parsed = modelsSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, latencyMs: elapsed(), error: '响应结构不符合 OpenAI 兼容 /models（缺 data[].id）' };
  }

  // 去重后保持服务端返回顺序（部分服务商按能力排序，导入 UI 沿用其顺序）
  const models = [...new Set(parsed.data.data.map((entry) => entry.id))];
  return { ok: true, latencyMs: elapsed(), models };
}
