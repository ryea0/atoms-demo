/**
 * /api/settings/models/[id]（Task 24 / P3.5）
 * PATCH：改显示名/单价/启用态（单价用于 llm_calls 成本核算，DESIGN §5③）；DELETE：删除模型。
 */
import { deleteModel, updateModel } from '@/lib/settings/service';
import { jsonError, jsonOk, parseId, parseWith, readJsonBody } from '@/lib/settings/http';
import { modelPatchSchema } from '@/lib/settings/validation';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const modelId = parseId((await context.params).id);
  if (modelId === null) return jsonError(400, 'invalid_input', 'id 必须是正整数');

  const parsed = parseWith(modelPatchSchema, await readJsonBody(request));
  if (!parsed.ok) return jsonError(400, 'invalid_input', parsed.message);

  const model = await updateModel(modelId, parsed.data);
  if (model === null) return jsonError(404, 'not_found', '模型不存在');
  return jsonOk({ model });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const modelId = parseId((await context.params).id);
  if (modelId === null) return jsonError(400, 'invalid_input', 'id 必须是正整数');

  const removed = await deleteModel(modelId);
  if (!removed) return jsonError(404, 'not_found', '模型不存在');
  return jsonOk({ ok: true });
}
