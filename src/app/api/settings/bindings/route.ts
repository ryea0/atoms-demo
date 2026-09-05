/**
 * /api/settings/bindings（Task 24 / P3.5）
 * GET：7 角色绑定视图（恒齐全）；PUT：保存/清除某角色绑定——
 * providerId+modelId 齐全 = 绑定，任一缺失 = 清除（跟随全局默认，resolveRoleModel 回退 env）。
 */
import { listBindingViews, putBinding } from '@/lib/settings/service';
import { jsonError, jsonOk, parseWith, readJsonBody } from '@/lib/settings/http';
import { bindingPutSchema } from '@/lib/settings/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return jsonOk({ bindings: await listBindingViews() });
}

export async function PUT(request: Request): Promise<Response> {
  const parsed = parseWith(bindingPutSchema, await readJsonBody(request));
  if (!parsed.ok) return jsonError(400, 'invalid_input', parsed.message);

  const outcome = await putBinding(parsed.data);
  if (!outcome.ok) return jsonError(400, outcome.reason, outcome.message);
  return jsonOk({ binding: outcome.binding });
}
