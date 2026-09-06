/**
 * Route Handler 公共支撑（Task 16，.claude/rules/02「Route Handler 纪律」）。
 *
 * handler 只做「解析 → 校验 → 调用 → 响应」：业务逻辑全部在 src/lib/ 服务层；
 * 所有输入 zod 校验（400 结构化错误，不泄漏堆栈——rules 01/07）；
 * 项目访问一律经 requireProject 做会话归属校验（他人 id 404）。
 */
import { z } from 'zod';
import { createStorage } from '@/lib/db';
import { formatZodIssues } from '@/lib/agents/tools';
import { resolveSession, type ResolvedSession } from '@/lib/session';
import type { Project, StorageProvider } from '@/lib/db/provider/types';

/** 会话工具转发出口：路由文件统一从本模块拿（session.ts 是唯一实现） */
export { applySessionCookie, resolveSession } from '@/lib/session';

/** 全部 agent 角色（与 provider/types 的 AgentRole 保持一致；mentions 校验用） */
export const agentRoleSchema = z.enum(['leader', 'pm', 'architect', 'engineer', 'analyst', 'seo', 'ads']);

/** 数字型路径段（id / fid / cpId）：纯数字、上限 9 位防溢出 */
export const numericIdParam = z.string().regex(/^\d{1,9}$/, '必须是数字 id');

/** id 形路由参数 schema（[id] 段） */
export const idParamsSchema = z.object({ id: numericIdParam });

/** unknown → 一行可读信息（结构化错误体用，不带堆栈） */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 400：zod 校验失败（字段路径 + 原因，与工具层回喂格式同源） */
export function invalidBody(error: z.ZodError): Response {
  return Response.json({ error: `参数校验失败：${formatZodIssues(error)}` }, { status: 400 });
}

/** 400：语义级参数错误 */
export function badRequest(message: string): Response {
  return Response.json({ error: message }, { status: 400 });
}

/** 404：资源不存在 / 归属不符（对外统一口径，不区分两种情况） */
export function notFound(message: string): Response {
  return Response.json({ error: message }, { status: 404 });
}

/** 409：状态冲突（如终端已被占用）；附加字段（code/runningCommand 等）merge 进响应体 */
export function conflict(message: string, body: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...body }, { status: 409 });
}

/** 503：能力被配置关闭（如 EXEC_PROVIDER=disabled） */
export function serviceUnavailable(message: string, body: Record<string, unknown> = {}): Response {
  return Response.json({ error: message, ...body }, { status: 503 });
}

/** 500：兜底异常（完整错误只进服务端日志；响应只带一行 message） */
export function internalError(error: unknown): Response {
  console.error('[api] 处理失败：', error);
  return Response.json({ error: `服务器内部错误：${errorMessage(error)}` }, { status: 500 });
}

/**
 * 路径参数解析（Next 15：params 是 Promise，必须 await）。
 * 校验失败返回 null（调用方回 400），成功返回收窄后的对象。
 */
export async function parseRouteParams<S extends z.ZodType>(
  schema: S,
  params: Promise<unknown>,
): Promise<z.output<S> | null> {
  try {
    return schema.parse(await params) as z.output<S>;
  } catch {
    return null;
  }
}

/** 通过校验的项目上下文：storage 由工厂取（文件库按路径 memoize，单写者不叠加） */
export interface OwnedProject {
  storage: StorageProvider;
  session: ResolvedSession;
  project: Project;
}

/**
 * 会话解析 + 项目归属校验（rules 07）：项目不存在或 session 不匹配一律 404。
 * 返回 Response 即校验失败，调用方直接 `if (x instanceof Response) return x;`。
 */
export async function requireProject(request: Request, projectId: number): Promise<OwnedProject | Response> {
  const session = resolveSession(request);
  const storage = createStorage();
  const project = await storage.getProject(projectId);
  if (project === null || project.sessionId !== session.sessionId) {
    return notFound(`项目不存在：id=${projectId}`);
  }
  return { storage, session, project };
}
