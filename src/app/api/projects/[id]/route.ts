/**
 * 单项目入口（Task 16）：GET 现场恢复快照 / PATCH 重命名 / DELETE 删除。
 *
 * GET 响应（T15 契约备注）：agent_start/delta 事件 runId=null，时间线消费方按
 * agent+path 归属；runId 以 file_end/agent_end 为准。快照 lastSeq 供 SSE 重连对齐
 * （客户端先快照对齐，再以 Last-Event-ID=lastSeq 重放增量——rules 06）。
 */
import { z } from 'zod';
import { projectEventBus } from '@/lib/agents/events';
import { removeWorkspace } from '@/lib/exec/materialize';
import { buildProjectSnapshot } from '@/lib/projects/service';
import {
  applySessionCookie,
  badRequest,
  idParamsSchema,
  internalError,
  invalidBody,
  notFound,
  parseRouteParams,
  requireProject,
} from '@/lib/api/route-support';

const renameSchema = z.object({
  title: z.string().trim().min(1, '标题不能为空').max(80, '标题过长（上限 80 字）'),
});

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    const snapshot = await buildProjectSnapshot(owned.storage, owned.project.id);
    if (snapshot === null) return notFound(`项目不存在：id=${params.id}`);
    return applySessionCookie(Response.json(snapshot), owned.session);
  } catch (error) {
    return internalError(error);
  }
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    const parsed = renameSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalidBody(parsed.error);

    await owned.storage.renameProject(owned.project.id, parsed.data.title);
    const project = await owned.storage.getProject(owned.project.id);
    return applySessionCookie(Response.json({ project }), owned.session);
  } catch (error) {
    return internalError(error);
  }
}

export async function DELETE(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    await owned.storage.deleteProject(owned.project.id);
    // ruling 12：删除时显式释放总线桶（清环形缓冲/订阅者/在流文本）
    projectEventBus.release(owned.project.id);
    // 级联清理磁盘工作区投影（幂等 best-effort，失败只 warn 不阻断删除）
    await removeWorkspace(owned.project.id);
    return applySessionCookie(Response.json({ ok: true }), owned.session);
  } catch (error) {
    return internalError(error);
  }
}
