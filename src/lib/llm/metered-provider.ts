/**
 * 计量装饰器（CLAUDE.md 规则 10 / DESIGN §12）：把任意 LlmProvider 包成「每次调用成功后落 llm_calls」的 provider。
 *
 * 为什么需要 provider 级装饰器：runAgent({provider}) 在内核里循环调用 provider.stream（一次 agent 运行
 * = N 次 provider 调用），单发入口 meteredCall 包不住整段循环。编排器把本装饰器作为 provider 注入
 * runAgent，内核零改动即获得逐次计量（N 次调用 = N 条 llm_calls）。
 *
 * 语义与 usage.ts meteredCall 完全一致（内部复用 meteredCallWith，不重复估算/落库逻辑）：
 * - usage 缺失 → estimateTokens 字符公式估算并标 estimated=1；真实 usage → estimated=0；cost 恒 0
 * - provider 抛错（含 AbortError）原样上抛且不落库（失败/中止时用量不可知，与 meteredCall 一致）
 * - 落库失败只 console.error 留痕，不影响调用结果（不静默吞）
 *
 * model 绑定语义：每次请求的 model 统一改写为绑定的 model（浅拷贝，不改调用方原对象），
 * 保证「实际发给模型的 model」与「llm_calls 记账的 model」永远一致；
 * 绑定值为空串/空白时按 meteredCall 同一规则回退 resolveModel(agentRole)。
 *
 * 服务端专用，不得进入客户端 bundle。
 */
import { getLlmProvider } from '@/lib/llm/client';
import { meteredCallWith, type MeteringSink } from '@/lib/llm/usage';
import type { AgentRole } from '@/lib/db/provider/types';
import type { LlmProvider, LlmRequest, LlmResult } from '@/lib/llm/types';

/** wrapMetered 入参：四要素（存储出口/项目/角色/模型）绑定到返回的 provider 上 */
export interface MeteredProviderInput {
  /** 计量落库出口（真实存储按结构满足 MeteringSink，LLM 层不感知 db dialect） */
  storage: MeteringSink;
  /** 归属项目（llm_calls.project_id） */
  projectId: number;
  /** 归属角色（llm_calls.agent_role） */
  agentRole: AgentRole;
  /** 计量归属模型，同时作为每次请求实际使用的 model */
  model: string;
  /** 缺省 getLlmProvider()（读 env，LLM_PROVIDER 默认 mock） */
  provider?: LlmProvider;
}

/** 包装任意 provider：每次 complete/stream 调用成功后计量落库（recordLlmCall），错误原样上抛 */
export function wrapMetered(input: MeteredProviderInput): LlmProvider {
  const inner = input.provider ?? getLlmProvider();

  /** 统一计量入口：传 onDelta 走 stream、不传走 complete（与 meteredCall 的分流规则一致） */
  const metered = (req: LlmRequest, onDelta?: (text: string) => void): Promise<LlmResult> =>
    meteredCallWith(inner, input.storage, input.projectId, input.agentRole, { ...req, model: input.model }, onDelta);

  return {
    // 装饰器对调用方透明：name 沿用内层 provider（内核/日志不感知被包过）
    name: inner.name,
    async complete(req: LlmRequest): Promise<LlmResult> {
      return metered(req);
    },
    async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      return metered(req, onDelta);
    },
  };
}
