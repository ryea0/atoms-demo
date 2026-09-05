/**
 * 追加消息（Task 16，DESIGN §3.5②）：POST {content,mentions?}。
 * - 编排器在跑（orchestratorStatus=running）→ role=intervention 入队
 *   （messages 表 delivered_at IS NULL 即待注入；编排器在步骤边界投递并打戳）
 * - 空闲 → 作为新一轮生成（fire-and-forget，用户消息由编排器落库）
 */
import { z } from 'zod';
import { orchestratorStatus } from '@/lib/agents/orchestrator';
import { startRoundInBackground } from '@/lib/projects/service';
import {
  agentRoleSchema,
  applySessionCookie,
  badRequest,
  idParamsSchema,
  internalError,
  invalidBody,
  parseRouteParams,
  requireProject,
} from '@/lib/api/route-support';

const messageSchema = z.object({
  content: z.string().trim().min(1, '消息不能为空').max(4000, '消息过长（上限 4000 字）'),
  mentions: z.array(agentRoleSchema).max(5, '最多 @ 5 位成员').optional(),
});

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    const parsed = messageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalidBody(parsed.error);
    const mentions = parsed.data.mentions ?? [];

    if (orchestratorStatus(owned.project.id) === 'running') {
      const message = await owned.storage.addMessage({
        projectId: owned.project.id,
        role: 'intervention',
        content: parsed.data.content,
        meta: { mentions },
      });
      return applySessionCookie(Response.json({ delivered: 'intervention', messageId: message.id }), owned.session);
    }

    startRoundInBackground(owned.storage, owned.project, parsed.data.content, mentions);
    return applySessionCookie(Response.json({ delivered: 'round' }), owned.session);
  } catch (error) {
    return internalError(error);
  }
}
