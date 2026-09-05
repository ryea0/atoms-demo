/**
 * 校验与安全层测试（DESIGN §5③ 危险 API AST 扫描 + rules/07 生成物安全）：
 * 语法校验（js/json/html 粗检）、危险 API 扫描的 hard/soft 语义、
 * 解析失败时的正则兜底、以及 validateFile 的最终裁决（ok = 无 hard 且无语法错误）。
 * 本层为纯函数：path + content 进，verdict 出，不触 db。
 */
import { describe, expect, it } from 'vitest';
import { renderApiJs, renderIndexHtml } from '@/lib/agents/roles/samples/app-skeleton';
import { checkSyntax, scanDanger, validateFile } from '@/lib/validation';

/** 极简合法 HTML 骨架（供拼接 inline script 用） */
function html(body: string): string {
  return `<!DOCTYPE html>\n<html lang="zh-CN">\n<head><title>t</title></head>\n<body>\n${body}\n</body>\n</html>`;
}

describe('checkSyntax', () => {
  it('合法 JS 放行', () => {
    const r = checkSyntax('app/frontend/main.js', 'const a = 1;\nconsole.log(a);');
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it('坏 JS（function{）报语法错误', () => {
    const r = checkSyntax('app/frontend/main.js', 'function{');
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('坏 JSON 报语法错误，合法 JSON 放行', () => {
    expect(checkSyntax('config.json', '{ "a": }').ok).toBe(false);
    expect(checkSyntax('config.json', '{ "a": 1 }').ok).toBe(true);
  });

  it('正常 index.html 放行', () => {
    const r = checkSyntax(
      'app/frontend/index.html',
      html('<script>const x = 1;</script>'),
    );
    expect(r.ok).toBe(true);
  });

  it('html 缺 <html 判为语法错误', () => {
    const r = checkSyntax('app/frontend/index.html', '<body><p>hi</p></body>');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('html');
  });

  it('html 未闭合的 <script> 判为语法错误', () => {
    const r = checkSyntax('app/frontend/index.html', html('<script>const x = 1;'));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('script');
  });

  it('.md/.mjs/.sh 等文本类放行（内容不参与语法判定）', () => {
    expect(checkSyntax('docs/readme.md', '# 标题 `function{`').ok).toBe(true);
    expect(checkSyntax('app/backend/api.mjs', 'export default 1;').ok).toBe(true);
    expect(checkSyntax('scripts/setup.sh', 'echo hi').ok).toBe(true);
    expect(checkSyntax('app/frontend/style.css', 'body { color: red; }').ok).toBe(true);
  });
});

describe('scanDanger：hard 规则', () => {
  it('eval → hard', () => {
    const ds = scanDanger('app/frontend/main.js', "const r = eval('1+1');");
    expect(ds.filter((d) => d.severity === 'hard').map((d) => d.rule)).toContain('eval');
  });

  it('window.eval 变体 → hard', () => {
    const ds = scanDanger('app/frontend/main.js', 'window.eval("x");');
    expect(ds.some((d) => d.rule === 'eval' && d.severity === 'hard')).toBe(true);
  });

  it('new Function → hard', () => {
    const ds = scanDanger('app/frontend/main.js', 'const f = new Function("return 1");');
    expect(ds.some((d) => d.rule === 'new_function' && d.severity === 'hard')).toBe(true);
  });

  it('setTimeout 字符串首参 → hard，函数首参不报', () => {
    const bad = scanDanger('app/frontend/main.js', "setTimeout('doIt()', 100);");
    expect(bad.some((d) => d.rule === 'timer_string' && d.severity === 'hard')).toBe(true);

    const good = scanDanger('app/frontend/main.js', 'setTimeout(() => doIt(), 100);');
    expect(good.filter((d) => d.rule === 'timer_string')).toHaveLength(0);
  });

  it('postMessage 到 parent/top → hard（targetOrigin 为 * 亦命中）', () => {
    const ds = scanDanger(
      'app/frontend/main.js',
      "parent.postMessage({ type: 'ping' }, '*');",
    );
    expect(ds.some((d) => d.rule === 'post_message_parent' && d.severity === 'hard')).toBe(true);

    const dsTop = scanDanger(
      'app/frontend/main.js',
      "window.top.postMessage('x', '*');",
    );
    expect(dsTop.some((d) => d.rule === 'post_message_parent')).toBe(true);
  });

  it('普通 postMessage（无 parent/top 语义）不报', () => {
    const ds = scanDanger(
      'app/frontend/main.js',
      "worker.postMessage('x', '*');",
    );
    expect(ds.filter((d) => d.rule === 'post_message_parent')).toHaveLength(0);
  });

  it('html 外链 script 非白名单 → hard；cdn.tailwindcss.com 白名单与相对路径不报', () => {
    const bad = scanDanger(
      'app/frontend/index.html',
      html('<script src="http://evil.com/x.js"></script>'),
    );
    expect(bad.some((d) => d.rule === 'external_script' && d.severity === 'hard')).toBe(true);

    const okHtml = html(
      '<script src="https://cdn.tailwindcss.com"></script>\n<script src="app.js"></script>',
    );
    expect(scanDanger('app/frontend/index.html', okHtml).filter((d) => d.rule === 'external_script'))
      .toHaveLength(0);
  });
});

describe('scanDanger：soft 规则', () => {
  it('while(true) 无 break → soft', () => {
    const ds = scanDanger('app/frontend/main.js', 'while (true) { tick(); }');
    expect(ds.some((d) => d.rule === 'infinite_loop' && d.severity === 'soft')).toBe(true);
  });

  it('while(true) 内含 break 不报', () => {
    const ds = scanDanger(
      'app/frontend/main.js',
      'while (true) { if (done) { break; } tick(); }',
    );
    expect(ds.filter((d) => d.rule === 'infinite_loop')).toHaveLength(0);
  });

  it('fetch 外部地址 → soft，/api/ 前缀与非字面量参数不报', () => {
    const ext = scanDanger('app/frontend/main.js', 'fetch("https://x.com/api").then(r => r);');
    expect(ext.some((d) => d.rule === 'external_fetch' && d.severity === 'soft')).toBe(true);

    const internal = scanDanger('app/frontend/main.js', "fetch('/api/todos');");
    expect(internal.filter((d) => d.rule === 'external_fetch')).toHaveLength(0);

    const dynamic = scanDanger('app/frontend/main.js', "fetch(base + '/x');");
    expect(dynamic.filter((d) => d.rule === 'external_fetch')).toHaveLength(0);
  });

  it('html 内联脚本中的 while(true)/外部 fetch 同样报 soft，且不因双通道重复计数', () => {
    const ds = scanDanger(
      'app/frontend/index.html',
      html('<script>while (true) { tick(); }</script>'),
    );
    const loops = ds.filter((d) => d.rule === 'infinite_loop');
    expect(loops).toHaveLength(1);
    expect(loops[0]?.severity).toBe('soft');
  });
});

describe('scanDanger：范围与兜底', () => {
  it('坏 JS 解析失败仍退回正则粗扫（不因语法错误漏检 eval）', () => {
    const ds = scanDanger('app/frontend/main.js', "function{ eval('x') }");
    expect(ds.some((d) => d.rule === 'eval' && d.severity === 'hard')).toBe(true);
  });

  it('.md/.sh/.json 不做 AST 危险扫描（文档/数据中的 eval 字样不报）', () => {
    expect(scanDanger('docs/readme.md', "eval('x')")).toHaveLength(0);
    expect(scanDanger('scripts/setup.sh', 'eval "x"')).toHaveLength(0);
  });

  it('html 内联脚本走 AST（字符串 setTimeout 命中 hard）', () => {
    const ds = scanDanger(
      'app/frontend/index.html',
      html("<script>setTimeout('boot()', 0);</script>"),
    );
    expect(ds.some((d) => d.rule === 'timer_string' && d.severity === 'hard')).toBe(true);
  });

  it('多规则同文件同时命中（eval + new Function + 死循环 + 外部 fetch）', () => {
    const ds = scanDanger(
      'app/frontend/main.js',
      [
        "eval('1');",
        'const f = new Function("return 2");',
        'while (true) { pump(); }',
        'fetch("https://x.com");',
      ].join('\n'),
    );
    const rules = new Set(ds.map((d) => d.rule));
    expect(rules).toContain('eval');
    expect(rules).toContain('new_function');
    expect(rules).toContain('infinite_loop');
    expect(rules).toContain('external_fetch');
    expect(ds.find((d) => d.rule === 'eval')?.severity).toBe('hard');
    expect(ds.find((d) => d.rule === 'infinite_loop')?.severity).toBe('soft');
  });
});

describe('validateFile', () => {
  it('干净文件：ok=true 且 hard/soft 为空', () => {
    const r = validateFile('app/frontend/main.js', "fetch('/api/todos');");
    expect(r.ok).toBe(true);
    expect(r.hard).toHaveLength(0);
    expect(r.soft).toHaveLength(0);
    expect(r.syntaxError).toBeUndefined();
  });

  it('仅有 soft 警告不拦截（ok 仍为 true）', () => {
    const r = validateFile('app/frontend/main.js', 'while (true) { pump(); }');
    expect(r.ok).toBe(true);
    expect(r.soft).toHaveLength(1);
    expect(r.hard).toHaveLength(0);
  });

  it('命中 hard → ok=false，且 hard/soft 正确分流', () => {
    const r = validateFile(
      'app/frontend/main.js',
      ["eval('1');", 'while (true) {}'].join('\n'),
    );
    expect(r.ok).toBe(false);
    expect(r.hard.map((d) => d.rule)).toContain('eval');
    expect(r.soft.map((d) => d.rule)).toContain('infinite_loop');
  });

  it('语法错误 → ok=false（坏 JS），同时保留正则兜底的 hard', () => {
    const r = validateFile('app/frontend/main.js', "function{ eval('x') }");
    expect(r.ok).toBe(false);
    expect(r.syntaxError).toBeTruthy();
    expect(r.hard.map((d) => d.rule)).toContain('eval');
  });

  it('语法错误（坏 JSON）→ ok=false', () => {
    const r = validateFile('app/filetree.json', '{ nope }');
    expect(r.ok).toBe(false);
    expect(r.syntaxError).toBeTruthy();
  });

  it('正常 index.html → ok=true', () => {
    const r = validateFile(
      'app/frontend/index.html',
      html('<script src="https://cdn.tailwindcss.com"></script><script>init();</script>'),
    );
    expect(r.ok).toBe(true);
  });
});

describe('黄金样例回归（校验层不得误伤 mock/seed 流水线的正常产物）', () => {
  it('样例 index.html 与 api.js 均无 hard、无语法错误', () => {
    const htmlVerdict = validateFile('app/frontend/index.html', renderIndexHtml('待办应用', ['/api/todos']));
    const apiVerdict = validateFile('app/backend/api.js', renderApiJs(['/api/todos']));
    expect(htmlVerdict.hard).toHaveLength(0);
    expect(htmlVerdict.syntaxError).toBeUndefined();
    expect(htmlVerdict.ok).toBe(true);
    expect(apiVerdict.hard).toHaveLength(0);
    expect(apiVerdict.syntaxError).toBeUndefined();
    expect(apiVerdict.ok).toBe(true);
  });
});
