/**
 * fallback 链测试（Task 27 / DESIGN §5①「withFallback 降级链」增强）：
 * - classifyLlmError：六类错误分类（含 status → auth/rate_limited 映射）
 * - withFallback：主成功不降级 / timeout、auth 换 provider / 全败抛最后一次 / aborted 永不降级 / 链空语义
 * - 内存健康度：fail≥3 的 provider 排后、成功清零（仅重排链内顺序）
 * 全部用内存桩 provider，不发真实请求。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PROVIDER_FAIL_THRESHOLD,
  classifyLlmError,
  getProviderHealth,
  resetProviderHealth,
  withFallback,
} from '@/lib/llm/fallback';
import { LlmError } from '@/lib/llm/client';
import type { LlmProvider, LlmRequest, LlmResult } from '@/lib/llm/types';

/* ------------------------------------------------------------------ */
/* 夹具与工具                                                           */
/* ------------------------------------------------------------------ */

/** 脚本步骤：成功（返回 content）或失败（抛 error） */
type Step = { ok: true; content: string } | { ok: false; error: unknown };

/** 取脚本下一步（耗尽后重复最后一步），空脚本显式失败 */
function nextStep(steps: Step[]): Step {
  const step = steps.shift() ?? steps[steps.length - 1];
  if (step === undefined) throw new Error('脚本为空：至少需要一个步骤');
  return step;
}

/** 脚本化 provider：按队列依次产出，记录收到的请求 */
function scriptedProvider(name: string, steps: Step[]): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const respond = async (req: LlmRequest, onDelta?: (text: string) => void): Promise<LlmResult> => {
    requests.push(req);
    const step = nextStep(steps);
    if (!step.ok) throw step.error;
    if (onDelta !== undefined) onDelta(step.content);
    return { content: step.content, toolCalls: [], usage: null };
  };
  return {
    name,
    requests,
    async complete(req: LlmRequest): Promise<LlmResult> {
      return respond(req);
    },
    async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      return respond(req, onDelta);
    },
  };
}

const ok = (content: string): Step => ({ ok: true, content });
const fail = (error: unknown): Step => ({ ok: false, error });

/** 组装 onFallback 回调收集器 */
function createFallbackLog(): { log: Array<{ from: string; to: string; code: string }>; onFallback: (from: string, to: string, code: 'aborted'|'auth'|'rate_limited'|'timeout'|'network'|'bad_response'|'unknown') => void } {
  const log: Array<{ from: string; to: string; code: string }> = [];
  return { log, onFallback: (from, to, code) => log.push({ from, to, code }) };
}

/** 构造 LlmRequest（默认工程师场景） */
function makeReq(): LlmRequest {
  return {
    model: 'mock-model',
    messages: [
      { role: 'system', content: '你是工程师（engineer），负责产出代码文件' },
      { role: 'user', content: '做一个待办事项应用' },
    ],
  };
}

/** unknown 收窄为 Error（断言错误对象同一性用） */
function asError(error: unknown): Error {
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

/** 统一捕获：unknown → Error */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('预期抛错，但正常返回了');
}

beforeEach(() => {
  resetProviderHealth(); // 健康度是模块级内存态，测试间必须隔离
});

/* ------------------------------------------------------------------ */
/* classifyLlmError                                                     */
/* ------------------------------------------------------------------ */
describe('classifyLlmError 错误分类', () => {
  it('① aborted：LlmError(code=aborted) 与裸 AbortError 都归 aborted', () => {
    expect(classifyLlmError(new LlmError('aborted', '已中止'))).toBe('aborted');
    const abort = new Error('This operation was aborted');
    abort.name = 'AbortError';
    expect(classifyLlmError(abort)).toBe('aborted');
  });

  it('② timeout：LlmError(code=timeout) 与裸 TimeoutError 都归 timeout', () => {
    expect(classifyLlmError(new LlmError('timeout', '调用超时'))).toBe('timeout');
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    expect(classifyLlmError(timeout)).toBe('timeout');
  });

  it('③ network：network_error 归 network', () => {
    expect(classifyLlmError(new LlmError('network_error', '请求失败'))).toBe('network');
  });

  it('④ auth：http_error 且 status 401/403 归 auth', () => {
    expect(classifyLlmError(new LlmError('http_error', 'HTTP 401', 401))).toBe('auth');
    expect(classifyLlmError(new LlmError('http_error', 'HTTP 403', 403))).toBe('auth');
  });

  it('⑤ rate_limited：http_error 且 status 429 归 rate_limited（LlmErrorCode 无该码，按 status 判）', () => {
    expect(classifyLlmError(new LlmError('http_error', 'HTTP 429', 429))).toBe('rate_limited');
  });

  it('⑥ bad_response：bad_response 与其余 http_error（5xx 等）归 bad_response', () => {
    expect(classifyLlmError(new LlmError('bad_response', '响应结构无法解析'))).toBe('bad_response');
    expect(classifyLlmError(new LlmError('http_error', 'HTTP 500', 500))).toBe('bad_response');
  });

  it('⑦ unknown：非 LLM 层错误 / 配置缺失 / null 归 unknown（不在链内盲目降级）', () => {
    expect(classifyLlmError(new Error('业务代码炸了'))).toBe('unknown');
    expect(classifyLlmError(new LlmError('config_missing', '缺少 LLM_BASE_URL'))).toBe('unknown');
    expect(classifyLlmError(null)).toBe('unknown');
    expect(classifyLlmError('boom')).toBe('unknown');
  });
});

