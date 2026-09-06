/**
 * 停止终端命令（Task 2）：POST → 杀当前占用终端槽的进程组。
 * 幂等且校验归属（rules 07）：无运行中命令 stopped=false；stop 只负责发杀信号，
 * exit 帧（reason=killed）与槽释放由 exec 流那侧收口上报。
 */
import { activeTerminalRun } from '@/lib/exec/slots';
import {
  applySessionCookie,
  badRequest,
  idParamsSchema,
  internalError,
  parseRouteParams,
  requireProject,
} from '@/lib/api/route-support';

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    const running = activeTerminalRun(owned.project.id);
    running?.stop();
    return applySessionCookie(Response.json({ ok: true, stopped: running !== null }), owned.session);
  } catch (error) {
    return internalError(error);
  }
}
