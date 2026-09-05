/**
 * LLM 层测试：mock 行为规格（DESIGN §5⑥）、token 估算校准（§4.4）、
 * 计量降级（usage 缺失 → 估算标 estimated=1）、模型解析与 OpenAI 兼容客户端解析。
 * 外部 HTTP 一律用 fetch 桩，不发真实请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTokens } from '@/lib/llm/estimate';
import { DEFAULT_MODEL, getLlmProvider, LlmError, resolveModel } from '@/lib/llm/client';
import { createMockProvider, readSample } from '@/lib/llm/mock';
import { meteredCall, meteredCallWith, type MeteringSink } from '@/lib/llm/usage';
import type { LlmProvider, LlmRequest, LlmResult, ToolCall } from '@/lib/llm/types';

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

/** 计量假仓库：捕获 recordLlmCall 入参（不依赖 Task 5 的真实存储实现） */
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

/** usage=null 的桩 provider：触发估算降级分支 */
function createStubProvider(overrides: Partial<LlmResult> = {}): LlmProvider {
  const base: LlmResult = { content: '内容', toolCalls: [], usage: null };
  return {
    name: 'stub',
    async complete(): Promise<LlmResult> {
      await Promise.resolve();
      return { ...base, ...overrides };
    },
    async stream(_req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
      onDelta('内容');
      return { ...base, ...overrides };
    },
  };
}

/** unknown 收窄为对象（fetch 入参/JSON 解析结果等边界数据） */
function asRecordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('期望对象，实际为原始值');
  return value as Record<string, unknown>;
}

/** 工具参数收窄为对象（mock 返回的是已解析对象） */
function asRecord(tc: ToolCall | undefined): Record<string, unknown> {
  expect(tc).toBeDefined();
  return asRecordOf(tc?.args);
}

/** 取第一次 fetch 调用的 (url, init)，未调用即失败 */
function firstFetchCall(fn: { mock: { calls: unknown[] } }): { url: string; init: Record<string, unknown> } {
  const call = fn.mock.calls[0];
  expect(call).toBeDefined();
  const args = asRecordOf(call);
  const url = args['0'];
  expect(typeof url).toBe('string');
  return { url: String(url), init: asRecordOf(args['1'] ?? {}) };
}

/** unknown 收窄为 Error（断言错误信息用） */
function asError(e: unknown): Error {
  expect(e).toBeInstanceOf(Error);
  return e as Error;
}

/** 构造 LlmRequest，默认工程师场景 */
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

/** OpenAI SSE 响应桩：把对象数组包成 text/event-stream */
function sseResponse(chunks: unknown[]): Response {
  const encoder = new TextEncoder();
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const body = new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  // 离线快速：mock 流式延迟置 0（DESIGN §5⑥ 延迟可配）
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* 1. token 估算校准（DESIGN §4.4 中文场景校准）                          */
/* ------------------------------------------------------------------ */
describe('estimateTokens', () => {
  it('中文按 1.2 token/字：5 字 → 6', () => {
    expect(estimateTokens('一二三四五')).toBe(6);
  });

  it('英文/代码按 chars/3.5：8 字符 → 3', () => {
    expect(estimateTokens('abcdefgh')).toBe(3);
  });

  it('中英混合按分段求和后 ceil', () => {
    // 2*1.2 + 3/3.5 = 2.4 + 0.8571 = 3.2571 → 4
    expect(estimateTokens('中文abc')).toBe(4);
  });

  it('空串为 0（非中文按字符数统一计入公式）', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   ')).toBe(1); // 3/3.5 → ceil 1
  });
});

