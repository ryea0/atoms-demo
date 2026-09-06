import { describe, expect, it } from 'vitest';
import { transpileBackend, typescriptProfile } from '@/lib/languages/profiles/typescript';

const GOOD_TS = [
  'type Envelope = { code: number; data?: unknown; message?: string };',
  'export function handle(method: string, path: string, body: unknown): Envelope {',
  '  return { code: 200, data: [] };',
  '}',
].join('\n');

describe('typescript 档案', () => {
  it('转译产出 CommonJS（exports.handle，预览垫片与 __atoms runner 消费同一产物）', () => {
    const js = transpileBackend(GOOD_TS);
    expect(js).toContain('exports.handle');
    expect(js).not.toContain(': string');
  });

  it('checkSyntax：合法 TS 通过；语法错误给出中文报告（进重试链）', () => {
    expect(typescriptProfile.checkSyntax('api.ts', GOOD_TS).ok).toBe(true);
    const bad = typescriptProfile.checkSyntax('api.ts', 'function handle( {');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('TypeScript');
  });

  it('scanDanger 在转译产物上扫（eval 调用拦截不因 TS 语法漏检）', () => {
    const dangers = typescriptProfile.scanDanger('api.ts', 'const x: unknown = eval("1");\nexport function handle(){ return {code:200}; }');
    expect(dangers.some((d) => d.rule === 'eval' && d.severity === 'hard')).toBe(true);
  });

  it('build：map 内 .ts 条目被转译、其余恒等；契约段指向 api.ts', () => {
    const out = typescriptProfile.build(new Map([['app/backend/api.ts', GOOD_TS], ['app/README.md', '# x']]));
    expect(out.get('app/backend/api.ts')).toContain('exports.handle');
    expect(out.get('app/README.md')).toBe('# x');
    expect(typescriptProfile.backendEntryPath).toBe('app/backend/api.ts');
    expect(typescriptProfile.engineerContract.join('\n')).toContain('export function handle(method: string');
  });
});
