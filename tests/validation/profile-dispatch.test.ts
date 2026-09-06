import { describe, expect, it } from 'vitest';
import { validateFile } from '@/lib/validation';

describe('validateFile 按语言档案分派', () => {
  it('.ts 语法错被拦（转译链路生效）', () => {
    const v = validateFile('app/backend/api.ts', 'function handle( {');
    expect(v.ok).toBe(false);
    expect(v.syntaxError).toContain('TypeScript');
  });

  it('.ts 的 eval 拦截（hard）', () => {
    // brief 原文为裸引用 `const f: any = eval;`（非调用，扫描器按设计不拦）；
    // 对齐用例自述意图「eval 调用拦截不因 TS 语法漏检」改用真实调用（同 T4 用例）
    const v = validateFile('app/backend/api.ts', 'const x: unknown = eval("1"); export function handle(){ return {code:200}; }');
    expect(v.hard.some((d) => d.rule === 'eval')).toBe(true);
    expect(v.ok).toBe(false);
  });

  it('.js/.html 行为不变（原路径）', () => {
    expect(validateFile('app/backend/api.js', 'module.exports={handle(){}}').ok).toBe(true);
    expect(validateFile('app/frontend/index.html', '<html><script>eval("1")</script></html>').ok).toBe(false);
    expect(validateFile('app/README.md', '任意文本').ok).toBe(true);
  });
});
