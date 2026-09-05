/**
 * 设置页 Route Handler 共享出口（服务端专用）：
 * 统一「成功体 / 结构化错误体 / JSON 解析 / zod 校验 / 路径 id 收窄」，handler 只剩 调用→响应。
 * 错误体 `{ error: { code, message } }`（rules/01：边界错误结构化，不泄漏堆栈与密钥）。
 */
import type { ZodType } from 'zod';

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function jsonOk(data: Record<string, unknown>, status = 200): Response {
  return Response.json(data, { status, headers: NO_STORE });
}

export function jsonError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: NO_STORE });
}

/** 读 JSON body：空体/非 JSON → null（调用方按 invalid_input 回 400） */
export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** zod 校验：成功返回收窄后的数据，失败返回首条 issue 的中文提示（不带堆栈） */
export function parseWith<T>(schema: ZodType<T>, data: unknown): { ok: true; data: T } | { ok: false; message: string } {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue !== undefined && issue.path.length > 0 ? issue.path.join('.') : 'body';
  return { ok: false, message: issue === undefined ? '入参校验失败' : `${field}：${issue.message}` };
}

/** 路径参数 id 收窄：非正整数 → null（调用方回 400） */
export function parseId(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}
