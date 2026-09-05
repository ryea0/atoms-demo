/**
 * /api/settings/providers/[id]/probe（Task 24 / P3.5）
 * POST：用库里保存的连接信息实测一次 GET {base_url}/models，回延迟 + 模型数 + 预览清单。
 * 探测失败是业务结果而非 HTTP 错误（照常 200，error 已脱敏）；provider 不存在才 404。
 */
import { probeStoredProvider } from '@/lib/settings/service';
import { jsonError, jsonOk, parseId } from '@/lib/settings/http';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const providerId = parseId((await context.params).id);
  if (providerId === null) return jsonError(400, 'invalid_input', 'id 必须是正整数');

  const probe = await probeStoredProvider(providerId);
  if (probe === null) return jsonError(404, 'not_found', '服务商不存在');
  return jsonOk({ probe });
}
