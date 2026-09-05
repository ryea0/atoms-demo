/**
 * 导出 zip（Task 16）：GET → readAllFiles 全量打包（application/zip + attachment）。
 * 路由只服务外部调用方（浏览器下载），内部读不走本路由（rules 02）。
 */
import JSZip from 'jszip';
import { applySessionCookie, badRequest, idParamsSchema, internalError, parseRouteParams, requireProject } from '@/lib/api/route-support';

/** 文件名清洗：去路径分隔/引号/控制字符，保留中日韩文字（filename* UTF-8 编码下发） */
function safeTitle(title: string): string {
  const cleaned = title.replace(/["\\\r\n/]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 40);
}

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;

    const files = await owned.storage.readAllFiles(owned.project.id);
    const zip = new JSZip();
    for (const file of files) {
      zip.file(file.path, file.content);
    }
    // BodyInit 需要 ArrayBuffer 背书的 Uint8Array（TS 类型层），故取 arraybuffer 再包装
    const buffer = await zip.generateAsync({ type: 'arraybuffer' });
    const bytes = new Uint8Array(buffer);

    const title = safeTitle(owned.project.title);
    const utf8Name = `${title === '' ? 'atoms-project' : title}-${owned.project.id}.zip`;
    const disposition = `attachment; filename="atoms-project-${owned.project.id}.zip"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`;

    return applySessionCookie(
      new Response(bytes, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': disposition,
        },
      }),
      owned.session,
    );
  } catch (error) {
    return internalError(error);
  }
}
