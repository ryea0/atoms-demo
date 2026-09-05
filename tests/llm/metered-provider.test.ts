/**
 * 计量装饰器（wrapMetered）测试：provider 级计量必须与 meteredCall 同一语义——
 * 成功调用后落一条 llm_calls（usage 缺失走估算 estimated=1）、
 * 中止/超时原样上抛且落一条估算记录（T29）、其他错误原样上抛且不落库、
 * 缺省 provider 走 getLlmProvider()（mock）。全部用内存桩，不触真实存储。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wrapMetered } from '@/lib/llm/metered-provider';
import { DEFAULT_MODEL, LlmError } from '@/lib/llm/client';
import { readSample } from '@/lib/llm/mock';
import type { MeteringSink } from '@/lib/llm/usage';
import type { LlmProvider, LlmRequest, LlmResult } from '@/lib/llm/types';

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

/** 计量假仓库：捕获 recordLlmCall 入参（与 client.test.ts 的桩同构，不依赖真实存储） */
interface RecordedCall {
  projectId: number;
  agentRole: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  estimated: number;
  cost: number;
  latencyMs: number;
}
function createFakeSink(): { sink: MeteringSink; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    sink: {
      async recordLlmCall(input: Parameters<MeteringSink['recordLlmCall']>[0]): Promise<void> {
        calls.push({ ...input });
      },
    },
  };
}

/** 取第一条计量记录（空数组显式失败，规避 noUncheckedIndexedAccess 下的可空索引访问） */
function firstCall(calls: RecordedCall[]): RecordedCall {
  const call = calls[0];
  if (call === undefined) throw new Error('预期至少一条计量记录，实际为空');
  return call;
}

/** 桩 provider 可配置项：返回结果 / 抛出的错误 */
interface StubOptions {
  result?: LlmResult;
  error?: unknown;
}

/** 可编程桩 provider：记录收到的请求、可注错误、可选透传增量 */
function createStubProvider(opts: StubOptions = {}): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const respond = async (req: LlmRequest, onDelta?: (text: string) => void): Promise<LlmResult> => {
    requests.push(req);
    if (opts.error !== undefined) throw opts.error;
    const base: LlmResult = { content: '桩内容', toolCalls: [], usage: null };
    const result = { ...base, ...opts.result };
    if (onDelta !== undefined) onDelta(result.content);
    return result;
  };
  return {
    name: 'stub',
    requests,
    async complete(req: LlmRequest): Promise<LlmResult> {
      return respond(req);
    },
    async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      return respond(req, onDelta);
    },
  };
}

