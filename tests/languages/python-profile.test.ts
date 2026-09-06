import { describe, expect, it } from 'vitest';
import { pythonProfile } from '@/lib/languages/profiles/python';

describe('python 档案', () => {
  it('语法校验降级放行（spec §2.2：无可靠纯 JS 解析器；真校验靠预览 boot 与 py_compile 自检）', () => {
    expect(pythonProfile.checkSyntax('api.py', 'def broken(:').ok).toBe(true);
  });

  it('危险规则 hard：eval/exec/__import__/os.system/subprocess/import socket', () => {
    const cases: Array<[string, string]> = [
      ['api.py', 'x = eval("1+1")'],
      ['api.py', 'exec(code)'],
      ['api.py', '__import__("os")'],
      ['api.py', 'os.system("ls")'],
      ['api.py', 'import subprocess'],
      ['api.py', 'import socket'],
    ];
    for (const [path, content] of cases) {
      expect(pythonProfile.scanDanger(path, content).some((d) => d.severity === 'hard'), content).toBe(true);
    }
  });

  it('危险规则 soft：requests/urllib（Pyodide 内不可用，生成即废）；.py 以外不扫', () => {
    const soft = pythonProfile.scanDanger('api.py', 'import requests');
    expect(soft.some((d) => d.rule === 'py_net_import' && d.severity === 'soft')).toBe(true);
    expect(pythonProfile.scanDanger('a.js', 'import socket')).toEqual([]);
  });

  it('契约段与自检行指向 python 语义', () => {
    expect(pythonProfile.engineerContract.join('\n')).toContain('def handle(method, path, body)');
    expect(pythonProfile.selfCheckHint).toContain('python3 -m py_compile');
    expect(pythonProfile.runtime).toBe('browser-pyodide');
    expect(pythonProfile.backendEntryPath).toBe('app/backend/api.py');
  });
});
