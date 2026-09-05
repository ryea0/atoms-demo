/**
 * 计量层（DESIGN §5③ / CLAUDE.md 规则 10）：所有 LLM 调用统一走 meteredCall。
 * 流程：调用 provider（有 onDelta 走 stream，否则 complete）→ 计时 →
 * usage 缺失时用字符公式估算并标 estimated=1 → cost=0（单价默认 0）→ recordLlmCall 落库。
 *
 * 中止/超时也落一条（T29）：latency 真实、prompt/completion 全估算（completion 按已收增量），
 * 不再「被杀的调用零记录」；其余失败（HTTP/网络/坏响应）不落库。
 *
 * 只依赖 MeteringSink 结构类型（不 import StorageProvider）——Task 5 的存储实现
 * 合并后按结构满足该接口，LLM 层不感知 db 具体 dialect。
 */
import { estimateTokens } from '@/lib/llm/estimate';
import { getLlmProvider, LlmError, resolveModel } from '@/lib/llm/client';
import type { AgentRole } from '@/lib/db/provider/types';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResult } from '@/lib/llm/types';

/** 计量落库的最小接口（与 storage.recordLlmCall 字段一一对应） */
export interface MeteringSink {
  recordLlmCall(input: {
    projectId: number;
    agentRole: AgentRole;
    model: string;
    promptTokens: number;
    completionTokens: number;
    estimated: number;
    cost: number;
    latencyMs: number;
  }): Promise<void>;
}

/** meteredCall 入参：model 可省略（按角色 resolveModel 兜底） */
export type MeteredRequest = Omit<LlmRequest, 'model'> & { model?: string };

/** 拼接消息文本用于估算 */
function serializeMessages(messages: LlmMessage[]): string {
  return messages.map((m) => `${m.role}:${m.content}`).join('\n');
}

/** usage 缺失时的字符公式估算（prompt=消息，completion=正文+工具参数） */
function estimateUsage(req: LlmRequest, result: LlmResult): { promptTokens: number; completionTokens: number } {
  return {
    promptTokens: estimateTokens(serializeMessages(req.messages)),
    completionTokens: estimateTokens(result.content + JSON.stringify(result.toolCalls)),
  };
}

/** unknown → 可读错误文本（日志用，不含堆栈） */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 中止/超时也要计量（T29）：真机探针实证「90s 被杀的调用零记录」，
 * 用量账本必须留痕（latency 真实 + prompt/completion 全估算）。其余失败（HTTP/网络/坏响应）
 * 用量完全不可知且无部分产出，保持不落库。
 */
function isAbortOrTimeout(error: unknown): boolean {
  return error instanceof LlmError && (error.code === 'aborted' || error.code === 'timeout');
}

/** 统一落库出口：失败只 console.error 留痕，不影响调用结果（不静默吞） */
async function record(
  storage: MeteringSink,
  projectId: number,
  role: AgentRole,
  model: string,
  usage: { promptTokens: number; completionTokens: number },
  estimated: number,
  latencyMs: number,
): Promise<void> {
  try {
    await storage.recordLlmCall({
      projectId,
      agentRole: role,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      estimated,
      cost: 0, // 单价默认 0（DESIGN §5①：llm_models.price_input/output 默认 0）
      latencyMs,
    });
  } catch (error) {
    console.error(`[llm] llm_calls 落库失败（projectId=${projectId} role=${role}）：${describeError(error)}`);
  }
}

/**
 * 计量调用（provider 由工厂决定，LLM_PROVIDER 默认 mock）。
 * 这是编排器/角色的唯一入口：不再自行 new provider、不再绕过 llm_calls 计量。
 */
export async function meteredCall(
  storage: MeteringSink,
  projectId: number,
  role: AgentRole,
  req: MeteredRequest,
  onDelta?: (text: string) => void,
): Promise<LlmResult> {
  return meteredCallWith(getLlmProvider(), storage, projectId, role, req, onDelta);
}

/** 同 meteredCall，但 provider 显式注入（测试/编排器复用同一 provider 实例时用） */
export async function meteredCallWith(
  provider: LlmProvider,
  storage: MeteringSink,
  projectId: number,
  role: AgentRole,
  req: MeteredRequest,
  onDelta?: (text: string) => void,
): Promise<LlmResult> {
  const model = req.model !== undefined && req.model.trim() !== '' ? req.model : resolveModel(role);
  const request: LlmRequest = { ...req, model };

  const startedAt = Date.now();
  // 已收增量跟踪：中止/超时时 completion 按已收部分文本估算（零增量则记 0）
  let partialText = '';
  const guardedOnDelta =
    onDelta === undefined
      ? undefined
      : (text: string): void => {
          partialText += text;
          onDelta(text);
        };

  try {
    const result =
      guardedOnDelta !== undefined
        ? await provider.stream(request, guardedOnDelta)
        : await provider.complete(request);
    const latencyMs = Date.now() - startedAt;
    const usage = result.usage ?? estimateUsage(request, result);
    // 真实 usage → 0；估算兜底 → 1（DESIGN §5③ 降级链）
    await record(storage, projectId, role, model, usage, result.usage === null ? 1 : 0, latencyMs);
    return result;
  } catch (error) {
    if (isAbortOrTimeout(error)) {
      // 中止/超时：latency 真实，用量按已收部分估算并标 estimated=1（T29）
      const latencyMs = Date.now() - startedAt;
      await record(
        storage,
        projectId,
        role,
        model,
        {
          promptTokens: estimateTokens(serializeMessages(request.messages)),
          completionTokens: estimateTokens(partialText),
        },
        1,
        latencyMs,
      );
    }
    throw error;
  }
}
