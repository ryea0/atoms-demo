/**
 * 客户端请求层测试：错误信封解析（终审修复轮 #2）。
 *
 * 服务端 projects 族路由统一返回 `{ error: "<中文>" }`（route-support.ts 的
 * badRequest/notFound/internalError/invalidBody）；requestJson 必须把顶层 error 字符串
 * 解析成 ApiError.message，否则所有 4xx/5xx 降级为「请求失败（HTTP xxx）」，校验文案全被吞。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError, requestJson } from '@/lib/client/session';

function responseWith(payload: unknown, status: number): Response {
  const text = JSON.stringify(payload);
  return { ok: false, status, json: async () => payload, text: async () => text } as unknown as Response;
}

function stubFetch(response: Response): void {
  vi.stubGlobal('fetch', vi.fn(async () => response));
}

describe('requestJson 错误信封解析', () => {
  it('服务端 {error: "<中文>"} 信封 → message 取该文案，code 缺省 http_error', async () => {
    stubFetch(responseWith({ error: '参数校验失败：requirement 长度须在 1-2000 之间' }, 400));
    const error = await requestJson('/api/projects', { method: 'POST' }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(400);
    expect(apiError.code).toBe('http_error');
    expect(apiError.message).toBe('参数校验失败：requirement 长度须在 1-2000 之间');
  });

  it('404/409 同样解析（notFound 与运行中冲突的中文文案不再被吞）', async () => {
    stubFetch(responseWith({ error: '生成进行中，暂不能回滚：请先停止或等待本轮完成' }, 409));
    const error = (await requestJson('/api/projects/7/checkpoints/1/restore', { method: 'POST' }).catch(
      (cause: unknown) => cause,
    )) as ApiError;
    expect(error.status).toBe(409);
    expect(error.message).toContain('生成进行中');
  });

  it('顶层 {code, message} 信封仍优先（兼容带 code 的路由）', async () => {
    stubFetch(responseWith({ error: '被忽略', code: 'cas_conflict', message: '版本已过期' }, 409));
    const error = (await requestJson('/api/projects/7/files/1', { method: 'PATCH' }).catch(
      (cause: unknown) => cause,
    )) as ApiError;
    expect(error.code).toBe('cas_conflict');
    expect(error.message).toBe('版本已过期');
  });

  it('非 JSON/空体 → 维持 HTTP 兜底文案', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => null, text: async () => '' }) as unknown as Response),
    );
    const error = (await requestJson('/api/projects').catch((cause: unknown) => cause)) as ApiError;
    expect(error.code).toBe('http_error');
    expect(error.message).toBe('请求失败（HTTP 500）');
  });
});
