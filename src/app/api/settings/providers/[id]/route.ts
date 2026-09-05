/**
 * /api/settings/providers/[id]（Task 24 / P3.5）
 * PATCH：局部更新（缺省键不改；空 api_key 视为未提供，不覆盖既有密钥）；
 * DELETE：删除服务商（模型与角色绑定经外键级联清除）。
 */
import { deleteProvider, updateProvider } from '@/lib/settings/service';
import { jsonError, jsonOk, parseId, parseWith, readJsonBody } from '@/lib/settings/http';
import { providerPatchSchema } from '@/lib/settings/validation';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const providerId = parseId((await context.params).id);
  if (providerId === null) return jsonError(400, 'invalid_input', 'id 必须是正整数');

  const parsed = parseWith(providerPatchSchema, await readJsonBody(request));
  if (!parsed.ok) return jsonError(400, 'invalid_input', parsed.message);

  const provider = await updateProvider(providerId, parsed.data);
  if (provider === null) return jsonError(404, 'not_found', '服务商不存在');
  return jsonOk({ provider });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const providerId = parseId((await context.params).id);
  if (providerId === null) return jsonError(400, 'invalid_input', 'id 必须是正整数');

  const removed = await deleteProvider(providerId);
  if (!removed) return jsonError(404, 'not_found', '服务商不存在');
  return jsonOk({ ok: true });
}
