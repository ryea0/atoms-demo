/**
 * 人工软锁声明（Task 21，DESIGN §3.9 预防层）：PUT {on:boolean} → setSoftLock。
 *
 * 查看器进入编辑态时声明 `editing_by=human`（TTL 10min），编排器在工程师文件边界据此
 * 挂起该文件任务并在聊天区请求裁决（消费侧 T23 已实现）；保存 / 离开编辑态时释放。
 * 与 PATCH files/[fid] 同一归属校验（requireProject，他人 id 一律 404），文件不存在 404。
 */
import { z } from 'zod';
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

const fileParamsSchema = idParamsSchema.extend({ fid: z.string().regex(/^\d{1,9}$/, '必须是数字 id') });

const lockSchema = z.object({ on: z.boolean() });

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ id: string; fid: string }> },
): Promise<Response> {
  try {
    const params = await parseRouteParams(fileParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id/fid 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;
    const fileId = Number(params.fid);

    const parsed = lockSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalidBody(parsed.error);

    // 预检文件归属：软锁是对具体文件行的标记，不存在/不属于本项目一律 404
    const existing = await owned.storage.getFileById(owned.project.id, fileId);
    if (existing === null) return notFound(`文件不存在：fileId=${fileId}`);

    await owned.storage.setSoftLock(owned.project.id, fileId, parsed.data.on);
    return applySessionCookie(Response.json({ on: parsed.data.on }), owned.session);
  } catch (error) {
    return internalError(error);
  }
}
