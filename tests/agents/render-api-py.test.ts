import { describe, expect, it } from 'vitest';
import { renderApiPy } from '@/lib/agents/roles/samples/app-skeleton';
import { pythonProfile } from '@/lib/languages';

describe('Python 后端骨架', () => {
  it('def handle + REST 信封；过 python 档案危险扫描（零 hard）', () => {
    const src = renderApiPy(['/api/todos']);
    expect(src).toContain('def handle(method, path, body):');
    expect(src).toContain('"code": 404');
    expect(pythonProfile.scanDanger('app/backend/api.py', src).filter((d) => d.severity === 'hard')).toEqual([]);
  });
});
