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
import type { LlmProvider } from '@/lib/llm/types';

/** 内核回调：编排器用来落库/发 SSE 与转发打字机流 */
export interface RunnerCallbacks {
  /**
   * 每个模型发起的工具调用产生回喂文本后触发（含校验失败/未知工具——此时 output 即回喂给模型的错误说明），
   * 供时间线展示与 agent_runs 落库；args 为模型原始入参（未收窄，可能是非法形状）
   */
  onToolCall?: (call: { name: string; args: unknown; output: string }) => void;
  /** 流式增量：原样透传 provider.stream 的 onDelta，内核不缓冲不裁剪（落库时机=file_end，见 DESIGN §3.6） */
  onDelta?: (text: string) => void;
}

/** 一次 agent 运行的入参：角色四要素（prompt/工具/模型/上下文）+ 防失控与回调 */
export interface RunOptions {
  role: AgentRole;
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  model: string;
  /** 最大 provider 调用次数（每次记 1 步），超出抛普通 Error；缺省 DEFAULT_MAX_STEPS=12 */
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