/** 构造 LlmRequest（默认模型 mock-model） */
function makeReq(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: 'mock-model',
    messages: [
      { role: 'system', content: '你是工程师（engineer），负责产出代码文件' },
      { role: 'user', content: '做一个待办事项应用' },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  // 离线快速：mock 流式延迟置 0（DESIGN §5⑥ 延迟可配）
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* wrapMetered                                                          */
/* ------------------------------------------------------------------ */
describe('wrapMetered 计量装饰器', () => {
  it('① complete 委托内层恰好一次，按真实 usage 落库（estimated=0、cost=0）', async () => {
    const { sink, calls } = createFakeSink();
    const stub = createStubProvider({
      result: { content: '产出', toolCalls: [], usage: { promptTokens: 11, completionTokens: 7 } },
    });
    const metered = wrapMetered({ storage: sink, projectId: 42, agentRole: 'engineer', model: 'qwen-max', provider: stub });

    const result = await metered.complete(makeReq());

    expect(result).toEqual({ content: '产出', toolCalls: [], usage: { promptTokens: 11, completionTokens: 7 } });
    expect(stub.requests).toHaveLength(1); // 委托恰好一次
    expect(calls).toHaveLength(1); // 只落一条
    expect(firstCall(calls)).toMatchObject({
      projectId: 42,
      agentRole: 'engineer',
      model: 'qwen-max',
      promptTokens: 11,
      completionTokens: 7,
      estimated: 0,
      cost: 0,
    });
    expect(firstCall(calls).latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('① 补：请求 model 被归一到绑定 model，且不改写调用方原对象', async () => {
    const { sink } = createFakeSink();
    const stub = createStubProvider();
    const metered = wrapMetered({ storage: sink, projectId: 1, agentRole: 'pm', model: 'bound-model', provider: stub });
    const req = makeReq({ model: 'caller-model' });

    await metered.complete(req);

    expect(stub.requests[0]?.model).toBe('bound-model'); // 记账模型 = 实际请求模型
    expect(req.model).toBe('caller-model'); // 浅拷贝，不改调用方对象
  });

  it('② stream 委托并透传 onDelta，usage 缺失 → 估算落库（estimated=1）', async () => {
    const { sink, calls } = createFakeSink();
    const stub = createStubProvider({ result: { content: '一二三四五', toolCalls: [], usage: null } });
    const metered = wrapMetered({ storage: sink, projectId: 7, agentRole: 'pm', model: 'm2', provider: stub });

    const deltas: string[] = [];
    const result = await metered.stream(makeReq(), (t: string) => deltas.push(t));

    expect(deltas).toEqual(['一二三四五']); // onDelta 原样透传
    expect(result.content).toBe('一二三四五');
    expect(calls).toHaveLength(1);
    const call = firstCall(calls);
    expect(call.model).toBe('m2');
    expect(call.estimated).toBe(1);
    expect(call.promptTokens).toBeGreaterThan(0);
    expect(call.completionTokens).toBeGreaterThan(0);
    expect(call.cost).toBe(0);
  });

  it('③ provider 抛错 → 原样上抛（同一错误对象）且不落库', async () => {
    const { sink, calls } = createFakeSink();
    const boom = new Error('上游 500');
    const metered = wrapMetered({
      storage: sink,
      projectId: 1,
      agentRole: 'seo',
      model: 'm3',
      provider: createStubProvider({ error: boom }),
    });

    await expect(metered.complete(makeReq())).rejects.toBe(boom);
    await expect(metered.stream(makeReq(), () => {})).rejects.toBe(boom);
    expect(calls).toHaveLength(0); // 失败不计量
  });

  it('③ 补：中止/超时（LlmError aborted/timeout）→ 原样上抛且落一条估算记录（T29 中止计量）', async () => {
    const { sink, calls } = createFakeSink();
    const abort = new LlmError('aborted', 'LLM 调用已中止（abort）');
    const timeout = new LlmError('timeout', 'LLM 流式超时（idle 空闲 45000ms 无数据）');
    const abortMetered = wrapMetered({
      storage: sink,
      projectId: 2,
      agentRole: 'architect',
      model: 'm4',
      provider: createStubProvider({ error: abort }),
    });
    const timeoutMetered = wrapMetered({
      storage: sink,
      projectId: 2,
      agentRole: 'architect',
      model: 'm4',
      provider: createStubProvider({ error: timeout }),
    });

    await expect(abortMetered.stream(makeReq(), () => {})).rejects.toBe(abort);
    await expect(timeoutMetered.complete(makeReq())).rejects.toBe(timeout);
    expect(calls).toHaveLength(2); // 中止/超时也计量（估算），不再零记录
    expect(calls[0]).toMatchObject({ projectId: 2, agentRole: 'architect', model: 'm4', estimated: 1 });
    expect(calls[1]).toMatchObject({ projectId: 2, agentRole: 'architect', model: 'm4', estimated: 1 });
  });

  it('多次调用 → 逐次落库（runAgent 循环 N 次 provider 调用 = N 条 llm_calls）', async () => {
    const { sink, calls } = createFakeSink();
    const metered = wrapMetered({
      storage: sink,
      projectId: 5,
      agentRole: 'engineer',
      model: 'm5',
      provider: createStubProvider({ result: { content: 'ok', toolCalls: [], usage: { promptTokens: 1, completionTokens: 1 } } }),
    });

    await metered.complete(makeReq());
    await metered.stream(makeReq(), () => {});
    await metered.complete(makeReq());

    expect(calls).toHaveLength(3);
    expect(calls.map((c) => c.projectId)).toEqual([5, 5, 5]);
  });

  it('④ 缺省 provider → getLlmProvider()（mock），并保留内层 name', async () => {
    vi.stubEnv('LLM_PROVIDER', 'mock'); // 显式钉住默认分支，不受外部 env 影响
    const { sink, calls } = createFakeSink();
    const metered = wrapMetered({ storage: sink, projectId: 9, agentRole: 'pm', model: DEFAULT_MODEL });

    expect(metered.name).toBe('mock');
    const result = await metered.complete(
      makeReq({
        model: DEFAULT_MODEL,
        messages: [
          { role: 'system', content: '你是产品经理（PM），负责撰写 PRD' },
          { role: 'user', content: '做一个待办事项应用' },
        ],
      }),
    );

    expect(result.content).toBe(readSample('prd.md')); // 确实走的是 mock
    expect(calls).toHaveLength(1);
    expect(firstCall(calls)).toMatchObject({
      projectId: 9,
      agentRole: 'pm',
      model: DEFAULT_MODEL,
      estimated: 0, // mock 自带可信 usage
      cost: 0,
    });
  });

  it('落库失败 → console.error 留痕，但不影响调用结果（不静默吞）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken: MeteringSink = {
        async recordLlmCall(): Promise<void> {
          throw new Error('db down');
        },
      };
      const metered = wrapMetered({
        storage: broken,
        projectId: 3,
        agentRole: 'ads',
        model: 'm6',
        provider: createStubProvider({ result: { content: '产出', toolCalls: [], usage: null } }),
      });
      const result = await metered.complete(makeReq());
      expect(result.content).toBe('产出');
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
