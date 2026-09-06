/**
 * 项目集合入口（Task 16）：GET 卡片墙列表（含最近会话）；POST 一句话建项目。
 *
 * POST 语义（ruling 3）：createProject → 后台 startGeneration（不 await，
 * fire-and-forget）→ 立即 201 {project}。首条用户消息由编排器 executeGeneration
 * 落库（路由层不重复 addMessage，避免聊天区同一需求出现两条 user 消息）；
 * 已知限制见 service.startRoundInBackground 注释（依赖常驻进程模型）。
 */
import { z } from 'zod';
import { createStorage } from '@/lib/db';
import { applySessionCookie, resolveSession } from '@/lib/session';
import { startRoundInBackground } from '@/lib/projects/service';
import { SEED_SESSION_ID } from '@/lib/seed';
import type { ProjectCardItem } from '@/lib/db/provider/types';
import { agentRoleSchema, badRequest, internalError, invalidBody } from '@/lib/api/route-support';

const createProjectSchema = z.object({
  requirement: z.string().trim().min(1, '需求不能为空').max(2000, '需求过长（上限 2000 字）'),
  mode: z.enum(['fast', 'full']),
  mentions: z.array(agentRoleSchema).max(5, '最多 @ 5 位成员').optional(),
});

/** 标题从需求截断派生（无 LLM 依赖的确定性标题；后续轮次可由 agent 优化） */
function titleFromRequirement(requirement: string): string {
  const trimmed = requirement.trim().replace(/\s+/g, ' ');
  return trimmed.length <= 24 ? trimmed : `${trimmed.slice(0, 24)}…`;
}

/** 最近会话条数：默认 8，clamp 到 [1,50]（T3 carry：上限 50 防拖库） */
function clampRecentLimit(raw: string | null): number | null {
  if (raw === null) return 8;
  if (!/^\d{1,9}$/.test(raw)) return null;
  return Math.min(Math.max(Number(raw), 1), 50);
}

export async function GET(request: Request): Promise<Response> {
  try {
    const session = resolveSession(request);
    const recentLimit = clampRecentLimit(new URL(request.url).searchParams.get('recent'));
    if (recentLimit === null) return badRequest('recent 必须是不超过 3 位的正整数');

    const storage = createStorage();
    const [own, templates, recentSessions] = await Promise.all([
      storage.listProjects(session.sessionId),
      // 模板画廊（T25 R1）：seed 演示项目不属于任何会话，卡片墙对所有访客可见（排在用户项目之后）
      storage.listProjects(SEED_SESSION_ID),
      storage.getRecentSessions(session.sessionId, recentLimit),
    ]);
    // isSeed 交给前端做「示例」角标，并把打开动作改走 /api/projects/[id]/open（打开即克隆）
    const projects: ProjectCardItem[] = [
      ...own,
      ...templates.map((project) => ({ ...project, isSeed: true })),
    ];
    // 新访客在此拿到 session cookie（首次进入首页即可建项目）
    return applySessionCookie(Response.json({ projects, recentSessions }), session);
  } catch (error) {
    return internalError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const session = resolveSession(request);
    const parsed = createProjectSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalidBody(parsed.error);

    const storage = createStorage();
    const project = await storage.createProject({
      sessionId: session.sessionId,
      title: titleFromRequirement(parsed.data.requirement),
      requirement: parsed.data.requirement,
      mode: parsed.data.mode,
    });
    startRoundInBackground(storage, project, parsed.data.requirement, parsed.data.mentions ?? []);
    return applySessionCookie(Response.json({ project }, { status: 201 }), session);
  } catch (error) {
    return internalError(error);
  }
}
