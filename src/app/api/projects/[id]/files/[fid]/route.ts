/**
 * 人工编辑保存（Task 16，DESIGN §3.9 人机共编）：PATCH {content,baseVersion} → saveHuman。
 *
 * - CAS 乐观锁：baseVersion 过期 → 409 {conflict:true,current=服务端最新内容}
 *   （前端据此渲染冲突对话框：用我的版本 / 用 agent 版本 / 并排 diff）
 * - saveHuman 把「文件不存在」也归并为冲突（repo 契约），路由在调用前预检
 *   getFileById → 404，让两种失败可区分（ruling 5）
 * - content ≤ 512KB（rules 07 二次约束，与 fs 工具同一 MAX_CONTENT_BYTES 口径）
 */
import { z } from 'zod';
import { MAX_CONTENT_BYTES } from '@/lib/agents/tools';
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

const saveSchema = z.object({
  content: z.string().max(MAX_CONTENT_BYTES, `内容超过上限 ${MAX_CONTENT_BYTES} 字节（512KB）`), // 字符级粗检，字节级下面复检
  baseVersion: z.number().int().min(1, 'baseVersion 必须是正整数'),
});

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string; fid: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(fileParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id/fid 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;
    const fileId = Number(params.fid);

    const parsed = saveSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalidBody(parsed.error);
    // 字节级复检（多字节字符按 UTF-8 计，rules 07）
    if (Buffer.byteLength(parsed.data.content, 'utf8') > MAX_CONTENT_BYTES) {
      return badRequest(`内容超过上限 ${MAX_CONTENT_BYTES} 字节（512KB），请精简或拆分文件`);
    }

    // 预检：文件不存在 → 404（区别于 saveHuman 归并的 409 冲突）
    const existing = await owned.storage.getFileById(owned.project.id, fileId);
    if (existing === null) return notFound(`文件不存在：fileId=${fileId}`);

    const result = await owned.storage.saveHuman({
      projectId: owned.project.id,
      fileId,
      content: parsed.data.content,
      baseVersion: parsed.data.baseVersion,
    });
    if (!result.ok) {
      return applySessionCookie(
        Response.json({ conflict: true, current: result.current }, { status: 409 }),
        owned.session,
      );
    }
    return applySessionCookie(Response.json({ version: result.version }), owned.session);
  } catch (error) {
    return internalError(error);
  }
}
