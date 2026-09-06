/**
 * 打开项目 / 示例模板（Task 25 R1，模板画廊）：GET → 302 到可进入的工作台。
 *
 * - 普通项目 → 302 `/p/{id}`（客户端通常直接走 `/p/[id]`，本端点是模板打开的统一入口）
 * - seed 模板（sessionId='seed'）→ 克隆一份到当前会话（`openProjectOrTemplate`）→ 302 `/p/{副本id}`：
 *   seed 原件不属于任何访客会话（requireProject 一律 404，归属纪律规则 9/07 不放行），
 *   人人得一份自己的副本，同会话重复打开复用既有副本（防卡片墙堆积）
 * - 新访客（无会话 cookie）→ 302 响应顺带 Set-Cookie（applySessionCookie），打开即建立会话
 * - 项目不存在 → 404 结构化错误
 *
 * 写操作（克隆）挂在 GET 上是刻意的：本端点的语义就是「打开」这一导航动作，
 * 响应是跳转而非数据；克隆有同会话复用守卫，重复打开不产生新行。
 */
import { createStorage } from '@/lib/db';
import { openProjectOrTemplate } from '@/lib/seed';
import {
  applySessionCookie,
  badRequest,
  idParamsSchema,
  internalError,
  notFound,
  parseRouteParams,
  resolveSession,
} from '@/lib/api/route-support';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const session = resolveSession(request);
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');

    const outcome = await openProjectOrTemplate(createStorage(), session.sessionId, Number(params.id));
    if (outcome === null) return notFound(`项目不存在：id=${params.id}`);

    // 不用 Response.redirect()：它返回的 headers 是 immutable，后续 applySessionCookie 无法补 Set-Cookie
    const target = new URL(`/p/${outcome.projectId}`, request.url).toString();
    return applySessionCookie(new Response(null, { status: 302, headers: { Location: target } }), session);
  } catch (error) {
    return internalError(error);
  }
}
