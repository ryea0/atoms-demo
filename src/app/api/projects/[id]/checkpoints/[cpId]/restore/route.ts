/**
 * 检查点回滚（Task 16，DESIGN §3.10）：POST → restoreCheckpointAndNotify。
 *
 * 事务内恢复 files（回滚可撤销）→ 相关 agent_runs 标 rolled_back →
 * SSE message 事件通知聊天区（时间线「回到此任务前」入口）。幂等性：重复
 * restore 同一检查点会重复归档一版相同内容（无害，版本历史多一行），归属
 * 校验不通过一律 404。
 */
import { z } from 'zod';
import { CheckpointNotFoundError, restoreCheckpointAndNotify } from '@/lib/projects/service';
import {
  applySessionCookie,
  badRequest,
  idParamsSchema,
  internalError,
  notFound,
  parseRouteParams,
  requireProject,
} from '@/lib/api/route-support';

const checkpointParamsSchema = idParamsSchema.extend({ cpId: z.string().regex(/^\d{1,9}$/, '必须是数字 id') });

export async function POST(request: Request, ctx: { params: Promise<{ id: string; cpId: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(checkpointParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id/cpId 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    const affected = await restoreCheckpointAndNotify(owned.storage, owned.project.id, Number(params.cpId));
    return applySessionCookie(
      Response.json({ ok: true, checkpointId: Number(params.cpId), restoredFiles: affected.length }),
      owned.session,
    );
  } catch (error) {
    if (error instanceof CheckpointNotFoundError) return notFound(error.message);
    return internalError(error);
  }
}
