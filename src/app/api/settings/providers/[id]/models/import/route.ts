/**
 * /api/settings/providers/[id]/models/import（Task 24 / P3.5）
 * POST：探测该服务商 /models 并按 model_id 去重落库 llm_models，回 {discovered, imported, skipped}。
 * 探测失败 → 502（错误已脱敏）；provider 不存在 → 404。
 */
import { importProviderModels } from '@/lib/settings/service';
import { jsonError, jsonOk, parseId } from '@/lib/settings/http';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const providerId = parseId((await context.params).id);
  if (providerId === null) return jsonError(400, 'invalid_input', 'id 必须是正整数');

  const outcome = await importProviderModels(providerId);
  if (outcome.ok) return jsonOk({ import: outcome.result });
  if (outcome.reason === 'not_found') return jsonError(404, 'not_found', '服务商不存在');
  return jsonError(502, 'probe_failed', outcome.error);
}
