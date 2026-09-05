/**
 * LLM 客户端（DESIGN §12）：getLlmProvider 工厂 + OpenAI 兼容实现。
 * - mock 走 ./mock（离线全链路），openai 走 fetch 直连 `${LLM_BASE_URL}/chat/completions`
 * - 流式：SSE `data:` 行解析，tool_calls 增量按 index 聚合，usage 取自最后 chunk
 * - 安全（rules/07）：密钥只在服务端 env，错误信息经脱敏（不回显 Authorization/api key）
 *
 * 服务端专用，不得进入客户端 bundle。
 */
import { z } from 'zod';
import { createMockProvider } from '@/lib/llm/mock';
import type { AgentRole } from '@/lib/db/provider/types';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResult, ToolCall } from '@/lib/llm/types';

/** 未配置 LLM_MODEL 时的内置默认模型（mock provider 不敏感） */
export const DEFAULT_MODEL = 'mock-model';

/** 单次请求超时（DESIGN §4.6「单步超时 90s」） */
export const REQUEST_TIMEOUT_MS = 90_000;

/** 结构化错误（规则 01/07：边界错误带 code/message，不泄漏堆栈与密钥） */
export type LlmErrorCode =
  | 'unknown_provider'
  | 'config_missing'
  | 'http_error'
  | 'network_error'
  | 'aborted'
  | 'timeout'
  | 'bad_response';

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly status?: number;

  constructor(code: LlmErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.status = status;
  }
}

/** 全局默认 + 角色级覆盖（LLM_MODEL_LEADER / LLM_MODEL_ENGINEER …） */
export function resolveModel(role: AgentRole, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[`LLM_MODEL_${role.toUpperCase()}`]?.trim();
  if (override !== undefined && override !== '') return override;
  const globalModel = env.LLM_MODEL?.trim();
  if (globalModel !== undefined && globalModel !== '') return globalModel;
  return DEFAULT_MODEL;
}

/**
 * Provider 工厂：LLM_PROVIDER = mock（默认）| openai。
 * 只在未知取值时抛错；openai 的配置校验延迟到调用时（构造永不发请求、不炸）。
 */
export function getLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const kind = (env.LLM_PROVIDER ?? 'mock').trim().toLowerCase();
  if (kind === 'mock') return createMockProvider();
  if (kind === 'openai') return createOpenAiProvider(env);
  throw new LlmError('unknown_provider', `未知 LLM_PROVIDER：${kind}（可选 mock|openai）`);
}

/* ------------------------------------------------------------------ */
/* OpenAI 兼容实现                                                      */
/* ------------------------------------------------------------------ */

/** 响应脱敏：剔除 bearer 头与配置的 api key（防错误信息泄密） */
function sanitize(text: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('***');
  return withoutKey.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}