/* ------------------------------------------------------------------ */
/* 2. mock provider（DESIGN §5⑥ 行为规格）                               */
/* ------------------------------------------------------------------ */
describe('mock provider 流式', () => {
  it('chunks 合并 = 全文，且每片 ≤ 6 字符；usage 非空', async () => {
    const provider = createMockProvider();
    const deltas: string[] = [];
    const result = await provider.stream(makeReq(), (t: string) => deltas.push(t));
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(result.content);
    expect(result.content.length).toBeGreaterThan(0);
    for (const d of deltas) expect(d.length).toBeLessThanOrEqual(6);
    expect(result.usage).not.toBeNull();
    expect(result.usage?.promptTokens).toBeGreaterThan(0);
    expect(result.usage?.completionTokens).toBeGreaterThan(0);
  });

  it('signal 已中止 → 立即失败，不产出内容', async () => {
    const provider = createMockProvider();
    const controller = new AbortController();
    controller.abort();
    const seen: string[] = [];
    await expect(
      provider.stream(makeReq({ signal: controller.signal }), (t: string) => seen.push(t)),
    ).rejects.toThrow(/中止|abort/i);
    expect(seen).toHaveLength(0);
  });
});

describe('mock provider 角色路由', () => {
  it('leader + assign_task 工具 → 3 个 assign_task（pm→architect→engineer 依赖链）', async () => {
    const provider = createMockProvider();
    const result = await provider.complete(
      makeReq({
        tools: [{ name: 'assign_task', description: '分派子任务', parameters: { type: 'object' } }],
        messages: [
          { role: 'system', content: '你是领导（leader），负责意图路由与任务分派' },
          { role: 'user', content: '做一个待办事项应用' },
        ],
      }),
    );
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls.map((c) => c.name)).toEqual(['assign_task', 'assign_task', 'assign_task']);
    expect(result.toolCalls.map((c) => asRecord(c).task_key)).toEqual([
      'pm-prd',
      'architect-design',
      'engineer-app',
    ]);
    expect(result.toolCalls.map((c) => asRecord(c).agent)).toEqual(['pm', 'architect', 'engineer']);
    // 依赖链：架构依赖 PM，工程师依赖架构
    expect(asRecord(result.toolCalls[1]).depends_on).toEqual(['pm-prd']);
    expect(asRecord(result.toolCalls[2]).depends_on).toEqual(['architect-design']);
    expect(result.toolCalls.every((c) => c.id.length > 0)).toBe(true);
  });

  it('leader 无分派工具 + 收尾指令 → 返回领导汇报/MEMORY 总结', async () => {
    const provider = createMockProvider();
    const result = await provider.complete(
      makeReq({
        messages: [
          { role: 'system', content: '你是领导（leader），负责任务收尾与汇报' },
          { role: 'user', content: '请收尾并输出 MEMORY 总结' },
        ],
      }),
    );
    expect(result.toolCalls).toHaveLength(0);
    expect(result.content).toContain('领导汇报');
    expect(result.content).toContain('MEMORY');
  });

  it('pm → 样例 PRD（功能清单/用户故事/验收标准）', async () => {
    const provider = createMockProvider();
    const result = await provider.complete(
      makeReq({
        messages: [
          { role: 'system', content: '你是产品经理（PM），负责撰写 PRD' },
          { role: 'user', content: '做一个待办事项应用' },
        ],
      }),
    );
    expect(result.content).toContain('功能清单');
    expect(result.content).toContain('用户故事');
    expect(result.content).toContain('验收标准');
    expect(result.content).toBe(readSample('prd.md'));
  });

  it('architect → 多段设计（system_design + mermaid + ===== path ===== 分段 + file_tree）', async () => {
    const provider = createMockProvider();
    const result = await provider.complete(
      makeReq({
        messages: [
          { role: 'system', content: '你是架构师（architect），负责系统设计与 file_tree' },
          { role: 'user', content: '做一个待办事项应用' },
        ],
      }),
    );
    expect(result.content).toBe(readSample('design.md'));
    expect(result.content).toContain('```mermaid');
    expect(result.content).toContain('===== app/frontend/index.html =====');
    expect(result.content).toContain('===== docs/file_tree.md =====');
  });

  it('design.md 内嵌 file_tree 与 filetree.json 完全一致（防止两份样例漂移）', () => {
    const design = readSample('design.md');
    const section = design.split('===== docs/file_tree.md =====')[1] ?? '';
    const match = /```json\s*([\s\S]*?)```/.exec(section);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? 'null')).toEqual(JSON.parse(readSample('filetree.json')));
  });

  it('filetree.json：5 个节点，index.html 依赖 api.js', () => {
    const nodes: unknown = JSON.parse(readSample('filetree.json'));
    expect(Array.isArray(nodes)).toBe(true);
    const list = nodes as Array<{ path: string; desc: string; depends: string[] }>;
    expect(list).toHaveLength(5);
    const paths = list.map((n) => n.path);
    expect(paths).toContain('app/frontend/index.html');
    expect(paths).toContain('app/backend/api.js');
    const index = list.find((n) => n.path === 'app/frontend/index.html');
    expect(index?.depends).toContain('app/backend/api.js');
    for (const n of list) {
      expect(typeof n.path).toBe('string');
      expect(typeof n.desc).toBe('string');
      expect(Array.isArray(n.depends)).toBe(true);
    }
  });

  it('engineer：目标 api.js → 模板含 module.exports{handle} 与注入的路由', async () => {
    const provider = createMockProvider();
    const result = await provider.complete(
      makeReq({
        messages: [
          { role: 'system', content: '你是工程师（engineer），用 write_file 写目标文件' },
          { role: 'user', content: '实现 app/backend/api.js，路由：/api/todos' },
        ],
      }),
    );
    expect(result.content).toContain('module.exports');
    expect(result.content).toContain('handle');
    expect(result.content).not.toContain('localStorage');
  });

  it('engineer：无目标路径 → 默认 app/frontend/index.html（Tailwind CDN + fetch，禁 localStorage）', async () => {
    const provider = createMockProvider();
    const result = await provider.complete(makeReq());
    expect(result.content).toContain('<!DOCTYPE html');
    expect(result.content).toContain('https://cdn.tailwindcss.com');
    expect(result.content).toContain("var API = '/api/todos';");
    expect(result.content).toContain('fetch(API)');
    expect(result.content).not.toContain('localStorage');
    expect(result.content).toContain('待办');
  });

  it('专家角色（analyst/seo/ads）→ 固定报告模板', async () => {
    const provider = createMockProvider();
    for (const [marker, keyword] of [
      ['你是数据分析师（analyst）', '数据分析报告'],
      ['你是 SEO 专家（seo）', 'SEO 优化报告'],
      ['你是广告投放专家（ads）', '广告投放报告'],
    ] as const) {
      const result = await provider.complete(
        makeReq({
          messages: [
            { role: 'system', content: `${marker}，负责专项分析` },
            { role: 'user', content: '做一个待办事项应用' },
          ],
        }),
      );
      expect(result.content).toContain(keyword);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. 模型解析与工厂                                                     */
/* ------------------------------------------------------------------ */
describe('resolveModel', () => {
  it('角色级覆盖优先于全局默认', () => {
    const env = { LLM_MODEL: 'base-model', LLM_MODEL_LEADER: 'leader-model', LLM_MODEL_ENGINEER: 'eng-model' };
    expect(resolveModel('leader', env)).toBe('leader-model');
    expect(resolveModel('engineer', env)).toBe('eng-model');
    expect(resolveModel('pm', env)).toBe('base-model');
  });

  it('无任何配置时回退内置默认模型', () => {
    expect(resolveModel('architect', {})).toBe(DEFAULT_MODEL);
  });
});

describe('getLlmProvider 工厂', () => {
  it('未配置默认 mock', () => {
    expect(getLlmProvider({}).name).toBe('mock');
    expect(getLlmProvider({ LLM_PROVIDER: 'mock' }).name).toBe('mock');
  });

  it('LLM_PROVIDER=openai → openai provider（仅构造，不发请求）', () => {
    const provider = getLlmProvider({ LLM_PROVIDER: 'openai', LLM_BASE_URL: 'https://api.example.com/v1' });
    expect(provider.name).toBe('openai');
    expect(typeof provider.complete).toBe('function');
    expect(typeof provider.stream).toBe('function');
  });

  it('未知 provider → 结构化错误', () => {
    expect(() => getLlmProvider({ LLM_PROVIDER: 'claude' })).toThrow(LlmError);
  });
});

/* ------------------------------------------------------------------ */
/* 4. OpenAI 兼容客户端（fetch 桩，不发真实请求）                          */
/* ------------------------------------------------------------------ */
describe('openai 兼容客户端', () => {
  function stubOpenAiEnv(): void {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_BASE_URL', 'https://api.example.com/v1/'); // 故意带尾斜杠，断言 trim
    vi.stubEnv('LLM_API_KEY', 'sk-unit-test-key');
    vi.stubEnv('LLM_MODEL', 'qwen-test');
  }

  it('stream：解析 data: 行，聚合 content/tool_calls 增量，usage 取自最后 chunk', async () => {
    stubOpenAiEnv();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        sseResponse([
          { choices: [{ index: 0, delta: { content: '你好' } }] },
          { choices: [{ index: 0, delta: { content: '，世界' } }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      type: 'function',
                      function: { name: 'write_file', arguments: '{"path":"app/x' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '.html"}' } }] } }] },
          { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = getLlmProvider();
    const deltas: string[] = [];
    const result = await provider.stream(makeReq({ model: 'qwen-test' }), (t: string) => deltas.push(t));

    expect(deltas.join('')).toBe('你好，世界');
    expect(result.content).toBe('你好，世界');
    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'write_file', args: { path: 'app/x.html' } },
    ]);
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 7 });

    const { url, init } = firstFetchCall(fetchMock);
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = asRecordOf(init.headers);
    expect(headers.Authorization).toBe('Bearer sk-unit-test-key');
    const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(payload.model).toBe('qwen-test');
    expect(payload.stream).toBe(true);
    expect(payload.stream_options).toEqual({ include_usage: true });
  });

  it('complete：非流式请求（stream=false），解析 message/tool_calls/usage', async () => {
    stubOpenAiEnv();
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '好的',
                tool_calls: [
                  {
                    id: 'call_9',
                    type: 'function',
                    function: { name: 'reply_to_user', arguments: '{"content":"hi"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 4 },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await getLlmProvider().complete(makeReq({ model: 'qwen-test' }));
    expect(result.content).toBe('好的');
    expect(result.toolCalls).toEqual([
      { id: 'call_9', name: 'reply_to_user', args: { content: 'hi' } },
    ]);
    expect(result.usage).toEqual({ promptTokens: 20, completionTokens: 4 });

    const payload = JSON.parse(String(firstFetchCall(fetchMock).init.body)) as Record<string, unknown>;
    expect(payload.stream).toBe(false);
  });

  it('SSE 容错：注释行/空行/坏 JSON 被跳过，不中断流', async () => {
    stubOpenAiEnv();
    const encoder = new TextEncoder();
    const raw = ': ping\n\n' + 'data: not-json\n\n' + 'data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n';
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller): void {
                controller.enqueue(encoder.encode(raw));
                controller.close();
              },
            }),
            { status: 200 },
          ),
        ),
      ),
    );
    const result = await getLlmProvider().stream(makeReq(), () => {});
    expect(result.content).toBe('ok');
  });

  it('HTTP 错误 → LlmError 带 status，且错误信息不泄漏 api key', async () => {
    stubOpenAiEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ error: { message: 'bad key sk-unit-test-key' } }, { status: 401 }))),
    );
    const err = asError(await getLlmProvider().complete(makeReq()).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain('401');
    expect(err.message).not.toContain('sk-unit-test-key');
    const lle = err as LlmError;
    expect(lle.code).toBe('http_error');
    expect(lle.status).toBe(401);
  });

  it('complete：200 但响应体非 JSON（网关 HTML/截断）→ LlmError bad_response，附片段且不泄密钥', async () => {
    stubOpenAiEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<html>502 Bad Gateway sk-unit-test-key</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      ),
    );
    const err = asError(await getLlmProvider().complete(makeReq()).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(LlmError); // 不是裸 SyntaxError
    expect((err as LlmError).code).toBe('bad_response');
    expect((err as LlmError).status).toBe(200);
    expect(err.message).toContain('502 Bad Gateway');
    expect(err.message).not.toContain('sk-unit-test-key');
  });

  it('缺少 LLM_BASE_URL → config_missing（调用时报错，构造不炸）', async () => {
    vi.stubEnv('LLM_PROVIDER', 'openai');
    vi.stubEnv('LLM_API_KEY', 'sk-unit-test-key');
    const provider = getLlmProvider();
    const err = asError(await provider.complete(makeReq()).catch((e: unknown) => e));
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).code).toBe('config_missing');
  });

  it('arguments 非 JSON → 保留原始字符串（不丢工具调用）', async () => {
    stubOpenAiEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '截断的参数{' } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        ),
      ),
    );
    const result = await getLlmProvider().complete(makeReq());
    expect(result.toolCalls[0]?.args).toBe('截断的参数{');
  });
});

