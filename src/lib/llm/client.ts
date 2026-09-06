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

/** 非流式请求总时长上限（DESIGN §4.6「单步超时 90s」；env LLM_TIMEOUT_MS 可调） */
export const DEFAULT_COMPLETE_TIMEOUT_MS = 90_000;
/**
 * 流式空闲超时（T29）：连续无 chunk 超过该阈值才判死，每收到数据即重置。
 * 默认 45s 须大于实测 provider 最大 chunk 间隙（探针 9.3s），否则健康流被误杀。
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 45_000;
/** 流式总时长上限（T29）：长文生成健康流也会跑满数分钟，兜底防无限占用 */
export const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 300_000;

/**
 * 单个 setTimeout 所能接受的最大毫秒数（2^31-1，约 24.8 天）。
 * 超过它 Node 会把延时钳到 1ms（stream 计时器瞬间判死），AbortSignal.timeout 则直接抛 RangeError。
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * 解析正整数毫秒配置：缺省/空串/非数字/≤0/小数一律回退默认，不抛错；
 * 荒谬大值封顶到 MAX_TIMEOUT_MS（保留「尽量长」的意图，同时保证计时器可用）。
 * 配置写错宁可退回保守默认，也不让一次手滑把超时打成 0 或 NaN。
 */
export function readPositiveIntMs(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}

/** 超时类别与实际生效值（错误消息必须带上，便于探针/日志定位是哪一刀） */
interface TimeoutSpec {
  kind: 'complete' | 'idle' | 'total';
  ms: number;
}

/** 超时错误消息：带类别与实际生效值（不再硬编码 90000ms） */
function timeoutMessage(spec: TimeoutSpec): string {
  if (spec.kind === 'complete') return `LLM 调用超时（complete 总时长上限 ${spec.ms}ms）`;
  if (spec.kind === 'idle') return `LLM 流式超时（idle 连续 ${spec.ms}ms 未收到数据）`;
  return `LLM 流式超时（total 总时长上限 ${spec.ms}ms）`;
}

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

/** 响应脱敏：剔除 bearer 头与配置的 api key（防错误信息泄密）；probe.ts 复用同一规则 */
export function sanitize(text: string, apiKey: string): string {
  const withoutKey = apiKey === '' ? text : text.split(apiKey).join('***');
  return withoutKey.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
}

