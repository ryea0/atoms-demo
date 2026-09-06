import { describe, expect, it } from 'vitest';
import { buildFastFileTree, pickLanguage } from '@/lib/agents/roles/engineer';

describe('语言选型', () => {
  it('关键词确定性：typescript/python 全称或缩写（含中文紧邻场景）', () => {
    expect(pickLanguage('用 TypeScript 写个待办')).toBe('typescript');
    expect(pickLanguage('用TS写个待办')).toBe('typescript');
    expect(pickLanguage('用 Python 写个待办')).toBe('python');
    expect(pickLanguage('用py写个看板')).toBe('python');
    expect(pickLanguage('写个待办清单')).toBe('javascript');
    expect(pickLanguage('its been a while')).toBe('javascript'); // 误报护栏：its ≠ ts
  });

  it('快速模式文件树：python 需求 → 入口 api.py；默认 → api.js（存量不变）', () => {
    const pyTree = buildFastFileTree('用 Python 写个待办清单');
    expect(pyTree[0]?.path).toBe('app/backend/api.py');
    const jsTree = buildFastFileTree('写个待办清单');
    expect(jsTree[0]?.path).toBe('app/backend/api.js');
    expect(jsTree.map((n) => n.path)).toEqual(['app/backend/api.js', 'app/frontend/index.html', 'app/README.md', 'start_app.sh']);
  });
});
