/**
 * AgentRunner 内核测试（Task 8）：工具循环 + 参数校验重试（DESIGN §3.4）+ 防失控（§4.6）。
 * brief 原文用例 ①-④ 在前，补充用例 ⑤ 未知工具 / ⑥ 预中止 / ⑦ 真实 fsTools 小集成 / 步数语义在后。
 * provider 一律用注入的 FakeProvider（脚本化响应，脚本耗尽即抛错）；落库验证用 newTestStorage（内存库）。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_STEPS, runAgent } from '@/lib/agents/runner';
import { AgentAbortError, AgentValidationError, type RunOptions } from '@/lib/agents/types';
import { fsTools, type ToolContext } from '@/lib/agents/tools';
import { newTestStorage } from '@/lib/db/test-util';
import type { AgentRole, StorageProvider } from '@/lib/db/provider/types';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResult, ToolCall } from '@/lib/llm/types';

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

/** 脚本化一步：deltas 逐个回调（模拟流式），content/toolCalls 为该步最终结果 */
interface ScriptedStep {
  content?: string;
  toolCalls?: ToolCall[];
  deltas?: string[];
}

/** 脚本耗尽时抛出的哨兵错误（让"多跑了一步"的测试显式失败，而不是静默通过） */
class ScriptExhaustedError extends Error {
  constructor() {
    super('FakeProvider 脚本已耗尽（provider 被多调用了一次）');
    this.name = 'ScriptExhaustedError';
  }
}

/** 测试桩 provider：按脚本依次返回，并记录每次收到的请求 */
class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: LlmRequest[] = [];
  /** 钩子：每次 stream 被调用时触发（用于在步间注入 abort） */
  onStream?: (req: LlmRequest) => void;
  private readonly script: ScriptedStep[];
  private cursor = 0;

  constructor(...steps: ScriptedStep[]) {
    this.script = steps;
  }

  async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
    // 快照 messages：runner 持有的是同一个可变数组，不拷贝的话历史记录会"事后变脸"
    this.requests.push({ ...req, messages: req.messages.map((message) => ({ ...message })) });
    this.onStream?.(req);
    const step = this.script[this.cursor];
    this.cursor += 1;
    if (step === undefined) throw new ScriptExhaustedError();
    for (const text of step.deltas ?? []) onDelta(text);
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: null };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.stream(req, () => undefined);
  }
}

/** 独立内存库 + 空项目，ctx.role 默认 engineer */
async function newCtx(role: AgentRole = 'engineer'): Promise<{
  storage: StorageProvider;
  projectId: number;
  ctx: ToolContext;
}> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'fast' });
  return { storage, projectId: project.id, ctx: { storage, projectId: project.id, role } };
}

/** 组装 RunOptions（可按用例覆盖） */
function makeOpts(ctx: ToolContext, provider: LlmProvider, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    role: 'engineer',
    systemPrompt: '你是工程师。',
    userPrompt: '完成目标文件。',
    tools: fsTools,
    model: 'fake-model',
    ctx,
    provider,
    ...overrides,
  };
}

/** 取第 n 次请求（缺失即显式失败，规避 noUncheckedIndexedAccess 的可空索引访问） */
function requestAt(provider: FakeProvider, index: number): LlmRequest {
  const req = provider.requests[index];
  if (req === undefined) throw new Error(`预期 provider 至少被调用 ${index + 1} 次，实际 ${provider.requests.length}`);
  return req;
}

/** 消息历史里的 tool 回喂消息 */
function toolMessages(messages: LlmMessage[]): LlmMessage[] {
  return messages.filter((message) => message.role === 'tool');
}

/** 统一捕获：unknown → Error（断言用） */
async function catchError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('预期 runAgent 抛错，但正常返回了');
}

/* ------------------------------------------------------------------ */
/* brief 原文用例 ①-④                                                  */
/* ------------------------------------------------------------------ */