/** 错误消息统一截断，避免把整页 HTML 塞进日志 */
function clip(text: string, max = 500): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…（截断）`;
}

/**
 * args → OpenAI arguments 字符串（对象序列化；原始字符串原样透传）。
 * 字符串透传是 T35 round-trip 的另一半：parseArgs 解双层/兜底得到的字符串若在这里
 * 被 JSON.stringify 二次编码，历史里会重新出现模型那层多余编码，错误被固化而非纠正。
 */
function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args) ?? 'null';
  } catch (error) {
    // 循环引用等极端情况：退化为字符串占位，不中断调用
    return JSON.stringify({ unserializable: String(error) }) ?? '"unserializable"';
  }
}

/**
 * arguments 字符串 → args（解析失败保留原文，不丢工具调用）。
 * 双层编码兜底（T35，真机 ARK doubao 实证）：偶发把整个参数对象再当字符串编码一次
 * （arguments 形如 "{\"path\":...}"），只解一层得到 string → 上层 zod 根级校验失败
 * （expected object, received string）→ 回喂重试后模型仍双层 → 任务终止。
 * 故第一层解出 string 时再 parse 一次；**至多两层**（三层以上属病态输入，停手不解，
 * 交上层校验回喂）——固定两次尝试、不递归，杜绝病态嵌套拖垮解析。
 * 二层仍失败保留一层解码结果：比原文少一层转义噪音，且与 stringifyArgs 的字符串透传
 * 配合后回喂历史不再二次编码（round-trip 不断）。
 */
function parseArgs(raw: string): unknown {
  let first: unknown;
  try {
    first = JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
  if (typeof first !== 'string') return first;
  try {
    return JSON.parse(first) as unknown;
  } catch {
    return first;
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
          .object({
            content: z.string().nullish(),
            tool_calls: z.array(deltaToolCallSchema).nullish(),
            // 思考流（T31）：主流字段 reasoning_content，部分兼容网关用 reasoning 别名；都没有=不思考
            reasoning_content: z.string().nullish(),
            reasoning: z.string().nullish(),
          })
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

/**
 * caller signal + 总时长超时合并（AbortSignal.any，Node 22）。
 * 仅 complete 路径使用（一次性一刀切）；流式路径需「每 chunk 续命」，
 * AbortSignal.timeout 不可重置，故改由 stream 内自管 AbortController + 手动 timer。
 */
function linkSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const total = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? total : AbortSignal.any([signal, total]);
}

/**
 * 网络层异常 → 结构化错误（区分中止/超时）。
 * AbortError=caller 中止（code=aborted，永不降级）；TimeoutError=AbortSignal.timeout 实抛
 * （Node 18+/undici，complete 路径的总时长一刀切），消息带实际生效值与类别。
 */
function toLlmError(error: unknown, apiKey: string, timeout?: TimeoutSpec): LlmError {
  if (error instanceof LlmError) return error;
  if (error instanceof Error) {
    const message = sanitize(error.message, apiKey);
    if (error.name === 'AbortError') return new LlmError('aborted', `LLM 调用已中止：${message}`);
    if (error.name === 'TimeoutError') {
      return new LlmError('timeout', timeoutMessage(timeout ?? { kind: 'complete', ms: DEFAULT_COMPLETE_TIMEOUT_MS }));
    }
    return new LlmError('network_error', `LLM 请求失败：${message}`);
  }
  return new LlmError('network_error', `LLM 请求失败：${sanitize(String(error), apiKey)}`);
}

/**
 * 读取并解析 JSON 响应体（complete 路径）。
 * 200 但响应非 JSON（网关返回 HTML、响应体截断）→ 结构化 bad_response：
 * 带 code/status 与脱敏后的响应体片段，不向外抛裸 SyntaxError（V8 会内嵌响应体原文）。
 */
async function readJsonBody(response: Response, key: string, timeout?: TimeoutSpec): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw toLlmError(error, key, timeout); // 响应体读取中断（网络/截断/总时长到点）
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LlmError(
      'bad_response',
      `LLM 响应非 JSON（HTTP ${response.status} ${response.headers.get('content-type') ?? ''}）：${clip(sanitize(text, key))}`,
      response.status,
    );
  }
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

  /**
   * 发起请求并处理 HTTP/网络层错误。
   * signal 由调用方组装好（complete=caller+总时长；stream=caller+自管 idle/total 计时器），
   * 超时上下文用于错误归因与消息（不再硬编码 90000ms）。
   */
  const post = async (body: Record<string, unknown>, signal: AbortSignal, timeout?: TimeoutSpec): Promise<Response> => {
    const url = endpoint();
    const key = apiKey();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw toLlmError(error, key, timeout);
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
      // 总时长一刀切（T29：保持 90s 语义，env 可调）——complete 无内容进度可言，无法按数据续命
      const completeMs = readPositiveIntMs(env.LLM_TIMEOUT_MS, DEFAULT_COMPLETE_TIMEOUT_MS);
      const spec: TimeoutSpec = { kind: 'complete', ms: completeMs };
      const response = await post(toRequestBody(req, false), linkSignals(req.signal, completeMs), spec);
      const json: unknown = await readJsonBody(response, apiKey(), spec);
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

    /**
     * 流式：逐 chunk 回调增量，返回聚合后的完整结果。
     * 超时双阈值（T29，DESIGN §4.6）：idle=连续无数据判死（每收到数据重置），
     * total=总时长兜底。AbortSignal.timeout 不可重置，故用 AbortController + 手动 timer，
     * finally 统一清理防泄漏；caller 中止经 AbortSignal.any 照常级联。
     */
    async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      const idleMs = readPositiveIntMs(env.LLM_STREAM_IDLE_TIMEOUT_MS, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      const totalMs = readPositiveIntMs(env.LLM_STREAM_TOTAL_TIMEOUT_MS, DEFAULT_STREAM_TOTAL_TIMEOUT_MS);
      const controller = new AbortController();
      const signal = req.signal === undefined ? controller.signal : AbortSignal.any([req.signal, controller.signal]);
      let idleFired = false;
      let totalFired = false;

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      /** 空闲计时重新起算：每收到一段数据（含心跳/空段）即续命 */
      const armIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleFired = true;
          controller.abort();
        }, idleMs);
      };
      const totalTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        totalFired = true;
        controller.abort();
      }, totalMs);
      const clearTimers = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        clearTimeout(totalTimer);
      };

      /** 中止归因：caller 级联 > idle > total > 其他（网络/HTTP 错误原样映射，code 语义不变） */
      const attribute = (error: unknown): LlmError => {
        if (req.signal?.aborted === true) return toLlmError(error, apiKey());
        if (idleFired) return new LlmError('timeout', timeoutMessage({ kind: 'idle', ms: idleMs }));
        if (totalFired) return new LlmError('timeout', timeoutMessage({ kind: 'total', ms: totalMs }));
        return toLlmError(error, apiKey());
      };

      try {
        armIdle(); // 首片之前同样受空闲约束（连接挂起/首 token 停滞也算「无数据」）
        let response: Response;
        try {
          response = await post(toRequestBody(req, true), signal);
        } catch (error) {
          throw attribute(error);
        }
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
          // 思考流先行（T31）：只回调、不进 content——completion 计量口径不受影响（见 LlmRequest 注）
          const reasoning = delta?.reasoning_content ?? delta?.reasoning;
          if (reasoning !== undefined && reasoning !== null && reasoning !== '') req.onReasoning?.(reasoning);
          const text = delta?.content;
          if (text !== undefined && text !== null && text !== '') {
            content += text;
            onDelta(text);
          }
          for (const call of delta?.tool_calls ?? []) {
            accumulateToolCall(toolCallMap, call);
            // 参数分片通道：id 已知才透传（真机首片带 id+name、后续只带 arguments；
            // 无 id 的网关降级为打字机缺段，聚合结果不受影响）——见 LlmRequest.onToolCallDelta 注
            const argsFragment = call.function?.arguments;
            if (argsFragment !== undefined && argsFragment !== '' && req.onToolCallDelta !== undefined) {
              const acc = toolCallMap.get(call.index);
              if (acc !== undefined && acc.id !== '') {
                req.onToolCallDelta({ index: call.index, id: acc.id, name: acc.name, fragment: argsFragment });
              }
            }
          }
          const chunkUsage = chunk.data.usage;
          if (chunkUsage?.prompt_tokens !== undefined && chunkUsage?.completion_tokens !== undefined) {
            usage = { promptTokens: chunkUsage.prompt_tokens, completionTokens: chunkUsage.completion_tokens };
          }
        };

        try {
          while (!sawDone) {
            const { done, value } = await reader.read();
            if (done) break;
            armIdle(); // 收到数据 → 空闲计时重新起算（慢流不误杀）
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
          throw attribute(error);
        } finally {
          reader.releaseLock();
        }

        return { content, toolCalls: materializeToolCalls(toolCallMap), usage };
      } finally {
        clearTimers(); // 成功/失败/中止都要清掉计时器，不残留挂起句柄
      }
    },
  };
}
