/**
 * 停止生成（Task 16，DESIGN §3.5①）：POST → stopProject（同步 abort 项目级
 * AbortController）。stopped 事件与 status=paused 的收口由运行中轮次统一负责，
 * 空闲项目为幂等 no-op——接口本身幂等且校验归属（rules 07）。
 */
import { applySessionCookie, badRequest, idParamsSchema, internalError, parseRouteParams, requireProject } from '@/lib/api/route-support';
import { stopProject } from '@/lib/agents/orchestrator';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    await stopProject(owned.storage, owned.project.id);
    return applySessionCookie(Response.json({ ok: true }), owned.session);
  } catch (error) {
    return internalError(error);
  }
}