describe('runAgent：校验重试与终止', () => {
  it('① 坏参数回喂一次后重试成功：toolCalls 两条、content 正确、文件落库', async () => {
    const { storage, projectId, ctx } = await newCtx();
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'docs/prd.md' } }] },
      { toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'docs/prd.md', content: '# PRD' } }] },
      { content: 'PRD 已写入 docs/prd.md' },
    );
    const seen: { name: string; output: string }[] = [];
    const result = await runAgent(
      makeOpts(ctx, provider, { callbacks: { onToolCall: (call) => seen.push({ name: call.name, output: call.output }) } }),
    );

    expect(result.content).toBe('PRD 已写入 docs/prd.md');
    expect(result.steps).toBe(3);
    expect(result.toolCalls).toEqual([
      { name: 'write_file', args: { path: 'docs/prd.md' } },
      { name: 'write_file', args: { path: 'docs/prd.md', content: '# PRD' } },
    ]);

    // 首次请求带上全部工具声明；第二次请求含校验错误的 tool 回喂（toolCallId 对得上）
    expect(requestAt(provider, 0).tools?.map((tool) => tool.name)).toEqual(['write_file', 'read_file', 'list_files', 'grep']);
    const fedBack = toolMessages(requestAt(provider, 1).messages);
    expect(fedBack).toHaveLength(1);
    expect(fedBack[0]?.toolCallId).toBe('c1');
    expect(fedBack[0]?.content).toContain('参数校验失败');
    expect(fedBack[0]?.content).toContain('content');

    // onToolCall 每次调用都回调（含校验失败那次），成功那次的 output 为执行结果
    expect(seen).toHaveLength(2);
    expect(seen[1]?.output).toBe('已写入 docs/prd.md v1');

    const row = await storage.getFile(projectId, 'docs/prd.md');
    expect(row?.content).toBe('# PRD');
  });

  it('② 连续两轮坏参数 → 抛 AgentValidationError（含工具名与校验详情），不再发第三次请求', async () => {
    const { ctx } = await newCtx();
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'write_file', args: { path: 'a.md' } }] },
      { toolCalls: [{ id: 'c2', name: 'write_file', args: {} }] },
    );
    const error = await catchError(runAgent(makeOpts(ctx, provider)));

    expect(error).toBeInstanceOf(AgentValidationError);
    if (error instanceof AgentValidationError) {
      expect(error.toolName).toBe('write_file');
      expect(error.message).toContain('write_file');
      expect(error.message).toContain('content');
    }
    expect(provider.requests).toHaveLength(2);
  });

  it('③ maxSteps=1 且持续返回工具调用 → 超限抛错（中文提示含步数），第 2 次调用前终止', async () => {
    const { ctx } = await newCtx();
    const provider = new FakeProvider({ toolCalls: [{ id: 'c1', name: 'list_files', args: {} }] });
    const error = await catchError(runAgent(makeOpts(ctx, provider, { maxSteps: 1 })));

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AgentValidationError);
    expect((error as Error).message).toContain('最大步数');
    expect((error as Error).message).toContain('maxSteps=1');
    expect(provider.requests).toHaveLength(1);
  });

  it('④ onDelta 收到流式增量（无工具时一步收敛，不发 tools 字段）', async () => {
    const { ctx } = await newCtx();
    const provider = new FakeProvider({ content: '你好，世界', deltas: ['你好', '，', '世界'] });
    const deltas: string[] = [];
    const result = await runAgent(
      makeOpts(ctx, provider, { tools: [], callbacks: { onDelta: (text) => deltas.push(text) } }),
    );

    expect(deltas.join('')).toBe('你好，世界');
    expect(result.steps).toBe(1);
    expect(result.toolCalls).toEqual([]);
    expect(requestAt(provider, 0).tools).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 补充用例 ⑤-⑦                                                        */
/* ------------------------------------------------------------------ */

describe('runAgent：未知工具与中止', () => {
  it('⑤ 首回未知工具按校验失败回喂，重试后成功；未知工具不被执行', async () => {
    const { storage, projectId, ctx } = await newCtx();
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'rm -rf /' } }] },
      { toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'app/main.js', content: 'export const a = 1;' } }] },
      { content: '改用 write_file 完成' },
    );
    const result = await runAgent(makeOpts(ctx, provider));

    expect(result.steps).toBe(3);
    const fedBack = toolMessages(requestAt(provider, 1).messages);
    expect(fedBack[0]?.toolCallId).toBe('c1');
    expect(fedBack[0]?.content).toContain('未知工具：bash');
    expect((await storage.listFiles(projectId)).map((file) => file.path)).toEqual(['app/main.js']);
  });

  it('⑤ 连续两轮未知工具同样抛 AgentValidationError', async () => {
    const { ctx } = await newCtx();
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'bash', args: {} }] },
      { toolCalls: [{ id: 'c2', name: 'exec', args: {} }] },
    );
    await expect(runAgent(makeOpts(ctx, provider))).rejects.toBeInstanceOf(AgentValidationError);
  });

  it('⑥ signal 预中止 → 抛 name=AbortError，且不发起任何 provider 调用', async () => {
    const { ctx } = await newCtx();
    const provider = new FakeProvider({ content: '不应到达' });
    const controller = new AbortController();
    controller.abort();

    const error = await catchError(runAgent(makeOpts(ctx, provider, { signal: controller.signal })));

    expect(error).toBeInstanceOf(AgentAbortError);
    expect((error as Error).name).toBe('AbortError');
    expect(provider.requests).toHaveLength(0);
  });

  it('⑥ 步间中止：provider 调用中触发 abort → 工具执行前抛 AbortError', async () => {
    const { ctx } = await newCtx();
    const controller = new AbortController();
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'list_files', args: {} }] },
      { content: '不应到达' },
    );
    provider.onStream = () => controller.abort();

    const error = await catchError(runAgent(makeOpts(ctx, provider, { signal: controller.signal })));

    expect(error).toBeInstanceOf(AgentAbortError);
    expect((error as Error).name).toBe('AbortError');
    expect(provider.requests).toHaveLength(1);
  });
});

