/**
 * /api/settings/providers（Task 24 / P3.5）
 * GET：服务商列表 + 全量模型清单（设置页一次取齐）；POST：新增服务商。
 * api_key 只写不读：响应只带脱敏尾 4 位（.claude/rules/07）。
 */
import { createProvider, listModelViews, listProviderViews } from '@/lib/settings/service';
import { jsonError, jsonOk, parseWith, readJsonBody } from '@/lib/settings/http';
import { providerCreateSchema } from '@/lib/settings/validation';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const [providers, models] = await Promise.all([listProviderViews(), listModelViews()]);
  return jsonOk({ providers, models });
}

export async function POST(request: Request): Promise<Response> {
  const parsed = parseWith(providerCreateSchema, await readJsonBody(request));
  if (!parsed.ok) return jsonError(400, 'invalid_input', parsed.message);
  const provider = await createProvider(parsed.data);
  return jsonOk({ provider }, 201);
}
