import { describe, expect, it } from 'vitest';
import { renderApiTs } from '@/lib/agents/roles/samples/app-skeleton';
import { typescriptProfile } from '@/lib/languages/profiles/typescript';

describe('TS 后端骨架', () => {
  it('导出带类型的 handle；过 TS 档案校验（转译 + acorn + 危险扫描全绿）', () => {
    const src = renderApiTs(['/api/todos']);
    expect(src).toContain('export function handle(method: string, path: string, body: unknown)');
    expect(typescriptProfile.checkSyntax('app/backend/api.ts', src).ok).toBe(true);
    expect(typescriptProfile.scanDanger('app/backend/api.ts', src)).toEqual([]);
  });
});
