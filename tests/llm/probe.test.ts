/**
 * probeProvider 测试（Task 27 / DESIGN §5①「模型探测」增强）：
 * 探测 = GET {baseUrl 去尾斜杠}/models（OpenAI 兼容 data[].id），墙钟计时；
 * 非 200 / 坏 JSON / 结构不符 → ok:false；错误信息绝不回显 api key（.claude/rules/07）。
 * 外部 HTTP 一律 fetch 桩，不发真实请求。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROBE_TIMEOUT_MS, probeProvider } from '@/lib/llm/probe';

/* ------------------------------------------------------------------ */
/* 夹具与工具                                                           */
/* ------------------------------------------------------------------ */

const BASE_URL = 'https://api.example.com/v1';
const API_KEY = 'sk-secret-probe-key-9527';

/** unknown 收窄为对象（fetch 入参等边界数据） */
function asRecordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('期望对象，实际为原始值');
  return value as Record<string, unknown>;
}

/** 取第一次 fetch 调用的 (url, init)，未调用即显式失败 */
function firstFetchCall(fn: { mock: { calls: unknown[] } }): { url: string; init: Record<string, unknown> } {
  const call = fn.mock.calls[0];
  expect(call).toBeDefined();
  const args = asRecordOf(call);
  expect(typeof args['0']).toBe('string');
  return { url: String(args['0']), init: asRecordOf(args['1'] ?? {}) };
}

/** 同步毫秒级墙钟下保证 latencyMs > 0 的最小等待 */
function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON 响应桩 */
function jsonResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** 安装一次性 fetch 桩 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* probeProvider                                                        */
/* ------------------------------------------------------------------ */
describe('probeProvider', () => {
  it('① 200 + data[].id → ok:true 带模型清单，GET 请求打到去尾斜杠的 /models，墙钟 latencyMs>0', async () => {
    const fn = stubFetch(async () => {
      await tick();
      return jsonResponse(200, JSON.stringify({ data: [{ id: 'qwen-max' }, { id: 'qwen-plus' }] }));
    });

    const result = await probeProvider({ baseUrl: `${BASE_URL}/`, apiKey: API_KEY });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('预期探测成功');
    expect(result.models).toEqual(['qwen-max', 'qwen-plus']);
    expect(result.latencyMs).toBeGreaterThan(0);

    const { url, init } = firstFetchCall(fn);
    expect(url).toBe(`${BASE_URL}/models`); // 尾斜杠被去掉，且不会出现 //
    expect(init['method']).toBe('GET');
    const headers = asRecordOf(init['headers'] ?? {});
    expect(headers['Authorization']).toBe(`Bearer ${API_KEY}`);
    expect(init['signal']).toBeInstanceOf(AbortSignal);
  });

  it('① 补：重复模型去重；连续尾斜杠全部剥掉', async () => {
    stubFetch(async () => jsonResponse(200, JSON.stringify({ data: [{ id: 'm1' }, { id: 'm1' }, { id: 'm2' }] })));

    const result = await probeProvider({ baseUrl: `${BASE_URL}///`, apiKey: API_KEY });

    expect(result).toMatchObject({ ok: true, models: ['m1', 'm2'] });
  });

  it('② 401 → ok:false，错误带状态码且不回显 api key', async () => {
    stubFetch(async () => {
      await tick();
      return jsonResponse(401, JSON.stringify({ error: { message: 'invalid api key' } }));
    });

    const result = await probeProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('预期探测失败');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.error).toContain('401');
    expect(result.error).not.toContain(API_KEY);
  });

  it('③ 超时（AbortError）→ ok:false，错误提示超时，latencyMs 实测墙钟', async () => {
    stubFetch(async () => {
      await tick();
      const abort = new Error('This operation was aborted');
      abort.name = 'AbortError';
      throw abort;
    });

    const result = await probeProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('预期探测失败');
    expect(result.error).toContain('超时');
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.error).not.toContain(API_KEY);
  });

  it('④ 200 但响应非 JSON → ok:false（网关返回 HTML 等场景），响应体经脱敏', async () => {
    stubFetch(async () => new Response(`<html>token=${API_KEY}</html>`, { status: 200 }));

    const result = await probeProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('预期探测失败');
    expect(result.error).toContain('非 JSON');
    expect(result.error).not.toContain(API_KEY);
  });

  it('⑤ 200 JSON 但结构不符（缺 data[].id）→ ok:false', async () => {
    stubFetch(async () => jsonResponse(200, JSON.stringify({ object: 'list', data: [{ nope: 1 }] })));

    const result = await probeProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    expect(result).toMatchObject({ ok: false });
  });

  it('⑥ 网络层异常（fetch failed）→ ok:false 且不含密钥', async () => {
    stubFetch(async () => {
      throw new Error('fetch failed: getaddrinfo ENOTFOUND api.example.com');
    });

    const result = await probeProvider({ baseUrl: BASE_URL, apiKey: API_KEY });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error('预期探测失败');
    expect(result.error).not.toContain(API_KEY);
  });

  it('⑦ baseUrl 为空 → ok:false，不发起请求', async () => {
    const fn = stubFetch(async () => jsonResponse(200, '{"data":[]}'));

    const result = await probeProvider({ baseUrl: '   ', apiKey: API_KEY });

    expect(result).toMatchObject({ ok: false });
    expect(fn.mock.calls).toHaveLength(0);
  });

  it('⑧ 缺省 timeoutMs = 10s（DESIGN §5① 探测规格）', () => {
    expect(DEFAULT_PROBE_TIMEOUT_MS).toBe(10_000);
  });
});
