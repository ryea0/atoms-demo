/**
 * Agent 内核类型契约（Task 8，DESIGN §5④「通用内核」）：角色层/编排器只依赖本文件与 runAgent。
 *
 * 错误语义（三段式第 3 步的回退由调用方做，内核只负责把失败原因说清楚）：
 * - AgentValidationError：工具名/参数校验在「回喂重试一次」之后仍然失败——模型不会用工具，
 *   继续循环只会烧 token，故终止并带上工具名与校验详情
 * - AgentAbortError：`name='AbortError'`，与 DOM/Node 的 AbortError 命名兼容——
 *   调用方既可 `instanceof AgentAbortError`，也可 `error.name === 'AbortError'` 识别停止语义
 */
import type { Tool, ToolContext } from '@/lib/agents/tools';
import type { AgentRole } from '@/lib/db/provider/types';
import type { LlmProvider, ToolCallStreamDelta } from '@/lib/llm/types';

/** 内核回调：编排器用来落库/发 SSE 与转发打字机流 */
export interface RunnerCallbacks {
  /**
   * 每个模型发起的工具调用产生回喂文本后触发（含校验失败/未知工具——此时 output 即回喂给模型的错误说明），
   * 供时间线展示与 agent_runs 落库；args 为模型原始入参（未收窄，可能是非法形状）。
   * 消费者契约：以 `ok === false` 判定失败用于时间线/展示（参数校验失败、未知工具名恒为 false；
   * 工具已执行时取 execute 返回的 ok，执行失败如"文件不存在"也是 false）；output 永远可直接展示。
   */
  onToolCall?: (call: { name: string; args: unknown; output: string; ok?: boolean }) => void;
  /** 流式增量：原样透传 provider.stream 的 onDelta，内核不缓冲不裁剪（落库时机=file_end，见 DESIGN §3.6） */
  onDelta?: (text: string) => void;
  /**
   * 思考流增量（T31）：provider 解析 delta.reasoning_content 后回调，内核原样透传、不缓冲不裁剪，
   * 也不计入用量（completion 口径只算正文）。编排器接成 SSE reasoning 事件（ephemeral，不重放）。
   */
  onReasoning?: (text: string) => void;
  /**
   * 工具参数流分片：真实模型写文件的全文走 tool_calls.arguments 增量（正文 content 在
   * 工具轮基本为空）。内核原样透传 provider 的 onToolCallDelta，不缓冲不裁剪、不计用量；
   * 消费方（编排器 write-file-stream）增量解出 write_file 的 content 字段接成文件打字机。
   */
  onToolCallDelta?: (delta: ToolCallStreamDelta) => void;
}

/** 一次 agent 运行的入参：角色四要素（prompt/工具/模型/上下文）+ 防失控与回调 */
export interface RunOptions {
  role: AgentRole;
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  model: string;
  /** 最大 provider 调用次数（每次记 1 步），超出抛 AgentStepLimitError；缺省 DEFAULT_MAX_STEPS=12 */
  maxSteps?: number;
  /** 工具执行上下文（闭包绑定 project_id，内核原样透传给 tool.execute） */
  ctx: ToolContext;
  /** 缺省时用 getLlmProvider()（读 env，晚绑定） */
  provider?: LlmProvider;
  callbacks?: RunnerCallbacks;
  /** 停止信号：每轮 provider 调用前与每次工具执行前检查 */
  signal?: AbortSignal;
}

/** 运行结果：最终 content + 实际步数 + 模型发起的全部工具调用（含校验失败/未知工具那些） */
export interface RunResult {
  content: string;
  steps: number;
  toolCalls: { name: string; args: unknown }[];
}

/** 校验重试一次后仍失败（DESIGN §3.4 三段式第 2 步耗尽） */
export class AgentValidationError extends Error {
  /** 出错工具名（未知工具时即模型调用的名字） */
  readonly toolName: string;
  /** 校验失败详情（可直接进日志/SSE error） */
  readonly detail: string;

  constructor(toolName: string, detail: string) {
    super(`工具调用在回喂错误后重试仍失败，已终止：工具 ${toolName} — ${detail}`);
    this.name = 'AgentValidationError';
    this.toolName = toolName;
    this.detail = detail;
  }
}

/** 运行被中止（signal 触发）；name 固定 'AbortError' 以兼容 DOM 中止语义 */
export class AgentAbortError extends Error {
  constructor(message = 'agent 执行已被中止') {
    super(message);
    this.name = 'AbortError';
  }
}

/** 步数超限（DESIGN §4.6 防失控终止）：结构化错误，调用方按类型分流而不是字符串匹配 message */
export class AgentStepLimitError extends Error {
  /** 配置的上限 */
  readonly maxSteps: number;
  /** 实际已执行的步数（= provider 调用次数） */
  readonly steps: number;

  constructor(maxSteps: number, steps: number) {
    super(`已达最大步数上限（maxSteps=${maxSteps}，实际执行 ${steps} 步仍未完成），已终止以防失控`);
    this.name = 'AgentStepLimitError';
    this.maxSteps = maxSteps;
    this.steps = steps;
  }
}
