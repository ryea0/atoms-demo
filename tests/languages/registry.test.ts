import { describe, expect, it } from 'vitest';
import { LANGUAGE_PROFILES, defaultLanguageProfile, resolveProfileByExtension, resolveProfileByPaths } from '@/lib/languages';
import { javascriptProfile } from '@/lib/languages/profiles/javascript';

describe('语言注册表', () => {
  it('js 后缀解析到 javascript 档案（入口/运行时/契约段就位）', () => {
    const p = resolveProfileByExtension('js');
    expect(p?.id).toBe('javascript');
    expect(p?.backendEntryPath).toBe('app/backend/api.js');
    expect(p?.runtime).toBe('browser-js');
    expect(p?.engineerContract.join('\n')).toContain('module.exports = { handle }');
  });

  it('未注册后缀返回 null（html/md 等非后端语言）', () => {
    expect(resolveProfileByExtension('html')).toBeNull();
    expect(resolveProfileByExtension('')).toBeNull();
  });

  it('缺省回退 javascript；注册表以 js 打头（存量项目探测兼容）', () => {
    expect(defaultLanguageProfile()).toBe(javascriptProfile);
    expect(LANGUAGE_PROFILES[0]).toBe(javascriptProfile);
  });

  it('按路径集合判定项目语言（入口在册即中，无 → 默认 js）', () => {
    expect(resolveProfileByPaths(['app/frontend/index.html', 'app/backend/api.js']).id).toBe('javascript');
    expect(resolveProfileByPaths(['app/frontend/index.html']).id).toBe('javascript');
  });

  it('build 恒等（js 无构建步骤）', () => {
    const files = new Map([['app/backend/api.js', 'module.exports={handle(){}}']]);
    expect(javascriptProfile.build(files)).toEqual(files);
  });

  it('checkSyntax/scanDanger 委托现有校验层', () => {
    expect(javascriptProfile.checkSyntax('a.js', 'const x =').ok).toBe(false);
    expect(javascriptProfile.scanDanger('a.js', 'eval("1")')[0]?.rule).toBe('eval');
  });
});