/* ------------------------------------------------------------------ */
/* withFallback                                                         */
/* ------------------------------------------------------------------ */
describe('withFallback 降级链', () => {
  it('① 首个 provider 成功 → 不降级、onFallback 不触发', async () => {
    const a = scriptedProvider('a', [ok('A1')]);
    const b = scriptedProvider('b', [ok('B1')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    const result = await provider.complete(makeReq());

    expect(result.content).toBe('A1');
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(0);
    expect(log).toHaveLength(0);
  });

  it('② 主 timeout → 备成功，onFallback(from,to,timeout) 回调', async () => {
    const a = scriptedProvider('a', [fail(new LlmError('timeout', '调用超时'))]);
    const b = scriptedProvider('b', [ok('B1')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    const result = await provider.complete(makeReq());

    expect(result.content).toBe('B1');
    expect(log).toEqual([{ from: 'a', to: 'b', code: 'timeout' }]);
  });

  it('③ 主 auth（401）→ 换 provider 正当，同样降级', async () => {
    const a = scriptedProvider('a', [fail(new LlmError('http_error', 'HTTP 401', 401))]);
    const b = scriptedProvider('b', [ok('B1')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    const result = await provider.complete(makeReq());

    expect(result.content).toBe('B1');
    expect(log).toEqual([{ from: 'a', to: 'b', code: 'auth' }]);
  });

  it('④ 全败 → 抛最后一次的错误（同一对象），逐级回调', async () => {
    const last = new LlmError('network_error', 'b 网络失败');
    const a = scriptedProvider('a', [fail(new LlmError('timeout', 'a 超时'))]);
    const b = scriptedProvider('b', [fail(last)]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    const error = asError(await catchError(provider.complete(makeReq())));

    expect(error).toBe(last); // 原样上抛，不包装
    expect(log).toEqual([{ from: 'a', to: 'b', code: 'timeout' }]);
  });

  it('⑤ aborted 永不降级：原样抛出且后续 provider 不被调用', async () => {
    const abort = new LlmError('aborted', '用户已停止');
    const a = scriptedProvider('a', [fail(abort)]);
    const b = scriptedProvider('b', [ok('B1')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    const error = asError(await catchError(provider.complete(makeReq())));

    expect(error).toBe(abort);
    expect(b.requests).toHaveLength(0);
    expect(log).toHaveLength(0);
  });

  it('⑥ 链空 → 明确语义：complete/stream 都以结构化错误（config_missing）失败', async () => {
    const provider = withFallback([]);

    const completeError = await catchError(provider.complete(makeReq()));
    expect(completeError).toBeInstanceOf(LlmError);
    expect((completeError as LlmError).code).toBe('config_missing');

    const streamError = await catchError(provider.stream(makeReq(), () => {}));
    expect((streamError as LlmError).code).toBe('config_missing');
  });

  it('⑥ 补：单元素链等价于原样调用——成功透传、失败原样抛', async () => {
    const boom = new LlmError('bad_response', '响应坏了');
    const failing = scriptedProvider('only', [fail(boom)]);
    const succeed = scriptedProvider('only', [ok('ONLY')]);
    const failingChain = withFallback([() => failing]);
    const okChain = withFallback([() => succeed]);

    await expect(catchError(failingChain.complete(makeReq()))).resolves.toBe(boom);
    await expect(okChain.complete(makeReq())).resolves.toMatchObject({ content: 'ONLY' });
  });

  it('⑦ 工厂抛错（构造失败）→ 视为该候选失败并继续降级', async () => {
    const b = scriptedProvider('b', [ok('B1')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback(
      [
        () => {
          throw new LlmError('config_missing', '缺少 LLM_BASE_URL');
        },
        () => b,
      ],
      { onFallback },
    );

    const result = await provider.complete(makeReq());

    expect(result.content).toBe('B1');
    expect(log).toHaveLength(1);
    expect(log[0]?.to).toBe('b');
  });

  it('⑧ stream 与 complete 同一套降级语义（增量透传给成功者）', async () => {
    const a = scriptedProvider('a', [fail(new LlmError('timeout', 'a 超时'))]);
    const b = scriptedProvider('b', [ok('B-流式')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    const deltas: string[] = [];
    const result = await provider.stream(makeReq(), (text) => deltas.push(text));

    expect(deltas).toEqual(['B-流式']);
    expect(result.content).toBe('B-流式');
    expect(log).toEqual([{ from: 'a', to: 'b', code: 'timeout' }]);
  });
});

/* ------------------------------------------------------------------ */
/* 内存健康度                                                            */
/* ------------------------------------------------------------------ */
describe('withFallback 内存健康度（fail≥3 排后、成功清零）', () => {
  it('① 同一 provider 连续失败 ≥ 阈值 → 后续调用被排到链尾（不再触发降级回调）', async () => {
    expect(PROVIDER_FAIL_THRESHOLD).toBe(3);
    const a = scriptedProvider('flaky', [fail(new LlmError('timeout', '超时')), fail(new LlmError('timeout', '超时')), fail(new LlmError('timeout', '超时'))]);
    const b = scriptedProvider('stable', [ok('B1'), ok('B2'), ok('B3'), ok('B4')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    await provider.complete(makeReq());
    await provider.complete(makeReq());
    await provider.complete(makeReq());
    expect(log).toHaveLength(3); // 前三次都从 flaky 开始（原序），逐次降级
    expect(getProviderHealth('flaky')?.failCount).toBe(PROVIDER_FAIL_THRESHOLD);

    const fourth = await provider.complete(makeReq());
    expect(fourth.content).toBe('B4');
    expect(log).toHaveLength(3); // flaky 已被排后：stable 先试且成功，无新降级
  });

  it('② 失败者成功一次 → failCount 清零，恢复原链序', async () => {
    const a = scriptedProvider('flaky', [
      fail(new LlmError('timeout', '超时')),
      fail(new LlmError('timeout', '超时')),
      fail(new LlmError('timeout', '超时')),
      ok('A-恢复'),
      ok('A-再次首发'),
    ]);
    const b = scriptedProvider('stable', [ok('B1'), ok('B2'), ok('B3'), fail(new LlmError('timeout', 'stable 也超时')), ok('B5')]);
    const { log, onFallback } = createFallbackLog();
    const provider = withFallback([() => a, () => b], { onFallback });

    // 三次：flaky 连败 → 健康度计数到阈值
    await provider.complete(makeReq());
    await provider.complete(makeReq());
    await provider.complete(makeReq());
    expect(log).toHaveLength(3);

    // 第 4 次：链序 [stable, flaky]；stable 失败 → 降级到 flaky，flaky 成功 → failCount 清零
    expect(getProviderHealth('flaky')?.failCount).toBe(PROVIDER_FAIL_THRESHOLD);
    const fourth = await provider.complete(makeReq());
    expect(fourth.content).toBe('A-恢复');
    expect(log[3]).toMatchObject({ from: 'stable', to: 'flaky', code: 'timeout' });
    expect(getProviderHealth('flaky')?.failCount).toBe(0);

    // 第 5 次：flaky 已恢复 → 回到链首并成功，无降级
    const fifth = await provider.complete(makeReq());
    expect(fifth.content).toBe('A-再次首发');
    expect(log).toHaveLength(4);
  });

  it('③ 记录 lastLatencyMs（墙钟），健康度可观测', async () => {
    const a = scriptedProvider('a', [fail(new LlmError('timeout', '超时'))]);
    const b = scriptedProvider('b', [ok('B1')]);
    const provider = withFallback([() => a, () => b]);

    await provider.complete(makeReq());

    expect(getProviderHealth('a')?.failCount).toBe(1);
    expect(getProviderHealth('a')?.lastLatencyMs).toBeGreaterThanOrEqual(0);
    expect(getProviderHealth('b')?.failCount).toBe(0);
  });

  it('④ aborted 不计入健康度（用户停止≠服务商不健康）', async () => {
    const a = scriptedProvider('a', [fail(new LlmError('aborted', '用户已停止')), ok('A2')]);
    const provider = withFallback([() => a]);

    await expect(catchError(provider.complete(makeReq()))).resolves.toBeInstanceOf(LlmError);
    await provider.complete(makeReq());

    expect(getProviderHealth('a')).toMatchObject({ failCount: 0 });
  });
});
