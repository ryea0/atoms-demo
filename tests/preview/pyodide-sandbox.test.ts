import { describe, expect, it } from 'vitest';
import { browserPyodideSandbox } from '@/lib/preview/sandbox/browser-pyodide';
import type { LanguageProfile } from '@/lib/languages/types';
import { pythonProfile } from '@/lib/languages';

const INDEX = '<html><head></head><body></body></html>';
const API_PY = 'def handle(method, path, body):\n    return {"code": 200, "data": []}\n';

function input(source: string | null): { indexHtml: string; backendSource: string | null; profile: LanguageProfile } {
  return { indexHtml: INDEX, backendSource: source, profile: pythonProfile };
}

describe('pyodide 沙箱装配', () => {
  it('注入 loader + 源码 + 信封适配器 + lazy 拦截器；CSP 增量正确', () => {
    const out = browserPyodideSandbox.assemble(input(API_PY));
    expect(out.html).toContain('https://cdn.jsdelivr.net/pyodide/');
    expect(out.html).toContain('pyodide.js"></script>');
    expect(out.html).toContain('_atoms_handle');
    expect(out.html).toContain('__ATOMS_BOOT_READY__');
    expect(out.html).toContain('loadPyodide');
    // JSON 字符串字面量内联 python 源码
    expect(out.html).toContain(JSON.stringify(API_PY).slice(0, 20));
    expect(out.cspExtras).toEqual({
      scriptSrc: ['https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"],
      connectSrc: ['https://cdn.jsdelivr.net'],
    });
  });

  it('源码含 </script> 时转义；缺后端 → 无 boot 块（拦截器 503 兜底）', () => {
    const tricky = 's = "</script>"\n' + API_PY;
    const out = browserPyodideSandbox.assemble(input(tricky));
    expect(out.html).toContain('<\\/script>');
    const empty = browserPyodideSandbox.assemble(input(null));
    // 负断言锚定「赋值」形态：拦截器只*读取* __ATOMS_BOOT_READY__/__ATOMS_BACKEND__，boot 块才会*赋值*
    expect(empty.html).not.toContain('__ATOMS_BOOT_READY__=');
    expect(empty.html).not.toContain('__ATOMS_BACKEND__='); // 不装后端包装
    expect(empty.html).toContain('handleOf()');
  });

  it('boot 失败渲染中文横幅（spec 修订：iframe 内无法发 SSE，横幅 + 500 信封兜底）', () => {
    const out = browserPyodideSandbox.assemble(input(API_PY));
    expect(out.html).toContain('Python 后端启动失败');
    expect(out.html).toContain('DOMContentLoaded');
  });
});
