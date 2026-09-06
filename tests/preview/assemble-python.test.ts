import { describe, expect, it } from 'vitest';
import type { StorageProvider } from '@/lib/db/provider/types';
import { assemblePreview, PREVIEW_INDEX_PATH } from '@/lib/preview/assemble';
import { renderApiPy } from '@/lib/agents/roles/samples/app-skeleton';

function fakeStorage(files: Record<string, string>): StorageProvider {
  return {
    getFile: async (_id: number, p: string) => (Object.prototype.hasOwnProperty.call(files, p) ? { content: files[p] } : null),
  } as unknown as StorageProvider;
}

describe('Python 项目预览全链路', () => {
  it('api.py 落库 → 装配注入 pyodide + 适配器 + lazy 拦截器；CSP 增量合成', async () => {
    const files = {
      [PREVIEW_INDEX_PATH]: '<html><head></head><body><div id="app"></div></body></html>',
      'app/backend/api.py': renderApiPy(['/api/todos']),
    };
    const result = await assemblePreview(fakeStorage(files), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('cdn.jsdelivr.net/pyodide/');
    expect(result.html).toContain('_atoms_handle');
    expect(result.csp).toContain("'wasm-unsafe-eval'");
    expect(result.csp).toContain('connect-src https://cdn.jsdelivr.net');
    expect(result.csp).not.toContain("connect-src 'none'");
  });

  it('api.py 含 eval → 校验层 hard 拦截（落库前把关）', async () => {
    const { validateFile } = await import('@/lib/validation');
    const v = validateFile('app/backend/api.py', 'x = eval("1")\n' + renderApiPy(['/api/todos']));
    expect(v.hard.some((d) => d.rule === 'py_exec')).toBe(true);
  });
});
