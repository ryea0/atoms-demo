/**
 * 全栈预览（Task 16，DESIGN §3.7 / rules 07 预览隔离）：
 * GET → assemblePreview 注入后端垫片与 fetch 拦截器的完整 HTML（iframe srcDoc 用）。
 * CSP 头 ruling 7 逐字；缺 index.html / 归属不符等失败分支 → 404 **中文 HTML 提示页**
 * （T25：本路由的响应直接进 iframe，裸 JSON 无样式且读不懂，体验差）。
 */
import { assemblePreview, PREVIEW_CSP } from '@/lib/preview/assemble';
import { applySessionCookie, idParamsSchema, parseRouteParams, requireProject } from '@/lib/api/route-support';

/** 预览错误页 CSP：静态自绘页，无脚本无外链（rules 07 同源收紧） */
// 注：错误页是独立 HTML 文档（iframe 直接加载），拿不到平台 globals.css 的 token——
// 色值只能就地写死；「禁魔法色值」针对平台 UI（组件层），此处不在其管辖面。
const PREVIEW_ERROR_CSP = "default-src 'none'; style-src 'unsafe-inline'";

/**
 * 中文 HTML 提示页（404/400 都走它）：iframe 里可读、无样式依赖。
 * message 为用户可读中文，不含内部细节（rules 01/07 不泄漏堆栈）。
 */
function previewErrorPage(message: string, status: number): Response {
  const safe = message.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>预览不可用</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f7f7f8; color: #171717; font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  main { max-width: 30rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.05rem; margin: 0 0 .5rem; }
  p { font-size: .85rem; line-height: 1.7; color: #555; margin: 0; }
</style>
</head>
<body>
<main>
<h1>预览不可用</h1>
<p>${safe}</p>
</main>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PREVIEW_ERROR_CSP, 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  let projectId = '?'; // 日志用（catch 分支 params 不可达）
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return previewErrorPage('路径参数不合法：项目 id 必须是数字', 400);
    projectId = params.id;
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) {
      return previewErrorPage('项目不存在或不在当前会话内：请从工作台打开该项目后再预览', 404);
    }

    const result = await assemblePreview(owned.storage, owned.project.id);
    if (!result.ok) {
      return previewErrorPage('尚未生成 app/frontend/index.html：先完成一轮生成，或等工程师产出前端页面', 404);
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
    return previewErrorPage('装配失败，请稍后重试', 404);
  }
}
