/**
 * 服务端 session cookie 序列化测试（公网 IP HTTP 部署配套）。
 *
 * sessionCookieHeader 在 NODE_ENV=production 追加 Secure（rules/07「会话」）；
 * 无域名/无法上 HTTPS 的 demo 部署（裸 IP http://）下浏览器会丢弃 Secure cookie，
 * 因此提供 COOKIE_SECURE=false 显式降级开关——仅演示用途，默认行为不变。
 */
import { describe, expect, it } from 'vitest';
import { sessionCookieHeader } from '@/lib/session';

describe('sessionCookieHeader Secure 开关', () => {
  it('生产默认追加 Secure（rules/07 基线不变）', () => {
    const header = sessionCookieHeader('01234567-89ab-cdef-0123-456789abcdef', { NODE_ENV: 'production' });
    expect(header).toContain('Secure');
  });

  it('生产 + COOKIE_SECURE=false → 不带 Secure（裸 IP http demo 部署）', () => {
    const header = sessionCookieHeader('01234567-89ab-cdef-0123-456789abcdef', {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
    });
    expect(header).not.toContain('Secure');
  });

  it('开发环境不追加 Secure（原有行为）', () => {
    const header = sessionCookieHeader('01234567-89ab-cdef-0123-456789abcdef', { NODE_ENV: 'development' });
    expect(header).not.toContain('Secure');
  });

  it('COOKIE_SECURE 非 "false" 字面量不降级（防误配宽进）', () => {
    const header = sessionCookieHeader('01234567-89ab-cdef-0123-456789abcdef', {
      NODE_ENV: 'production',
      COOKIE_SECURE: '0',
    });
    expect(header).toContain('Secure');
  });

  it('其余 cookie 属性完整（HttpOnly/SameSite=Lax/Path/Max-Age）', () => {
    const header = sessionCookieHeader('01234567-89ab-cdef-0123-456789abcdef', {
      NODE_ENV: 'production',
      COOKIE_SECURE: 'false',
    });
    expect(header).toContain('atoms_session=01234567-89ab-cdef-0123-456789abcdef');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).toContain('Max-Age=');
  });
});
