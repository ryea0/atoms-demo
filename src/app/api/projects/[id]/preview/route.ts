/**
 * 全栈预览（Task 16，DESIGN §3.7 / rules 07 预览隔离）：
 * GET → assemblePreview 注入后端垫片与 fetch 拦截器的完整 HTML（iframe srcDoc 用）。
 * CSP 头 ruling 7 逐字；缺 index.html → 404 中文提示。
 */
import { assemblePreview, PREVIEW_CSP } from '@/lib/preview/assemble';
import { applySessionCookie, badRequest, idParamsSchema, notFound, parseRouteParams, requireProject } from '@/lib/api/route-support';

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let projectId = '?'; // 日志用（catch 分支 params 不可达）
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    projectId = params.id;
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    const result = await assemblePreview(owned.storage, owned.project.id);
    if (!result.ok) {
      return notFound('预览不可用：尚未生成 app/frontend/index.html（先完成一轮生成，或等工程师产出前端页面）');
    }
    // 生成物每次可能变化，禁缓存；CSP 由服务端统一下发（模型无法"忘记"垫片与隔离）
    return applySessionCookie(
      new Response(result.html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': PREVIEW_CSP,
          'Cache-Control': 'no-store',
        },
      }),
      owned.session,
    );
  } catch (error) {
    // 装配是纯读路径：错误只进日志，对客户端给统一 404（不泄漏内部细节）
    console.error(`[api] 预览装配失败（projectId=${projectId}）：`, error);
    return notFound('预览不可用：装配失败');
  }
}
