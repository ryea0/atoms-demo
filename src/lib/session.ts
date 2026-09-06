/**
 * 匿名会话（Task 16，DESIGN §4.2 / .claude/rules/07「会话」）。
 *
 * 无登录体系：每个访客一个随机 uuid session id；项目归属即 session 匹配
 * （他人 id 一律 404，不区分「不存在」与「无权」）。
 *
 * cookie 约定：atoms_session；httpOnly + SameSite=Lax + Path=/，生产追加 Secure。
 * Route Handler 内无法用 next/cookies 写 cookie（且直调测试只认响应头），
 * 统一走响应头 Set-Cookie（applySessionCookie）。
 */

/** 会话 cookie 名（前后端契约，勿改） */
export const SESSION_COOKIE = 'atoms_session';

/** 会话有效期 30 天：过期即视为新访客，旧项目对其不可见 */
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** 合法 session id 形状（uuid v4）；非法值一律视为无会话（防伪造/注入） */
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 会话解析结果：isNew=true 表示本次请求新发了一个 session id（响应需 Set-Cookie） */
export interface ResolvedSession {
  sessionId: string;
  isNew: boolean;
}

/** 生成新 session id（uuid v4） */
export function newSessionId(): string {
  return crypto.randomUUID();
}

/** 从请求 Cookie 头里取 atoms_session 值（缺失/非法返回 null） */
function cookieValue(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${SESSION_COOKIE}=`)) {
      try {
        return decodeURIComponent(trimmed.slice(SESSION_COOKIE.length + 1));
      } catch {
        return null; // 畸形编码按无会话处理
      }
    }
  }
  return null;
}

/** 解析请求会话：已有合法 cookie 则复用，否则新建（调用方需在响应上补 Set-Cookie） */
export function resolveSession(request: Request): ResolvedSession {
  const existing = cookieValue(request);
  if (existing !== null && SESSION_ID_PATTERN.test(existing)) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: newSessionId(), isNew: true };
}

/**
 * 序列化 Set-Cookie 值（secure 仅生产——本地 http 下 Secure 会让 cookie 被浏览器丢弃）。
 *
 * COOKIE_SECURE=false 显式降级开关：无域名/无法上 HTTPS 的裸 IP http demo 部署用
 * （生产默认仍带 Secure；仅字面量 "false" 生效，防误配宽进）。
 */
export function sessionCookieHeader(sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  const attrs = [
    `${SESSION_COOKIE}=${sessionId}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (env.NODE_ENV === 'production' && env.COOKIE_SECURE !== 'false') attrs.push('Secure');
  return attrs.join('; ');
}

/** 新会话时给响应补 Set-Cookie；已有会话原样返回（幂等，不重复下发） */
export function applySessionCookie<T extends Response>(response: T, session: ResolvedSession): T {
  if (session.isNew) {
    response.headers.append('Set-Cookie', sessionCookieHeader(session.sessionId));
  }
  return response;
}
