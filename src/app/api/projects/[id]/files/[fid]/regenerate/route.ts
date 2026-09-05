/**
 * 单文件重试（Task 16，CLAUDE.md 规则 3：单文件重试 = 重跑该单文件任务）。
 *
 * POST → regenerateFile（服务层组装 target/fileTree/designSummary 并补发
 * agent/file/delta SSE 事件，契约与编排器一致）。串行写模型（规则 2）要求
 * 重试不与在跑轮次并发：orchestratorStatus=running 时 409（先停止或等待完成）。
 * 客户端断开（request.signal）级联中止本次重试的 LLM 调用（rules 06 abort 纪律）。
 */
import { z } from 'zod';
import { orchestratorStatus } from '@/lib/agents/orchestrator';
import { regenerateFile } from '@/lib/projects/service';
import {
  applySessionCookie,
  badRequest,
  idParamsSchema,
  internalError,
  notFound,
  parseRouteParams,
  requireProject,
} from '@/lib/api/route-support';

const fileParamsSchema = idParamsSchema.extend({ fid: z.string().regex(/^\d{1,9}$/, '必须是数字 id') });

export async function POST(request: Request, ctx: { params: Promise<{ id: string; fid: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(fileParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id/fid 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;
    const fileId = Number(params.fid);

    const file = await owned.storage.getFileById(owned.project.id, fileId);
    if (file === null) return notFound(`文件不存在：fileId=${fileId}`);

    if (orchestratorStatus(owned.project.id) === 'running') {
      return Response.json({ error: '生成进行中，暂不能重试单文件：请先停止或等待本轮完成' }, { status: 409 });
    }

    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort();
    request.signal.addEventListener('abort', forwardAbort, { once: true });
    try {
      const result = await regenerateFile(owned.storage, owned.project.id, file, controller.signal);
      return applySessionCookie(Response.json(result), owned.session);
    } finally {
      request.signal.removeEventListener('abort', forwardAbort);
    }
  } catch (error) {
    return internalError(error);
  }
}