/** 错误消息统一截断，避免把整页 HTML 塞进日志 */
function clip(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…（截断）`;
}

/** args → OpenAI arguments 字符串（对象序列化；原始字符串原样透传） */
function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args) ?? 'null';
  } catch (error) {
    // 循环引用等极端情况：退化为字符串占位，不中断调用
    return JSON.stringify({ unserializable: String(error) }) ?? '"unserializable"';
  }
}

/** arguments 字符串 → args（解析失败保留原文，不丢工具调用） */
function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/** LlmMessage → OpenAI chat messages（含工具循环历史） */
function toOpenAiMessages(messages: LlmMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content === '' ? null : message.content,
        tool_calls: message.toolCalls.map((call: ToolCall) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: stringifyArgs(call.args) },
        })),
      };
    }
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

/** 组装请求体（stream 决定是否带 stream_options.include_usage） */
function toRequestBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOpenAiMessages(req.messages),
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = 'auto';
  }
  if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
  return body;
}

/* 响应结构（宽松解析：外部数据边界，未知字段一律忽略） */
const usageSchema = z
  .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
  .partial()
  .nullish();

const deltaToolCallSchema = z.object({
  index: z.number(),
  id: z.string().optional(),
  function: z
    .object({ name: z.string().optional(), arguments: z.string().optional() })
    .partial()
    .optional(),
});

const streamChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({ content: z.string().nullish(), tool_calls: z.array(deltaToolCallSchema).nullish() })
          .partial()
          .nullish(),
      })
    )
    .nullish(),
  usage: usageSchema,
});

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullish(),
            tool_calls: z
              .array(
                z.object({
                  id: z.string().optional(),
                  function: z
                    .object({ name: z.string().optional(), arguments: z.string().optional() })
                    .partial()
                    .optional(),
                })
              )
              .nullish(),
          })
          .partial()
          .nullish(),
      })
    )
    .min(1),
  usage: usageSchema,
});

/** tool_calls 增量累积桶：id/name 取首个非空，arguments 按 JSON 片段拼接 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  argsText: string;
}

/** 合并单个 delta 到累积桶 */
function accumulateToolCall(map: Map<number, ToolCallAccumulator>, delta: z.infer<typeof deltaToolCallSchema>): void {
  const current = map.get(delta.index) ?? { id: '', name: '', argsText: '' };
  if (current.id === '' && delta.id !== undefined && delta.id !== '') current.id = delta.id;
  const name = delta.function?.name;
  if (current.name === '' && name !== undefined && name !== '') current.name = name;
  const args = delta.function?.arguments;
  if (args !== undefined && args !== '') current.argsText += args;
  map.set(delta.index, current);
}

/** 累积桶 → ToolCall[]（按 index 稳定排序） */
function materializeToolCalls(map: Map<number, ToolCallAccumulator>): ToolCall[] {
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, acc]) => ({
      id: acc.id === '' ? `call_${index}` : acc.id,
      name: acc.name,
      args: parseArgs(acc.argsText),
    }));
}

/** caller signal + 90s 超时合并（AbortSignal.any，Node 22） */
function linkSignals(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/** 网络层异常 → 结构化错误（区分中止/超时） */
function toLlmError(error: unknown, apiKey: string): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Error) {
    const message = sanitize(error.message, apiKey);
    if (error.name === 'AbortError') return new LlmError('aborted', `LLM 调用已中止：${message}`);
    if (error.name === 'TimeoutError') return new LlmError('timeout', `LLM 调用超时（${REQUEST_TIMEOUT_MS}ms）`);
    return new LlmError('network_error', `LLM 请求失败：${message}`);
  }
  return new LlmError('network_error', `LLM 请求失败：${sanitize(String(error), apiKey)}`);
}

/** 创建 OpenAI 兼容 provider（LLM_PROVIDER=openai） */
export function createOpenAiProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const apiKey = (): string => env.LLM_API_KEY?.trim() ?? '';

  /** 读取并归一化 base url（去尾斜杠；缺失/缺 key 均在调用时报 config_missing） */
  const endpoint = (): string => {
    const base = env.LLM_BASE_URL?.trim() ?? '';
    if (base === '') {
      throw new LlmError('config_missing', '缺少 LLM_BASE_URL（LLM_PROVIDER=openai 时必填，如 https://api.example.com/v1）');
    }
    if (apiKey() === '') throw new LlmError('config_missing', '缺少 LLM_API_KEY（LLM_PROVIDER=openai 时必填）');
    return `${base.replace(/\/+$/, '')}/chat/completions`;
  };

  /** 发起请求并处理 HTTP/网络层错误 */
  const post = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> => {
    const url = endpoint();
    const key = apiKey();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: linkSignals(signal),
      });
    } catch (error) {
      throw toLlmError(error, key);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => ''); // 读不到错误体时以空串兜底
      throw new LlmError(
        'http_error',
        `LLM 请求失败：HTTP ${response.status} ${clip(sanitize(text, key))}`,
        response.status,
      );
    }
    return response;
  };

  return {
    name: 'openai',

    /** 非流式：一次拿全量结果 */
    async complete(req: LlmRequest): Promise<LlmResult> {
      const response = await post(toRequestBody(req, false), req.signal);
      const json: unknown = await response.json();
      const parsed = completionSchema.safeParse(json);
      if (!parsed.success) {
        throw new LlmError('bad_response', `LLM 响应结构无法解析：${clip(parsed.error.message, 300)}`);
      }
      const choice = parsed.data.choices[0];
      const message = choice?.message;
      const toolCalls = (message?.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.function?.name ?? '',
        args: parseArgs(call.function?.arguments ?? ''),
      }));
      const usage = parsed.data.usage;
      return {
        content: message?.content ?? '',
        toolCalls,
        usage:
          usage?.prompt_tokens === undefined || usage?.completion_tokens === undefined
            ? null
            : { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens },
      };
    },

    /** 流式：逐 chunk 回调增量，返回聚合后的完整结果 */
    async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      const response = await post(toRequestBody(req, true), req.signal);
      const body = response.body;
      if (body === null) throw new LlmError('bad_response', 'LLM 流式响应缺少 body');

      const reader = body.getReader();
      const decoder = new TextDecoder();
      const toolCallMap = new Map<number, ToolCallAccumulator>();
      let buffer = '';
      let content = '';
      let usage: { promptTokens: number; completionTokens: number } | null = null;
      let sawDone = false;

      /** 处理一条 SSE 行（data: payload） */
      const handleData = (payload: string): void => {
        if (payload === '[DONE]') {
          sawDone = true;
          return;
        }
        let json: unknown;
        try {
          json = JSON.parse(payload) as unknown;
        } catch {
          console.warn('[llm] 跳过无法解析的 SSE data 行');
          return;
        }
        const chunk = streamChunkSchema.safeParse(json);
        if (!chunk.success) {
          console.warn('[llm] 跳过结构异常的 SSE chunk');
          return;
        }
        const delta = chunk.data.choices?.[0]?.delta;
        const text = delta?.content;
        if (text !== undefined && text !== null && text !== '') {
          content += text;
          onDelta(text);
        }
        for (const call of delta?.tool_calls ?? []) accumulateToolCall(toolCallMap, call);
        const chunkUsage = chunk.data.usage;
        if (chunkUsage?.prompt_tokens !== undefined && chunkUsage?.completion_tokens !== undefined) {
          usage = { promptTokens: chunkUsage.prompt_tokens, completionTokens: chunkUsage.completion_tokens };
        }
      };

      try {
        while (!sawDone) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === '' || trimmed.startsWith(':')) continue; // 空行/心跳注释
            if (!trimmed.startsWith('data:')) continue; // event:/id: 等行忽略
            handleData(trimmed.slice(5).trim());
            if (sawDone) break;
          }
        }
        buffer += decoder.decode();
        const tail = buffer.trim();
        if (!sawDone && tail.startsWith('data:')) handleData(tail.slice(5).trim());
      } catch (error) {
        throw toLlmError(error, apiKey());
      } finally {
        reader.releaseLock();
      }

      return { content, toolCalls: materializeToolCalls(toolCallMap), usage };
    },
  };
}
