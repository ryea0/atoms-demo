/**
 * AgentRunner 内核（Task 8，DESIGN §3.4 可靠性三段式 / §4.5 工具 / §4.6 防失控）。
 *
 * 职责边界（CLAUDE.md 规则 1：LLM 只做决策，确定性代码做执行）：
 * 内核只做「消息循环 + 工具调用裁决 + 防失控」，不组装上下文（Task 9 context.ts）、
 * 不调度任务（Task 10 orchestrator）、不落库（回调由编排器消费）。
 *
 * 循环协议：
 *   messages = [system, user] → provider.stream →
 *   - 无 toolCalls：结束，返回最终 content
 *   - 有 toolCalls：逐个裁决——
 *       未知工具 / zod 校验失败 → 错误说明以 {role:'tool',toolCallId} 回喂（DESIGN §3.4 第 2 步）；
 *         若「上一步已经出现过校验失败」即重试预算耗尽 → 抛 AgentValidationError（第 3 步交给调用方回退）
 *       校验通过 → tool.execute → output 回喂（执行失败 ok=false 同样回喂，但不算校验失败）
 *   → 继续下一轮
 *
 * 防失控（§4.6）：maxSteps（默认 12，每次 provider 调用记 1 步）超限抛错；
 * signal 在每轮 provider 调用前与每次工具执行前检查；工具结果截断由工具层负责。
 *
 * 错误上抛约定（provider/stream 错误不在内核翻译，也不做三段式第 3 步回退——那是调用方的活）：
 * - AgentAbortError（name='AbortError'）：signal 已触发（含 provider 因中止而抛错时的归一）
 * - AgentValidationError：校验重试预算耗尽
 * - 其余（provider 网络/HTTP/解析错误、maxSteps 超限的普通 Error）原样上抛，
 *   由调用方落 agent_runs.error + SSE error 事件，并决定是否回退默认流水线
 */
import { z } from 'zod';
import { getLlmProvider } from '@/lib/llm/client';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResult, ToolDef } from '@/lib/llm/types';
import type { Tool } from '@/lib/agents/tools';
import { AgentAbortError, AgentValidationError, type RunOptions, type RunResult } from './types';

export { AgentAbortError, AgentValidationError } from './types';
export type { RunnerCallbacks, RunOptions, RunResult } from './types';

/** 默认最大步数（DESIGN §4.6）：每次 provider 调用记 1 步 */
export const DEFAULT_MAX_STEPS = 12;

/** zod 校验错误 → 一行可读中文（字段路径 + 原因），直接回喂模型（与工具层输出同风格） */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** signal 已触发即抛 AgentAbortError（每轮 provider 调用前 / 每次工具执行前调用） */
function throwIfAborted(signal: AbortSignal | undefined, role: string): void {
  if (signal?.aborted === true) throw new AgentAbortError(`agent 执行已被中止（role=${role}）`);
}

/**
 * 运行一次 agent：决策循环 + 工具裁决。见文件头注释的循环协议与错误上抛约定。
 */
export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const provider: LlmProvider = opts.provider ?? getLlmProvider();
  const signal = opts.signal;
  const onToolCall = opts.callbacks?.onToolCall;
  /** provider 的增量回调直通内核回调（不缓冲、不裁剪） */
  const forwardDelta = (text: string): void => {
    opts.callbacks?.onDelta?.(text);
  };

  const toolByName = new Map<string, Tool>(opts.tools.map((tool) => [tool.name, tool]));
  const toolDefs: ToolDef[] = opts.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  const messages: LlmMessage[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userPrompt },
  ];

  /** 模型发起的全部工具调用（含校验失败/未知工具——供调用方审计与展示） */
  const issuedCalls: { name: string; args: unknown }[] = [];
  let steps = 0;
  /** 上一步是否出现过校验失败：是则本轮再失败即重试预算耗尽 */
  let lastStepHadValidationError = false;

  while (true) {
    throwIfAborted(signal, opts.role);
    if (steps >= maxSteps) {
      throw new Error(`已达最大步数上限（maxSteps=${maxSteps}，实际执行 ${steps} 步仍未完成），已终止以防失控`);
    }

    const request: LlmRequest = {
      model: opts.model,
      messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      signal,
    };

    let result: LlmResult;
    try {
      result = await provider.stream(request, forwardDelta);
    } catch (error) {
      // 我们的 signal 触发导致的 provider 中断，统一归一为 AbortError（停止语义，非失败语义）
      if (signal?.aborted === true) {
        throw new AgentAbortError(
          `agent 执行已被中止（role=${opts.role}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
    steps += 1;

    if (result.toolCalls.length === 0) {
      return { content: result.content, steps, toolCalls: issuedCalls };
    }

    // 模型的本轮决策连同工具调用一起进历史，工具结果逐条跟在后面
    messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

    let stepHadValidationError = false;
    for (const call of result.toolCalls) {
      throwIfAborted(signal, opts.role); // 工具执行之间也检查，停止要即时生效（DESIGN §3.5）
      issuedCalls.push({ name: call.name, args: call.args });

      const tool = toolByName.get(call.name);
      let output: string;
      if (tool === undefined) {
        // 未知工具等同校验失败（模型没按工具协议来），错误说明回喂给同一条重试预算
        output = `未知工具：${call.name}（可用工具：${opts.tools.map((item) => item.name).join('、') || '（无）'}）`;
        if (lastStepHadValidationError || stepHadValidationError) throw new AgentValidationError(call.name, output);
        stepHadValidationError = true;
      } else {
        const parsed = tool.schema.safeParse(call.args);
        if (!parsed.success) {
          output = `参数校验失败：${formatIssues(parsed.error)}`;
          if (lastStepHadValidationError || stepHadValidationError) throw new AgentValidationError(call.name, output);
          stepHadValidationError = true;
        } else {
          // 执行失败（ok=false，如文件不存在/路径不合法）只是普通工具结果，回喂后继续，不占校验重试预算
          output = (await tool.execute(parsed.data, opts.ctx)).output;
        }
      }

      messages.push({ role: 'tool', toolCallId: call.id, content: output });
      onToolCall?.({ name: call.name, args: call.args, output });
    }
    lastStepHadValidationError = stepHadValidationError;
  }
}