/* ------------------------------------------------------------------ */
/* 5. 计量（meteredCall）                                                */
/* ------------------------------------------------------------------ */
describe('meteredCall 计量', () => {
  it('usage=null → estimateTokens 估算、estimated=1、cost=0', async () => {
    const { sink, calls } = createFakeSink();
    const result = await meteredCallWith(
      createStubProvider({ usage: null }),
      sink,
      42,
      'engineer',
      { messages: [{ role: 'user', content: '一二三四五' }] },
    );
    expect(result.content).toBe('内容');
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.projectId).toBe(42);
    expect(call.agentRole).toBe('engineer');
    expect(call.estimated).toBe(1);
    expect(call.cost).toBe(0);
    expect(call.promptTokens).toBeGreaterThan(0);
    expect(call.completionTokens).toBeGreaterThan(0);
    expect(call.latencyMs).toBeGreaterThanOrEqual(0);
    // 未传 model → resolveModel 兜底
    expect(call.model).toBe(DEFAULT_MODEL);
  });

  it('usage 已提供 → 原样落库、estimated=0，不做估算', async () => {
    const { sink, calls } = createFakeSink();
    await meteredCallWith(
      createStubProvider({ usage: { promptTokens: 10, completionTokens: 3 } }),
      sink,
      1,
      'pm',
      { model: 'm1', messages: [{ role: 'user', content: '中文abc' }] },
    );
    expect(calls[0]).toMatchObject({
      projectId: 1,
      agentRole: 'pm',
      model: 'm1',
      promptTokens: 10,
      completionTokens: 3,
      estimated: 0,
      cost: 0,
    });
  });

  it('传 onDelta → 走 provider.stream（增量可见）', async () => {
    const { sink, calls } = createFakeSink();
    const seen: string[] = [];
    await meteredCallWith(createStubProvider(), sink, 3, 'seo', { messages: [] }, (t: string) => seen.push(t));
    expect(seen).toEqual(['内容']);
    expect(calls).toHaveLength(1);
  });

  it('sink 落库失败 → 记录错误但不吞掉调用结果', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken: MeteringSink = {
        async recordLlmCall(): Promise<void> {
          throw new Error('db down');
        },
      };
      const result = await meteredCallWith(createStubProvider(), broken, 5, 'ads', { messages: [] });
      expect(result.content).toBe('内容');
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('默认工厂（mock）+ mock 自带 usage → estimated=0 且拿到样例产出', async () => {
    const { sink, calls } = createFakeSink();
    const result = await meteredCall(
      sink,
      7,
      'pm',
      {
        messages: [
          { role: 'system', content: '你是产品经理（PM）' },
          { role: 'user', content: '做一个待办事项应用' },
        ],
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].estimated).toBe(0);
    expect(calls[0].agentRole).toBe('pm');
    expect(calls[0].model).toBe(DEFAULT_MODEL);
    expect(result.content).toContain('功能清单');
  });
});