describe('runAgent：真实 fsTools 集成', () => {
  it('⑦ 读不存在文件（执行失败，非校验失败）→ 回喂后 write_file 成功落库', async () => {
    const { storage, projectId, ctx } = await newCtx();
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'docs/prd.md' } }] },
      { toolCalls: [{ id: 'c2', name: 'write_file', args: { path: 'docs/prd.md', content: '# PRD v1' } }] },
      { content: '任务完成' },
    );
    const result = await runAgent(makeOpts(ctx, provider));

    expect(result.steps).toBe(3);
    expect(result.content).toBe('任务完成');
    // 执行失败（ok=false）也作为 tool 结果回喂，但不算校验失败、不触发重试预算
    const fedBack = toolMessages(requestAt(provider, 1).messages);
    expect(fedBack[0]?.content).toBe('文件不存在');

    const row = await storage.getFile(projectId, 'docs/prd.md');
    expect(row?.content).toBe('# PRD v1');
    expect(row?.version).toBe(1);
    expect(row?.lastEditor).toBe('engineer');
  });
});

describe('runAgent：步数语义', () => {
  it('每次 provider 调用记 1 步；默认上限 12 步用满即抛错', async () => {
    expect(DEFAULT_MAX_STEPS).toBe(12);
    const { ctx } = await newCtx();
    const loopStep: ScriptedStep = { toolCalls: [{ id: 'loop', name: 'list_files', args: {} }] };
    const provider = new FakeProvider(...Array.from({ length: DEFAULT_MAX_STEPS }, () => loopStep), { content: 'done' });

    const error = await catchError(runAgent(makeOpts(ctx, provider)));

    expect((error as Error).message).toContain('最大步数');
    expect(provider.requests).toHaveLength(DEFAULT_MAX_STEPS);
  });

  it('maxSteps=13 时 12 步工具调用 + 1 步收尾可正常完成', async () => {
    const { ctx } = await newCtx();
    const loopStep: ScriptedStep = { toolCalls: [{ id: 'loop', name: 'list_files', args: {} }] };
    const provider = new FakeProvider(...Array.from({ length: 12 }, () => loopStep), { content: 'done' });

    const result = await runAgent(makeOpts(ctx, provider, { maxSteps: 13 }));

    expect(result.steps).toBe(13);
    expect(result.content).toBe('done');
    expect(result.toolCalls).toHaveLength(12);
  });
});
