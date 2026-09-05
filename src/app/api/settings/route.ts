/**
 * /api/settings（Task 23）：session 级个人偏好读写（DESIGN §3.9/§4.2）。
 * GET：读偏好（无记录回默认值）；PUT：局部补丁合并落库（缺省键 = 不改既有值）。
 * 匿名会话即作用域：新访客由响应 Set-Cookie 下发 atoms_session（rules/07）。
 */
import { applySessionCookie, internalError } from '@/lib/api/route-support';
import { resolveSession } from '@/lib/session';
import { getPreferences, savePreferences } from '@/lib/settings/service';
import { jsonError, jsonOk, parseWith, readJsonBody } from '@/lib/settings/http';
import { preferencesPutSchema } from '@/lib/settings/validation';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const session = resolveSession(request);
    const preferences = await getPreferences(session.sessionId);
    return applySessionCookie(jsonOk({ preferences }), session);
  } catch (error) {
    return internalError(error);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = resolveSession(request);
    const parsed = parseWith(preferencesPutSchema, await readJsonBody(request));
    if (!parsed.ok) return jsonError(400, 'invalid_input', parsed.message);

    const preferences = await savePreferences(session.sessionId, parsed.data);
    return applySessionCookie(jsonOk({ preferences }), session);
  } catch (error) {
    return internalError(error);
  }
}
