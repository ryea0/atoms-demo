import { describe, expect, it } from 'vitest';
import type { StorageProvider } from '@/lib/db/provider/types';
import { assemblePreview, PREVIEW_CSP, PREVIEW_INDEX_PATH } from '@/lib/preview/assemble';
import { renderApiTs } from '@/lib/agents/roles/samples/app-skeleton';

function fakeStorage(files: Record<string, string>): StorageProvider {
  return {
    getFile: async (_id: number, p: string) => (Object.prototype.hasOwnProperty.call(files, p) ? { content: files[p] } : null),
  } as unknown as StorageProvider;
}

describe('TS 项目预览全链路', () => {
  it('api.ts 落库 → 装配输出含转译后端（exports.handle 进垫片）；CSP 无增量', async () => {
    const files = {
      [PREVIEW_INDEX_PATH]: '<html><head></head><body><div id="app"></div></body></html>',
      'app/backend/api.ts': renderApiTs(['/api/todos']),
    };
    const result = await assemblePreview(fakeStorage(files), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('exports.handle');
    expect(result.html).not.toContain('export function handle');
    expect(result.csp).toBe(PREVIEW_CSP);
    expect(result.html).toContain('__ATOMS_BACKEND__');
  });
});
