# 多语言支持（TS + Python 垂直切片）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 平台支持生成并运行 TypeScript 与 Python 后端（TS 服务端转译走现有 JS 管线、Python 走 Pyodide 浏览器内运行），语言维度抽象为 LanguageProfile + PreviewSandboxProvider 双注册表。

**Architecture:** 语言的唯一判定源是后端入口扩展名（`app/backend/api.js|.ts|.py`），零 DB 迁移。`src/lib/languages/` 注册表承载每语言的契约文案/构建变换/校验规则；`src/lib/preview/sandbox/` 兑现 DESIGN §12 的 PreviewSandboxProvider（browser-js = 现状原样搬入，browser-pyodide = Pyodide 桥）。CSP 增量只发生在 Python 预览。

**Tech Stack:** TypeScript strict、vitest（`tests/` 根目录、globals、`@` alias）、typescript 包进程内转译（devDep 现状）、Pyodide v0.26.4（CDN，仅 Python 预览）。

**Spec:** `docs/superpowers/specs/2026-09-06-multi-language-design.md`（执行者需同时读 spec 与本计划）

## Global Constraints

- TypeScript strict；新文件一律 TS；注释与用户可见文案中文、标识符英文。
- 测试：vitest，文件放 `tests/<域>/`；先写失败测试再实现（TDD）。
- **JS 项目行为零变化**：Task 2 的 byte 级回归锁必须全程绿；`PREVIEW_CSP` 基线字符串不动，CSP 只经 `composePreviewCsp` 增量合成。
- 生成物零 npm 依赖；语言判定 = 后端入口扩展名，**不加任何 DB 字段**。
- 校验层保持纯函数（不 spawn 宿主进程；Python 语法校验降级放行是 spec 拍板的取舍）。
- git 纪律：每任务完成且测试绿后 commit，`feat:`/`chore:` 前缀英文 message。
- `typescript` 包按 devDep 现状在服务端进程内使用（spec §2.2 记录的依赖姿态）。
- 一处 spec 修订（Task 13 落地）：spec §7「py 语法错误 → SSE error 事件」在 iframe 隔离（禁 postMessage、connect-src 'none'）下不可达，落地为**预览页中文横幅 + fetch 500 信封**。

---

## P1 抽取层（全仓行为零变化）

### Task 1: LanguageProfile 类型 + javascript 档案 + 注册表

**Files:**
- Create: `src/lib/languages/types.ts`
- Create: `src/lib/languages/profiles/javascript.ts`
- Create: `src/lib/languages/index.ts`
- Test: `tests/languages/registry.test.ts`

**Interfaces:**
- Consumes: `checkSyntax(path, content): SyntaxReport`（`@/lib/validation/syntax`）、`scanDanger(path, content): Danger[]`（`@/lib/validation/danger`）——现有签名不动。
- Produces（后续任务依赖）:
  - `interface LanguageProfile { id; backendExtension: 'js'|'ts'|'py'; backendEntryPath: string; runtime: 'browser-js'|'browser-pyodide'; engineerContract: readonly string[]; selfCheckHint: string; build(files: ReadonlyMap<string,string>): Map<string,string>; checkSyntax(path,content): SyntaxReport; scanDanger(path,content): Danger[] }`
  - `LANGUAGE_PROFILES: readonly LanguageProfile[]`（声明序 = 预览入口探测序，js 打头）
  - `resolveProfileByExtension(ext: string): LanguageProfile | null`
  - `resolveProfileByPaths(paths: Iterable<string>): LanguageProfile`
  - `defaultLanguageProfile(): LanguageProfile`
  - `javascriptProfile: LanguageProfile`

- [ ] **Step 1: 写失败测试**

```ts
// tests/languages/registry.test.ts
import { describe, expect, it } from 'vitest';
import { LANGUAGE_PROFILES, defaultLanguageProfile, resolveProfileByExtension, resolveProfileByPaths } from '@/lib/languages';
import { javascriptProfile } from '@/lib/languages/profiles/javascript';

describe('语言注册表', () => {
  it('js 后缀解析到 javascript 档案（入口/运行时/契约段就位）', () => {
    const p = resolveProfileByExtension('js');
    expect(p?.id).toBe('javascript');
    expect(p?.backendEntryPath).toBe('app/backend/api.js');
    expect(p?.runtime).toBe('browser-js');
    expect(p?.engineerContract.join('\n')).toContain('module.exports = { handle }');
  });

  it('未注册后缀返回 null（html/md 等非后端语言）', () => {
    expect(resolveProfileByExtension('html')).toBeNull();
    expect(resolveProfileByExtension('')).toBeNull();
  });

  it('缺省回退 javascript；注册表以 js 打头（存量项目探测兼容）', () => {
    expect(defaultLanguageProfile()).toBe(javascriptProfile);
    expect(LANGUAGE_PROFILES[0]).toBe(javascriptProfile);
  });

  it('按路径集合判定项目语言（入口在册即中，无 → 默认 js）', () => {
    expect(resolveProfileByPaths(['app/frontend/index.html', 'app/backend/api.js']).id).toBe('javascript');
    expect(resolveProfileByPaths(['app/frontend/index.html']).id).toBe('javascript');
  });

  it('build 恒等（js 无构建步骤）', () => {
    const files = new Map([['app/backend/api.js', 'module.exports={handle(){}}']]);
    expect(javascriptProfile.build(files)).toEqual(files);
  });

  it('checkSyntax/scanDanger 委托现有校验层', () => {
    expect(javascriptProfile.checkSyntax('a.js', 'const x =').ok).toBe(false);
    expect(javascriptProfile.scanDanger('a.js', 'eval("1")')[0]?.rule).toBe('eval');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/languages/registry.test.ts`
Expected: FAIL（模块 `@/lib/languages` 不存在）

- [ ] **Step 3: 实现三个文件**

```ts
// src/lib/languages/types.ts
/**
 * 语言注册表契约（DESIGN §12「语言」扩展点，spec 2026-09-06-multi-language-design）。
 * 语言的唯一判定源 = 后端入口扩展名（app/backend/api.js|.ts|.py）；
 * profile 承载该语言的全部差异面：契约文案、构建变换、校验、运行时。
 * 注意：profiles 只准 import validation 的叶子模块（syntax/danger），不得 import
 * validation/index——index 会反向 import 本注册表，形成环。
 */
import type { Danger } from '@/lib/validation/danger';
import type { SyntaxReport } from '@/lib/validation/syntax';

export type LanguageId = 'javascript' | 'typescript' | 'python';
// 未来接入位：'cpp'（预期 browser-wasm + 服务端编译）、'java'（预期 server-process，需重估安全姿态）
export type PreviewRuntime = 'browser-js' | 'browser-pyodide';

export interface LanguageProfile {
  readonly id: LanguageId;
  readonly backendExtension: 'js' | 'ts' | 'py';
  /** 后端入口约定路径（预览探测与物化投影按它找文件） */
  readonly backendEntryPath: string;
  /** 预览运行时（PreviewSandboxProvider 选型依据） */
  readonly runtime: PreviewRuntime;
  /** 工程师 system prompt【全栈契约】的后端段（第 1 条；前端/UI 条对所有语言共用） */
  readonly engineerContract: readonly string[];
  /** 工程师 prompt 的 bash 自检整行（js 档案 = 现文案逐字，保零变化） */
  readonly selfCheckHint: string;
  /** 预览/物化前的纯函数变换（ts=转译；js/py 恒等） */
  build(files: ReadonlyMap<string, string>): Map<string, string>;
  checkSyntax(path: string, content: string): SyntaxReport;
  scanDanger(path: string, content: string): Danger[];
}
```

```ts
// src/lib/languages/profiles/javascript.ts
/** javascript 档案：现 D2 契约原样搬入（文案逐字取自 roles/engineer.ts 的第 158/166 行） */
import { checkSyntax } from '@/lib/validation/syntax';
import { scanDanger } from '@/lib/validation/danger';
import type { LanguageProfile } from '../types';

export const javascriptProfile: LanguageProfile = {
  id: 'javascript',
  backendExtension: 'js',
  backendEntryPath: 'app/backend/api.js',
  runtime: 'browser-js',
  engineerContract: [
    '1. 后端 app/backend/api.js：无框架同构 CommonJS 模块，必须导出 module.exports = { handle }，其中 handle(method, path, body) 返回 { code, data?, message? }；数据一律存内存数组/对象；禁止任何 fs/net/进程/timer API；REST 语义与正确状态码（200/201/400/404/405）。',
  ],
  selfCheckHint:
    '- 写完 JS 文件后可用 bash 自检：node --check <文件> 验语法、node -e "require + handle 冒烟" 验行为；单任务最多 5 次、每次 ≤30s；不要用 bash 启动长驻服务、安装依赖或改文件（写文件一律走 write_file）。',
  build: (files) => new Map(files),
  checkSyntax: (path, content) => checkSyntax(path, content),
  scanDanger: (path, content) => scanDanger(path, content),
};
```

```ts
// src/lib/languages/index.ts
/**
 * 语言注册表（DESIGN §12「语言」行）：后缀查表 + 路径集合判定 + 缺省回退。
 * 声明序即预览入口探测序——js 打头保证存量项目行为不变；
 * 未知回退 javascript 的先例 = EXEC_PROVIDER 未知值回退 local。
 */
import type { LanguageProfile } from './types';
import { javascriptProfile } from './profiles/javascript';

export type { LanguageProfile, LanguageId, PreviewRuntime } from './types';

export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [javascriptProfile];

const BY_EXTENSION = new Map<string, LanguageProfile>(
  LANGUAGE_PROFILES.map((profile) => [profile.backendExtension, profile]),
);

/** 按后缀查档案；未注册后缀（html/md/css…）返回 null */
export function resolveProfileByExtension(ext: string): LanguageProfile | null {
  return BY_EXTENSION.get(ext.toLowerCase()) ?? null;
}

/** 从文件路径集合判定项目语言（后端入口在册即中；无 → 默认 js） */
export function resolveProfileByPaths(paths: Iterable<string>): LanguageProfile {
  for (const profile of LANGUAGE_PROFILES) {
    for (const path of paths) {
      if (path === profile.backendEntryPath) return profile;
    }
  }
  return defaultLanguageProfile();
}

/** 缺省回退（含未知后缀场景） */
export function defaultLanguageProfile(): LanguageProfile {
  return javascriptProfile;
}

export { javascriptProfile } from './profiles/javascript';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/languages/registry.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: 全量回归 + 提交**

Run: `npx vitest run`（存量测试不受影响——纯新增模块）
```bash
git add src/lib/languages tests/languages
git commit -m "feat: language profile registry with javascript profile"
```

### Task 2: PreviewSandboxProvider 接口 + browser-js 搬入 + CSP 合成器 + byte 级回归锁

**Files:**
- Create: `src/lib/preview/sandbox/types.ts`
- Create: `src/lib/preview/sandbox/browser-js.ts`
- Create: `src/lib/preview/sandbox/index.ts`
- Modify: `src/lib/preview/assemble.ts`（整文件重写为编排器；`assemblePreviewHtml`/垫片/FETCH_SHIM 原样搬去 browser-js.ts）
- Test: `tests/preview/assemble.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LANGUAGE_PROFILES`/`defaultLanguageProfile`。
- Produces（后续任务依赖）:
  - `interface PreviewInput { indexHtml: string; backendSource: string | null; profile: LanguageProfile }`（backendSource 已过 profile.build）
  - `interface PreviewOutput { html: string; cspExtras?: { scriptSrc?: string[]; connectSrc?: string[] } }`
  - `interface PreviewSandboxProvider { kind: 'browser-js' | 'browser-pyodide'; assemble(input: PreviewInput): PreviewOutput }`
  - `getSandbox(runtime: PreviewRuntime): PreviewSandboxProvider`
  - `browserJsSandbox`、browser-js.ts 内导出 `injectIntoHtml(indexHtml, injection): string`（Task 11 复用）
  - `composePreviewCsp(base, extras?): string`
  - `assemblePreview(storage, projectId)` 返回值扩展：`{ ok: true; html: string; csp: string } | { ok: false; reason: 'missing_index' }`
  - `PREVIEW_INDEX_PATH`/`PREVIEW_CSP` 仍在 `@/lib/preview/assemble` 导出（消费方 import 路径不变）

- [ ] **Step 1: 写失败测试（含 byte 级回归锁）**

```ts
// tests/preview/assemble.test.ts
import { describe, expect, it } from 'vitest';
import type { StorageProvider } from '@/lib/db/provider/types';
import { assemblePreview, composePreviewCsp, PREVIEW_CSP, PREVIEW_INDEX_PATH } from '@/lib/preview/assemble';

/** 最小 storage 桩：assemblePreview 只用 getFile */
function fakeStorage(files: Record<string, string>): StorageProvider {
  return {
    getFile: async (_projectId: number, path: string) =>
      Object.prototype.hasOwnProperty.call(files, path) ? { content: files[path] } : null,
  } as unknown as StorageProvider;
}

const INDEX = '<html><head><title>t</title></head><body></body></html>';
const API_JS = 'module.exports={handle:()=>({code:200})};';

/** 现 FETCH_SHIM 逐字节快照（搬动前的真身；改一个字符此测试即红） */
const FETCH_SHIM_LOCK = [
  '(function(){',
  'var backend=window.__ATOMS_BACKEND__;',
  'var handle=(backend&&typeof backend.handle==="function")?backend.handle:null;',
  'var nativeFetch=(typeof window.fetch==="function")?window.fetch.bind(window):null;',
  'function pathOf(input){if(typeof input==="string")return input;if(input&&typeof input.url==="string")return input.url;return String(input);}',
  'function bodyOf(init,input){',
  '  if(init&&typeof init.body!=="undefined"){if(typeof init.body==="string"){try{return JSON.parse(init.body);}catch(e){return init.body;}}return init.body;}',
  '  return null;',
  '}',
  'window.fetch=function(input,init){',
  '  var path=pathOf(input);',
  '  if(path.indexOf("/api/")===0){',
  '    var method=String((init&&init.method)||(input&&input.method)||"GET").toUpperCase();',
  '    var body=bodyOf(init,input);',
  '    return Promise.resolve().then(function(){',
  '      if(handle===null)return{code:503,message:"后端未生成（缺少 app/backend/api.js）"};',
  '      return handle(method,path,body);',
  '    }).then(function(envelope){',
  '      var result=envelope||{};',
  '      var payload=(result.data!==undefined)?result.data:((result.message!==undefined)?result.message:null);',
  '      return new Response(JSON.stringify(payload),{status:Number(result.code)||200,headers:{"Content-Type":"application/json"}});',
  '    }).catch(function(error){',
  '      return new Response(JSON.stringify({message:"后端处理出错："+((error&&error.message)?error.message:String(error))}),{status:500,headers:{"Content-Type":"application/json"}});',
  '    });',
  '  }',
  '  if(nativeFetch===null)return Promise.reject(new Error("非 /api/ 请求且原生 fetch 不可用"));',
  '  return nativeFetch(input,init);',
  '};',
  '})();',
].join('\n');

describe('预览装配（js 项目 byte 级回归）', () => {
  it('完整输出逐字节等于搬动前的构造（backend 包装 + FETCH_SHIM + head 注入点）', async () => {
    const result = await assemblePreview(fakeStorage({ [PREVIEW_INDEX_PATH]: INDEX, 'app/backend/api.js': API_JS }), 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const wrapper = `window.__ATOMS_BACKEND__=(function(){const module={exports:{}};${API_JS};return module.exports;})();`;
    // template 里 src 后自带一个分号：API_JS 以 ; 结尾 → 双分号是预期字节
    const expected = `<html><head><script>\n${wrapper}\n${FETCH_SHIM_LOCK}\n</script><title>t</title></head><body></body></html>`;
    expect(result.html).toBe(expected);
    expect(result.csp).toBe(PREVIEW_CSP);
  });

  it('缺 api.js → 占位分支（只注拦截器）；缺 index.html → missing_index', async () => {
    const placeholder = await assemblePreview(fakeStorage({ [PREVIEW_INDEX_PATH]: INDEX }), 1);
    expect(placeholder.ok && placeholder.html).toBe(`<html><head><script>\n\n${FETCH_SHIM_LOCK}\n</script><title>t</title></head><body></body></html>`);
    const missing = await assemblePreview(fakeStorage({ 'app/backend/api.js': API_JS }), 1);
    expect(missing).toEqual({ ok: false, reason: 'missing_index' });
  });

  it('api.js 内含 </script> 时转义（不提前终止宿主 script）', async () => {
    const tricky = 'var s = "</script>";module.exports={handle:()=>({code:200})};';
    const result = await assemblePreview(fakeStorage({ [PREVIEW_INDEX_PATH]: INDEX, 'app/backend/api.js': tricky }), 1);
    expect(result.ok && result.html).toContain('<\\/script>');
  });
});

describe('composePreviewCsp', () => {
  it('无增量 → 原样返回（=== 基线，逐字节）', () => {
    expect(composePreviewCsp(PREVIEW_CSP, undefined)).toBe(PREVIEW_CSP);
  });
  it('script-src 追加、connect-src 替换 none（none 与其他值互斥）', () => {
    const out = composePreviewCsp(PREVIEW_CSP, { scriptSrc: ['https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"], connectSrc: ['https://cdn.jsdelivr.net'] });
    expect(out).toContain("script-src 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net 'wasm-unsafe-eval'");
    expect(out).toContain('connect-src https://cdn.jsdelivr.net');
    expect(out).not.toContain("connect-src 'none'");
    expect(out).toContain("default-src 'none'");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/preview/assemble.test.ts`
Expected: FAIL（`composePreviewCsp` 不存在；`result.csp` 缺失）

- [ ] **Step 3: 实现 sandbox 三文件 + 重写 assemble.ts**

```ts
// src/lib/preview/sandbox/types.ts
/** §12「预览沙箱」扩展点：iframe 内如何跑起后端。backendSource 已过 profile.build。 */
import type { LanguageProfile } from '@/lib/languages/types';

export interface PreviewInput {
  indexHtml: string;
  backendSource: string | null;
  profile: LanguageProfile;
}

export interface PreviewOutput {
  html: string;
  /** CSP 指令增量；undefined = 无增量（CSP 逐字节保持基线） */
  cspExtras?: { scriptSrc?: string[]; connectSrc?: string[] };
}

export interface PreviewSandboxProvider {
  readonly kind: 'browser-js' | 'browser-pyodide';
  assemble(input: PreviewInput): PreviewOutput;
}
```

```ts
// src/lib/preview/sandbox/browser-js.ts
/**
 * 浏览器 JS 沙箱（现状原样搬入，Task 16 / Ruling 6b 信封协议）：
 * api.js 内联成 window.__ATOMS_BACKEND__（手工 CommonJS 垫片）+ fetch 拦截器。
 * 搬动纪律：escapeClosingScriptTag/backendWrapper/FETCH_SHIM/injectionBlock/assemblePreviewHtml
 * 与原 assemble.ts 逐字节一致——回归锁在 tests/preview/assemble.test.ts。
 */
import type { LanguageProfile } from '@/lib/languages/types';
import type { PreviewInput, PreviewOutput, PreviewSandboxProvider } from './types';

/** 字面 `</script` 提前终止宿主标签 → 转义成 `<\/script`（语义等价） */
export function escapeClosingScriptTag(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/** ① 后端模块垫片：手工 CommonJS 求值（api.js 缺失时返回空串） */
const backendWrapper = (apiJsSource: string | null): string =>
  apiJsSource === null ? '' : `window.__ATOMS_BACKEND__=(function(){const module={exports:{}};${escapeClosingScriptTag(apiJsSource)};return module.exports;})();`;

/** ② fetch 拦截器（占位兼容：handle 缺失时 /api/ 一律 503 信封） */
export const FETCH_SHIM = [ /* ←←← 原 assemble.ts 42-72 行的数组逐字节复制，一行不改 */ ].join('\n');

/** 组装注入块（先装后端，再装拦截器） */
function injectionBlock(apiJsSource: string | null): string {
  return `<script>\n${backendWrapper(apiJsSource)}\n${FETCH_SHIM}\n</script>`;
}

/** 注入点：<head> 后 → <html> 后 → 文档最前（畸形产物兜底）。Task 11 pyodide 沙箱复用。 */
export function injectIntoHtml(indexHtml: string, injection: string): string {
  const head = /<head[^>]*>/i.exec(indexHtml);
  if (head !== null) {
    const at = head.index + head[0].length;
    return indexHtml.slice(0, at) + injection + indexHtml.slice(at);
  }
  const html = /<html[^>]*>/i.exec(indexHtml);
  if (html !== null) {
    const at = html.index + html[0].length;
    return indexHtml.slice(0, at) + injection + indexHtml.slice(at);
  }
  return injection + indexHtml;
}

/** 纯函数装配（保留原导出名，seed/测试若有引用不断） */
export function assemblePreviewHtml(indexHtml: string, apiJsSource: string | null): string {
  return injectIntoHtml(indexHtml, injectionBlock(apiJsSource));
}

export const browserJsSandbox: PreviewSandboxProvider = {
  kind: 'browser-js',
  assemble(input: PreviewInput): PreviewOutput {
    return { html: assemblePreviewHtml(input.indexHtml, input.backendSource) };
  },
};
```

> 执行注意：`FETCH_SHIM` 数组必须从现 `assemble.ts:42-72` **逐字节复制**（含中文报错文案与空格缩进）；`ProfileInput.profile` 此沙箱不消费（TS 后端经 build 后已是 JS），参数保留为接口统一。

```ts
// src/lib/preview/sandbox/index.ts
/** 沙箱注册表：runtime → provider。P3 落地 pyodide 后在此注册。 */
import type { PreviewRuntime } from '@/lib/languages/types';
import type { PreviewSandboxProvider } from './types';
import { browserJsSandbox } from './browser-js';

const SANDBOXES: Partial<Record<PreviewRuntime, PreviewSandboxProvider>> = {
  'browser-js': browserJsSandbox,
};

/** 未注册 runtime 回退 browser-js（先例：EXEC_PROVIDER 回退 local；只告警一次） */
let warned = false;
export function getSandbox(runtime: PreviewRuntime): PreviewSandboxProvider {
  const found = SANDBOXES[runtime];
  if (found !== undefined) return found;
  if (!warned) {
    console.warn(`[preview] 未注册的运行时 ${runtime}，回退 browser-js`);
    warned = true;
  }
  return browserJsSandbox;
}
```

`src/lib/preview/assemble.ts` 整体重写为编排器（保住 `PREVIEW_INDEX_PATH`/`PREVIEW_CSP` 导出与 `PreviewAssembly` 名）：

```ts
/**
 * 全栈预览装配编排器（spec 2026-09-06-multi-language-design）：
 * 探测后端入口（注册表声明序）→ profile.build → getSandbox(runtime).assemble → CSP 合成。
 * CSP 基线 ruling 7 逐字；增量只来自 sandbox 的 cspExtras（当前仅 python/pyodide）。
 */
import type { StorageProvider } from '@/lib/db/provider/types';
import { LANGUAGE_PROFILES, defaultLanguageProfile } from '@/lib/languages';
import { getSandbox } from './sandbox';

export const PREVIEW_INDEX_PATH = 'app/frontend/index.html';

/** 预览响应 CSP 基线（ruling 7 逐字，不动） */
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: https:; connect-src 'none'";

export type PreviewAssembly = { ok: true; html: string; csp: string } | { ok: false; reason: 'missing_index' };

/** CSP 增量合成：extras 未给 → 原样返回；connect-src 的 'none' 与其他值互斥 → 有增量时替换 */
export function composePreviewCsp(base: string, extras?: { scriptSrc?: string[]; connectSrc?: string[] }): string {
  if (extras === undefined) return base;
  return base
    .split(';')
    .map((directive) => directive.trim())
    .filter(Boolean)
    .map((directive) => {
      const name = directive.split(' ')[0] ?? '';
      const tokens = directive.slice(name.length).trim();
      if (name === 'script-src' && extras.scriptSrc !== undefined && extras.scriptSrc.length > 0) {
        return `${name} ${[tokens, ...extras.scriptSrc].filter(Boolean).join(' ')}`;
      }
      if (name === 'connect-src' && extras.connectSrc !== undefined && extras.connectSrc.length > 0) {
        const kept = tokens === "'none'" ? '' : tokens;
        return `${name} ${[kept, ...extras.connectSrc].filter(Boolean).join(' ')}`;
      }
      return directive;
    })
    .join('; ');
}

/** 读虚拟 FS 并装配：探测后端入口（js 优先）→ build → sandbox → CSP */
export async function assemblePreview(storage: StorageProvider, projectId: number): Promise<PreviewAssembly> {
  const index = await storage.getFile(projectId, PREVIEW_INDEX_PATH);
  if (index === null) return { ok: false, reason: 'missing_index' };

  let profile = defaultLanguageProfile();
  let source: string | null = null;
  for (const candidate of LANGUAGE_PROFILES) {
    const file = await storage.getFile(projectId, candidate.backendEntryPath);
    if (file !== null) {
      profile = candidate;
      source = file.content;
      break;
    }
  }

  const built =
    source === null
      ? null
      : (profile.build(new Map([[profile.backendEntryPath, source]])).get(profile.backendEntryPath) ?? null);

  const output = getSandbox(profile.runtime).assemble({ indexHtml: index.content, backendSource: built, profile });
  return { ok: true, html: output.html, csp: composePreviewCsp(PREVIEW_CSP, output.cspExtras) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/preview/assemble.test.ts`
Expected: PASS（byte 级回归锁绿 = 搬动零变化）

- [ ] **Step 5: 全量回归 + 提交**

Run: `npx vitest run && npm run build`
```bash
git add src/lib/preview tests/preview
git commit -m "feat: extract PreviewSandboxProvider with browser-js sandbox (byte-identical)"
```

### Task 3: preview 路由接 csp + 工程师 prompt 契约段注入

**Files:**
- Modify: `src/app/api/projects/[id]/preview/route.ts:7,68`（import 与 CSP 头）
- Modify: `src/lib/agents/roles/engineer.ts:154-167,313`（prompt 构造函数化 + runEngineerFile 接线）
- Test: `tests/agents/engineer-prompt.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveProfileByPaths`、`javascriptProfile`；Task 2 `PreviewAssembly.csp`。
- Produces: `buildEngineerSystemPrompt(contract: readonly string[], selfCheckHint: string): string`（engineer.ts 导出；mock/真实两路共用）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/agents/engineer-prompt.test.ts
import { describe, expect, it } from 'vitest';
import { buildEngineerSystemPrompt, ENGINEER_SYSTEM_PROMPT } from '@/lib/agents/roles/engineer';
import { javascriptProfile } from '@/lib/languages';

describe('工程师 system prompt', () => {
  it('js 档案输出与常量一致，且契约/自检行逐字保留（零变化锁）', () => {
    const built = buildEngineerSystemPrompt(javascriptProfile.engineerContract, javascriptProfile.selfCheckHint);
    expect(built).toBe(ENGINEER_SYSTEM_PROMPT);
    expect(built).toContain('1. 后端 app/backend/api.js：无框架同构 CommonJS 模块，必须导出 module.exports = { handle }');
    expect(built).toContain('- 写完 JS 文件后可用 bash 自检：node --check <文件> 验语法');
    expect(built).toContain('2. 前端 app/frontend/index.html：单页');
    expect(built).toContain('3. UI 基线：#F7F7F8');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agents/engineer-prompt.test.ts`
Expected: FAIL（`buildEngineerSystemPrompt` 未导出）

- [ ] **Step 3: 实现**

engineer.ts：把 154-167 行的静态数组改为构造函数，静态常量由 js 档案兜底（外部引用不断）：

```ts
import { javascriptProfile, resolveProfileByPaths } from '@/lib/languages';

/** 工程师 system prompt：契约第 1 条与 bash 自检行按语言注入，其余段全语言共用 */
export function buildEngineerSystemPrompt(contract: readonly string[], selfCheckHint: string): string {
  return [
    '你是全栈工程师（engineer），负责把上游设计可靠地落成可运行代码——当前是单文件任务，应用的质量下限由你守住。',
    '',
    '【全栈契约（必须逐条遵守）】',
    ...contract,
    '2. 前端 app/frontend/index.html：单页，样式仅允许 Tailwind CDN（https://cdn.tailwindcss.com）；一律 fetch(\'/api/...\') 调用后端；禁用 localStorage 与 cookie（预览 iframe 无 same-origin，状态放后端内存）；禁止 eval、new Function、字符串 setTimeout、postMessage。',
    '3. UI 基线：#F7F7F8 面板分层、蓝色 #3B82F6 强调、8-12px 圆角、1px 细灰线分隔、空态与加载态、中文文案；渲染用户数据一律用 textContent（禁止 innerHTML 拼接，防 XSS）。',
    '',
    '【单文件任务纪律】',
    '- 每个任务只实现一个目标文件；依赖文件全文已注入上下文，其他已生成文件可用 read_file 按需查阅。',
    '- 目标文件必须由你调用 write_file 写入完整内容（整体覆盖）；发现写错可再次 write_file 覆写修正。',
    '- 写完目标文件即任务完成：输出一句简短结论即可，不要复述全文。',
    selfCheckHint,
  ].join('\n');
}

/** 兼容常量（js 语义不变；新消费方一律走 buildEngineerSystemPrompt + 项目语言档案） */
export const ENGINEER_SYSTEM_PROMPT = buildEngineerSystemPrompt(
  javascriptProfile.engineerContract,
  javascriptProfile.selfCheckHint,
);
```

runEngineerFile 内（原 313 行 `systemPrompt: ENGINEER_SYSTEM_PROMPT,` 处）改为按项目语言解析：

```ts
const profile = resolveProfileByPaths(ctx.tree.map((node) => node.path));
// ...
systemPrompt: buildEngineerSystemPrompt(profile.engineerContract, profile.selfCheckHint),
```

preview/route.ts：`'Content-Security-Policy': PREVIEW_CSP,` → `'Content-Security-Policy': result.csp,`，import 行去掉 `PREVIEW_CSP`（保留 `assemblePreview`）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run tests/agents/engineer-prompt.test.ts && npx vitest run && npm run build`

- [ ] **Step 5: 提交**

```bash
git add src/app/api/projects/[id]/preview/route.ts src/lib/agents/roles/engineer.ts tests/agents
git commit -m "feat: wire language profile into engineer prompt and preview CSP"
```

## P2 TypeScript（转译 → 复用 JS 管线）

### Task 4: typescript 档案（转译/校验/契约）+ 注册

**Files:**
- Create: `src/lib/languages/profiles/typescript.ts`
- Modify: `src/lib/languages/index.ts`（注册表追加 typescript）
- Test: `tests/languages/typescript-profile.test.ts`

**Interfaces:**
- Consumes: Task 1 `LanguageProfile`；`@/lib/validation/syntax` 的 `checkSyntax`、`@/lib/validation/danger` 的 `scanDanger`。
- Produces: `typescriptProfile: LanguageProfile`；`transpileBackend(source: string): string`（Task 8 物化投影复用；strip types → CommonJS）；`transpileOrReport(source): { ok: true; js: string } | { ok: false; error: string }`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/languages/typescript-profile.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/languages/typescript-profile.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/lib/languages/profiles/typescript.ts
/**
 * typescript 档案：服务端进程内转译（typescript 包为 devDep 现状，spec §2.2），
 * 转译产物走 browser-js 沙箱与 __atoms runner——TS 与 JS 共享同一运行面。
 * 校验口径：transpileModule 的 syntactic diagnostics（reportDiagnostics: true）
 * 只报语法错；类型错不拦截（strip 后不影响运行，spec §4.1）。
 */
import ts from 'typescript';
import { checkSyntax } from '@/lib/validation/syntax';
import { scanDanger } from '@/lib/validation/danger';
import type { LanguageProfile } from '../types';

/** strip types → CommonJS（api.ts → 预览垫片/runner 可执行的 JS 文本） */
export function transpileBackend(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'api.ts',
  }).outputText;
}

/** 转译或报告：语法错 → { ok:false, error }（中文，进工程师带错重试链） */
export function transpileOrReport(source: string): { ok: true; js: string } | { ok: false; error: string } {
  const out = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: 'api.ts',
    reportDiagnostics: true,
  });
  const errors = (out.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const first = errors[0];
    if (first !== undefined) {
      return { ok: false, error: `TypeScript 语法错误：${ts.flattenDiagnosticMessageText(first.messageText, ' ')}` };
    }
  }
  return { ok: true, js: out.outputText };
}

export const typescriptProfile: LanguageProfile = {
  id: 'typescript',
  backendExtension: 'ts',
  backendEntryPath: 'app/backend/api.ts',
  runtime: 'browser-js',
  engineerContract: [
    '1. 后端 app/backend/api.ts：TypeScript 无框架同构模块，导出 export function handle(method: string, path: string, body: unknown): { code: number; data?: unknown; message?: string }；数据一律存内存数组/对象（类型自明，禁 any）；禁止任何 fs/net/进程/timer API；REST 语义与正确状态码（200/201/400/404/405）。',
  ],
  selfCheckHint:
    '- 写完 TS 文件后可用 bash 自检：npx tsc --noEmit <文件> 验类型语法；单任务最多 5 次、每次 ≤30s；不要用 bash 启动长驻服务、安装依赖或改文件（写文件一律走 write_file）。',
  build(files) {
    const out = new Map<string, string>();
    for (const [path, content] of files) {
      out.set(path, path.endsWith('.ts') ? transpileBackend(content) : content);
    }
    return out;
  },
  checkSyntax(path, content) {
    const result = transpileOrReport(content);
    if (!result.ok) return { ok: false, error: result.error };
    return checkSyntax(path.replace(/\.ts$/, '.js'), result.js);
  },
  scanDanger(path, content) {
    const result = transpileOrReport(content);
    if (!result.ok) return [];
    return scanDanger(path.replace(/\.ts$/, '.js'), result.js);
  },
};
```

`src/lib/languages/index.ts` 注册表行改为：

```ts
import { typescriptProfile } from './profiles/typescript';

export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [javascriptProfile, typescriptProfile];
```

- [ ] **Step 4: 跑测试确认通过（含 Task 1/2 回归）**

Run: `npx vitest run tests/languages tests/preview`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/languages tests/languages
git commit -m "feat: typescript language profile with in-process transpilation"
```

### Task 5: 校验层按档案分派

**Files:**
- Modify: `src/lib/validation/index.ts`（validateFile 先问注册表）
- Test: `tests/validation/profile-dispatch.test.ts`

**Interfaces:**
- Consumes: Task 1 `resolveProfileByExtension`、Task 4 `typescriptProfile`。
- Produces: `validateFile(path, content): FileValidation`（签名不变；`.ts`/`.py` 走档案，其余走原路径）。依赖方向：`validation/index → languages → validation/syntax|danger`（叶子），无环——types.ts 的注释已立此规矩。

- [ ] **Step 1: 写失败测试**

```ts
// tests/validation/profile-dispatch.test.ts
import { describe, expect, it } from 'vitest';
import { validateFile } from '@/lib/validation';

describe('validateFile 按语言档案分派', () => {
  it('.ts 语法错被拦（转译链路生效）', () => {
    const v = validateFile('app/backend/api.ts', 'function handle( {');
    expect(v.ok).toBe(false);
    expect(v.syntaxError).toContain('TypeScript');
  });

  it('.ts 的 eval 拦截（hard）', () => {
    const v = validateFile('app/backend/api.ts', 'const f: any = eval; export function handle(){ return {code:200}; }');
    expect(v.hard.some((d) => d.rule === 'eval')).toBe(true);
    expect(v.ok).toBe(false);
  });

  it('.js/.html 行为不变（原路径）', () => {
    expect(validateFile('app/backend/api.js', 'module.exports={handle(){}}').ok).toBe(true);
    expect(validateFile('app/frontend/index.html', '<html><script>eval("1")</script></html>').ok).toBe(false);
    expect(validateFile('app/README.md', '任意文本').ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/validation/profile-dispatch.test.ts`
Expected: FAIL（.ts 当前被 syntax.ts 放行、danger.ts 不扫）

- [ ] **Step 3: 实现（validation/index.ts 的 validateFile 改造）**

```ts
import { extensionOf } from './syntax';
import { resolveProfileByExtension } from '@/lib/languages';

export function validateFile(path: string, content: string): FileValidation {
  // 后端语言档案优先（.ts/.py…）；未注册后缀（html/md/…）走下方原路径
  const profile = resolveProfileByExtension(extensionOf(path));
  if (profile !== null) {
    const syntax = profile.checkSyntax(path, content);
    const dangers = profile.scanDanger(path, content);
    return assemble(syntax, dangers);
  }
  const syntax = checkSyntax(path, content);
  const dangers = scanDanger(path, content);
  return assemble(syntax, dangers);
}

function assemble(syntax: ReturnType<typeof checkSyntax>, dangers: ReturnType<typeof scanDanger>): FileValidation {
  const hard = dangers.filter((item) => item.severity === 'hard');
  const soft = dangers.filter((item) => item.severity === 'soft');
  return { ok: hard.length === 0 && syntax.ok, hard, soft, syntaxError: syntax.error };
}
```

- [ ] **Step 4: 跑测试确认通过 + 存量校验测试回归**

Run: `npx vitest run tests/validation`
Expected: PASS（danger.test.ts 等存量用例不红——.js 走 javascript 档案 = 同函数）

- [ ] **Step 5: 提交**

```bash
git add src/lib/validation tests/validation
git commit -m "feat: dispatch file validation through language profiles"
```

### Task 6: 语言选型（快速模式关键词 + leader/architect prompt 行）

**Files:**
- Modify: `src/lib/agents/roles/engineer.ts`（buildFastFileTree 入口按语言 + pickLanguage 导出）
- Modify: `src/lib/agents/roles/leader.ts:78`（LEADER_SYSTEM_PROMPT 增一行）
- Modify: `src/lib/agents/roles/architect.ts:174`（架构师 system prompt 增一行）
- Test: `tests/agents/language-routing.test.ts`

**Interfaces:**
- Consumes: Task 1 `LanguageId`。
- Produces: `pickLanguage(requirement: string): LanguageId`（engineer.ts 导出）；`buildFastFileTree` 签名不变（内部派生语言，orchestrator 零改动）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/agents/language-routing.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agents/language-routing.test.ts`
Expected: FAIL（pickLanguage 未导出；树入口恒 api.js）

- [ ] **Step 3: 实现**

engineer.ts（buildFastFileTree 上方新增）：

```ts
import type { LanguageId } from '@/lib/languages/types';

/** 语言关键词 → LanguageId；中文紧邻场景用环视（\b 对非 ASCII 不成立） */
const LANGUAGE_KEYWORDS: ReadonlyArray<readonly [RegExp, LanguageId]> = [
  [/\btypescript\b|(?<![a-z])ts(?![a-z])/i, 'typescript'],
  [/\bpython\b|(?<![a-z])py(?![a-z])/i, 'python'],
];

/** 快速模式确定性选型（先例：pickTemplate）；默认 javascript */
export function pickLanguage(requirement: string): LanguageId {
  for (const [pattern, id] of LANGUAGE_KEYWORDS) {
    if (pattern.test(requirement)) return id;
  }
  return 'javascript';
}

/** 各语言的后端入口（完整模式由架构师 prompt 决定同一约定） */
const FAST_ENTRY: Record<LanguageId, string> = {
  javascript: 'app/backend/api.js',
  typescript: 'app/backend/api.ts',
  python: 'app/backend/api.py',
};
```

buildFastFileTree 内：`const kind = pickTemplate(requirement);` 之后加 `const lang = pickLanguage(requirement);`，节点 `path: 'app/backend/api.js'` 改为 `path: FAST_ENTRY[lang]`，其 desc 前缀 `内存态后端 handle(method,path,body)` 改为 `内存态后端 handle(method,path,body)（${lang}）`（其余 desc/depends 不动）。

leader.ts 的 LEADER_SYSTEM_PROMPT 数组末尾追加一行（路由决策段）：

```ts
  '语言路由：用户明确要求 TypeScript/Python 时，在交接 summary 写明「后端语言=typescript|python」，架构师据此定后端入口后缀；未写明默认 JavaScript。',
```

architect.ts 的架构师 system prompt（174 行起）「file_tree 契约」相关段末尾追加一行：

```ts
  '后端入口：默认 app/backend/api.js；leader 交接写明「后端语言=typescript|python」时改用 api.ts/api.py（同构 handle 契约不变，语言差异由工程师契约段约束）。',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agents/language-routing.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/agents/roles tests/agents
git commit -m "feat: language routing for fast mode and leader/architect prompts"
```

### Task 7: TS 骨架渲染（mock + 保底分派）

**Files:**
- Modify: `src/lib/agents/roles/samples/app-skeleton.ts`（新增 renderApiTs）
- Modify: `src/lib/llm/mock.ts:249` 附近（.ts 分支）
- Modify: `src/lib/agents/roles/engineer.ts:232` renderFallbackFile（.ts 分支）
- Test: `tests/agents/render-api-ts.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_API_ROUTE`/`resourceOf`/`kindOfRoutes`（app-skeleton.ts 内部已有）。
- Produces: `renderApiTs(routes: string[]): string`（与 renderApiJs 同 CRUD 语义的 TS 版）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/agents/render-api-ts.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agents/render-api-ts.test.ts`
Expected: FAIL（renderApiTs 未导出）

- [ ] **Step 3: 实现（app-skeleton.ts 追加，与 renderApiJs 同区）**

```ts
/** TS 后端骨架：与 renderCrudApi 同语义（内存 CRUD + REST 信封），类型注解版 */
export function renderApiTs(routes: string[]): string {
  const list = routes.length > 0 ? routes : [DEFAULT_API_ROUTE];
  const primary = resourceOf(list[0] ?? DEFAULT_API_ROUTE);
  const lines: string[] = [
    '/**',
    ' * 内存态后端（TypeScript、无框架、同构）：handle(method, path, body)',
    ' * 运行边界：浏览器沙箱内执行——禁 fs/net/本地存储，刷新页面即重置。',
    ` * 路由：${list.join(', ')}`,
    ' * 响应统一为 { code, data?, message? }；REST 状态码：200/201/400/404/405。',
    ' */',
    'type Item = { id: number; title: string; done: boolean };',
    'type Envelope = { code: number; data?: unknown; message?: string };',
    'const db: Record<string, Item[]> = {};',
    'let nextId = 1;',
    ...list.map((r) => `db['${resourceOf(r)}'] = [{ id: nextId++, title: '示例任务', done: false }];`),
    '',
    'export function handle(method: string, path: string, body: unknown): Envelope {',
    '  const parts = String(path ?? "").split("/").filter(Boolean);',
    `  const resource = parts[1] ?? '${primary}';`,
    '  const id = parts.length > 2 ? Number(parts[2]) : null;',
    '  const bucket = db[resource];',
    '  if (bucket === undefined) return { code: 404, message: "未知资源：" + resource };',
    '  const action = String(method ?? "GET").toUpperCase();',
    '  const item = (body ?? null) as { title?: string; done?: boolean } | null;',
    '  if (action === "GET" && id === null) return { code: 200, data: bucket };',
    '  if (action === "POST") {',
    '    const title = typeof item?.title === "string" ? item.title.trim() : "";',
    '    if (title.length === 0) return { code: 400, message: "title 不能为空" };',
    '    const created: Item = { id: nextId++, title, done: false };',
    '    bucket.unshift(created);',
    '    return { code: 201, data: created };',
    '  }',
    '  const mutating = action === "PUT" || action === "PATCH" || action === "DELETE" || (action === "GET" && id !== null);',
    '  if (!mutating) return { code: 405, message: "不支持的方法：" + action };',
    '  if (id === null) return { code: 404, message: "缺少资源 id" };',
    '  const at = bucket.findIndex((entry) => entry.id === id);',
    '  if (at < 0) return { code: 404, message: "条目不存在" };',
    '  if (action === "GET") return { code: 200, data: bucket[at] };',
    '  if (action === "PUT" || action === "PATCH") {',
    '    if (typeof item?.title === "string" && item.title.trim().length > 0) bucket[at].title = item.title.trim();',
    '    if (typeof item?.done === "boolean") bucket[at].done = item.done;',
    '    return { code: 200, data: bucket[at] };',
    '  }',
    '  const removed = bucket.splice(at, 1)[0];',
    '  return { code: 200, data: { ok: true, id: removed.id } };',
    '}',
    '',
  ];
  return lines.join('\n');
}
```

mock.ts（249 行 `return renderApiJs(routes);` 所在分支之前）插入：

```ts
  if (path.endsWith('.ts')) {
    return renderApiTs(routes);
  }
```

（import 行补 `renderApiTs`。）

engineer.ts renderFallbackFile（232 行起，`.m?js` 分支之前）插入：

```ts
  if (/\.ts$/.test(path)) return renderApiTs(routes);
```

（顶部 import 补 `renderApiTs`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agents/render-api-ts.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/agents/roles/samples/app-skeleton.ts src/lib/llm/mock.ts src/lib/agents/roles/engineer.ts tests/agents
git commit -m "feat: typescript backend skeleton for mock and fallback renderers"
```

### Task 8: 物化投影 __atoms/backend.js（TS 项目终端自检可用）

**Files:**
- Modify: `src/lib/exec/materialize.ts`（syncWorkspace 写投影 + SERVER_JS_SOURCE 候选加载链）
- Test: `tests/exec/ts-projection.test.ts`

**Interfaces:**
- Consumes: Task 4 `transpileBackend`。
- Produces: TS 项目物化后 `__atoms/backend.js` = 转译产物（幂等覆写；`__atoms/` 语义：非生成物、不参与导出/回滚——pruneExtra 已豁免该目录，无需改）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/exec/ts-projection.test.ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StorageProvider } from '@/lib/db/provider/types';
import { syncWorkspace } from '@/lib/exec/materialize';

const root = await mkdtemp(path.join(tmpdir(), 'atoms-ts-proj-'));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function fakeStorage(files: Record<string, string>): StorageProvider {
  return { readAllFiles: async () => Object.entries(files).map(([p, content]) => ({ path: p, content })) } as unknown as StorageProvider;
}

describe('TS 物化投影', () => {
  it('api.ts → __atoms/backend.js 为转译产物；server.js 候选链就位', async () => {
    const env = { EXEC_WORKSPACES_DIR: root };
    const ts = 'export function handle(m: string, p: string, b: unknown) { return { code: 200 }; }';
    const { dir } = await syncWorkspace(fakeStorage({ 'app/backend/api.ts': ts }), 901, env);
    const projected = await readFile(path.join(dir, '__atoms', 'backend.js'), 'utf8');
    expect(projected).toContain('exports.handle');
    expect(projected).not.toContain(': string');
    const server = await readFile(path.join(dir, '__atoms', 'server.js'), 'utf8');
    expect(server).toContain("path.join(__dirname, 'backend.js')");
    expect(server).toContain("path.join(root, 'app/backend/api.js')");
  });

  it('js 项目：投影为空串（server.js 回退 app/backend/api.js 不变）', async () => {
    const env = { EXEC_WORKSPACES_DIR: root };
    const { dir } = await syncWorkspace(fakeStorage({ 'app/backend/api.js': 'module.exports={handle(){}}' }), 902, env);
    const projected = await readFile(path.join(dir, '__atoms', 'backend.js'), 'utf8');
    expect(projected).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/exec/ts-projection.test.ts`
Expected: FAIL（无 __atoms/backend.js）

- [ ] **Step 3: 实现**

materialize.ts：import 加 `import { transpileBackend } from '@/lib/languages/profiles/typescript';`，syncWorkspace 写完 server.js 之后追加：

```ts
    // TS 项目：转译投影进 __atoms/（平台内置区语义：幂等覆写、不参与导出/回滚；
    // server.js 候选链优先消费，js 项目投影为空串自然回退 app/backend/api.js）
    const tsEntry = wanted.get('app/backend/api.ts');
    await writeFile(path.join(dir, ATOMS_DIR, 'backend.js'), tsEntry === undefined ? '' : transpileBackend(tsEntry), 'utf8');
```

SERVER_JS_SOURCE 的加载段（`let backend = null; try { backend = require(apiPath); ... }` 整段）替换为候选链：

```js
let backend = null;
const candidates = [path.join(__dirname, 'backend.js'), path.join(root, 'app/backend/api.js')];
for (var i = 0; i < candidates.length; i++) {
  try {
    var loaded = require(candidates[i]);
    if (loaded && typeof loaded.handle === 'function') { backend = loaded; break; }
  } catch (err) { /* 空投影/缺文件：尝试下一候选 */ }
}
if (backend === null) {
  console.error('[atoms] 未找到可用后端（__atoms/backend.js 或 app/backend/api.js）');
}
```

（`const apiPath = ...` 行删除——由候选链取代；`indexPath` 不动。）

- [ ] **Step 4: 跑测试确认通过 + exec 存量回归**

Run: `npx vitest run tests/exec`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/exec/materialize.ts tests/exec
git commit -m "feat: materialize transpiled ts backend into __atoms projection"
```

### Task 9: TS 全链路集成测试

**Files:**
- Test: `tests/preview/assemble-typescript.test.ts`

**Interfaces:**
- Consumes: Task 2 `assemblePreview`/`PREVIEW_CSP`、Task 7 `renderApiTs`。
- Produces: 无（验收性测试：TS 项目 落库 → 预览装配 全链路）。

- [ ] **Step 1: 写测试（此为集成验收，直接写预期行为）**

```ts
// tests/preview/assemble-typescript.test.ts
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
```

- [ ] **Step 2: 跑测试**

Run: `npx vitest run tests/preview/assemble-typescript.test.ts`
Expected: PASS（Task 2/4/7 已铺好链路；若红，按报错回查装配探测序与 build 变换）

- [ ] **Step 3: 全量回归 + 构建 + 提交**

Run: `npx vitest run && npm run build`
```bash
git add tests/preview
git commit -m "test: typescript end-to-end preview assembly"
```

## P3 Python（Pyodide 浏览器内）

### Task 10: python 档案（正则危险规则 + 契约）+ DangerRule 扩展

**Files:**
- Modify: `src/lib/validation/danger.ts`（DangerRule 联合扩展 4 个 python 规则名）
- Create: `src/lib/languages/profiles/python.ts`
- Modify: `src/lib/languages/index.ts`（注册表追加 python）
- Test: `tests/languages/python-profile.test.ts`

**Interfaces:**
- Consumes: Task 1 `LanguageProfile`；danger.ts 现有 `Danger` 形状 `{ severity, rule, detail }`。
- Produces: `pythonProfile: LanguageProfile`；DangerRule 新增 `'py_exec' | 'py_subprocess' | 'py_socket' | 'py_net_import'`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/languages/python-profile.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/languages/python-profile.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

danger.ts 的 `DangerRule` 联合追加（保持既有成员不动）：

```ts
export type DangerRule =
  | 'eval'
  | 'new_function'
  | 'timer_string'
  | 'post_message_parent'
  | 'external_script'
  | 'infinite_loop'
  | 'external_fetch'
  | 'py_exec'
  | 'py_subprocess'
  | 'py_socket'
  | 'py_net_import';
```

```ts
// src/lib/languages/profiles/python.ts
/**
 * python 档案：预览走 Pyodide（WASM CPython，无 fs/net/socket），
 * 正则危险规则是纵深第 3 道的降级实现（spec §2.2：acorn 只懂 JS）。
 * 语法校验降级放行——真校验 = 预览 boot 的 SyntaxError 横幅 + bash 自检 py_compile。
 */
import type { Danger, DangerRule } from '@/lib/validation/danger';
import type { SyntaxReport } from '@/lib/validation/syntax';
import type { LanguageProfile } from '../types';

const PY_HARD_RULES: ReadonlyArray<readonly [DangerRule, RegExp, string]> = [
  ['py_exec', /\b(?:eval|exec)\s*\(|__import__/, '检测到 Python 动态执行 API（eval/exec/__import__）：浏览器内后端禁止'],
  ['py_subprocess', /\bos\.system\s*\(|\bsubprocess\b/, '检测到 subprocess/os.system：浏览器内后端禁止起进程'],
  ['py_socket', /\bimport\s+socket\b|\bfrom\s+socket\b/, '检测到 socket 导入：浏览器内后端禁网络'],
];

const PY_SOFT_RULES: ReadonlyArray<readonly [DangerRule, RegExp, string]> = [
  ['py_net_import', /\bimport\s+(?:requests|urllib|http\.client)\b|\bfrom\s+(?:requests|urllib|http\.client)\b/, 'requests/urllib 在 Pyodide 内不可用：请用内存数据或 fetch 拦截层（前端代理）'],
];

export const pythonProfile: LanguageProfile = {
  id: 'python',
  backendExtension: 'py',
  backendEntryPath: 'app/backend/api.py',
  runtime: 'browser-pyodide',
  engineerContract: [
    '1. 后端 app/backend/api.py：Python 无框架模块，定义 handle(method, path, body) 返回 dict {"code": int, "data"?: any, "message"?: str}；数据一律存内存 list/dict（模块级变量）；禁止 socket/subprocess/os.system/eval/exec/__import__ 与任何文件 IO；REST 语义与正确状态码（200/201/400/404/405）。',
  ],
  selfCheckHint:
    '- 写完 Python 文件后可用 bash 自检：python3 -m py_compile <文件> 验语法；单任务最多 5 次、每次 ≤30s；不要用 bash 启动长驻服务、安装依赖或改文件（写文件一律走 write_file）。',
  build: (files) => new Map(files),
  checkSyntax: (_path, _content): SyntaxReport => ({ ok: true }),
  scanDanger(path: string, content: string): Danger[] {
    if (!path.endsWith('.py')) return [];
    const found: Danger[] = [];
    for (const [rule, pattern, detail] of PY_HARD_RULES) {
      if (pattern.test(content)) found.push({ severity: 'hard', rule, detail });
    }
    for (const [rule, pattern, detail] of PY_SOFT_RULES) {
      if (pattern.test(content)) found.push({ severity: 'soft', rule, detail });
    }
    return found;
  },
};
```

`src/lib/languages/index.ts` 注册表追加：

```ts
import { pythonProfile } from './profiles/python';

export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [javascriptProfile, typescriptProfile, pythonProfile];
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/languages`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/validation/danger.ts src/lib/languages tests/languages
git commit -m "feat: python language profile with regex danger rules"
```

### Task 11: browser-pyodide 沙箱（loader + JSON 信封桥 + lazy fetch 拦截 + CSP 增量）

**Files:**
- Create: `src/lib/preview/sandbox/browser-pyodide.ts`
- Modify: `src/lib/preview/sandbox/index.ts`（注册 browser-pyodide）
- Test: `tests/preview/pyodide-sandbox.test.ts`

**Interfaces:**
- Consumes: Task 2 `PreviewSandboxProvider`/`PreviewInput`/`PreviewOutput`、browser-js.ts 的 `injectIntoHtml`/`escapeClosingScriptTag`。
- Produces: `browserPyodideSandbox`；注册后 `getSandbox('browser-pyodide')` 可用；`cspExtras = { scriptSrc: ['https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"], connectSrc: ['https://cdn.jsdelivr.net'] }`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/preview/pyodide-sandbox.test.ts
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
    expect(empty.html).not.toContain('__ATOMS_BOOT_READY__');
    expect(empty.html).not.toContain('__ATOMS_BACKEND__'); // 不装后端包装
    expect(empty.html).toContain('handleOf()');
  });

  it('boot 失败渲染中文横幅（spec 修订：iframe 内无法发 SSE，横幅 + 500 信封兜底）', () => {
    const out = browserPyodideSandbox.assemble(input(API_PY));
    expect(out.html).toContain('Python 后端启动失败');
    expect(out.html).toContain('DOMContentLoaded');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/preview/pyodide-sandbox.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// src/lib/preview/sandbox/browser-pyodide.ts
/**
 * Pyodide 预览沙箱（spec §4.2）：iframe 内跑真 Python 后端（WASM CPython）。
 * 三段注入：① CDN loader；② boot（runPythonAsync 求值 api.py + JSON 信封适配器）；
 * ③ lazy fetch 拦截器（boot 未完 await + 30s 超时；与 browser-js 的 FETCH_SHIM
 * 信封语义一致但独立成文——复制而非参数化，保 js 侧字节零变化的优先级高于 DRY）。
 * 桥接用 JSON 字符串双向序列化：避开 JsProxy（JS 对象进 python）与 Map（dict 出 python）陷阱。
 */
import type { PreviewInput, PreviewOutput, PreviewSandboxProvider } from './types';
import { escapeClosingScriptTag, injectIntoHtml } from './browser-js';

const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

/** python 侧信封适配器：handle(dict) ↔ JSON 字符串；只携带存在的键 */
const PY_ADAPTER = [
  'def _atoms_handle(method, path, body_json):',
  '    import json as _json',
  '    body = _json.loads(body_json) if body_json else None',
  '    result = handle(method, path, body)',
  '    out = {"code": result.get("code", 200)}',
  '    if "data" in result: out["data"] = result["data"]',
  '    if "message" in result: out["message"] = result["message"]',
  '    return _json.dumps(out)',
].join('\n');

function pyLiteral(source: string): string {
  // JSON.stringify 做转义，再堵 </script 提前终止（与 browser-js 同一防线）
  return JSON.stringify(source).replace(/<\/script/gi, '<\\/script');
}

/** boot 块：加载 pyodide → 求值 api.py + 适配器 → 挂 __ATOMS_BACKEND__；失败渲染中文横幅 */
function pyodideBoot(apiPySource: string): string {
  return `<script>
window.__ATOMS_BOOT_READY__=(async function(){
  var pyodide=await loadPyodide({indexURL:'${PYODIDE_BASE}'});
  await pyodide.runPythonAsync(${pyLiteral(apiPySource)});
  pyodide.runPython(${pyLiteral(PY_ADAPTER)});
  var raw=pyodide.globals.get('_atoms_handle');
  window.__ATOMS_BACKEND__={handle:function(method,path,body){
    return JSON.parse(raw(method,path,body===undefined?null:JSON.stringify(body)));
  }};
})().catch(function(error){
  var banner=document.createElement('div');
  banner.style.cssText='position:fixed;top:0;left:0;right:0;z-index:9999;padding:.75rem 1rem;background:#FEE2E2;color:#991B1B;font:13px/1.6 system-ui;';
  banner.textContent='Python 后端启动失败：'+((error&&error.message)?error.message:String(error));
  function mount(){(document.body||document.documentElement).appendChild(banner);}
  if(document.body){mount();}else{window.addEventListener('DOMContentLoaded',mount);}
  throw error;
});
</script>`;
}

/** lazy fetch 拦截器：handle 延迟解析 + boot await + 30s 超时（信封映射与 eager 版一致） */
const FETCH_SHIM_LAZY = [
  '(function(){',
  'var nativeFetch=(typeof window.fetch==="function")?window.fetch.bind(window):null;',
  'function pathOf(input){if(typeof input==="string")return input;if(input&&typeof input.url==="string")return input.url;return String(input);}',
  'function bodyOf(init,input){',
  '  if(init&&typeof init.body!=="undefined"){if(typeof init.body==="string"){try{return JSON.parse(init.body);}catch(e){return init.body;}}return init.body;}',
  '  return null;',
  '}',
  'function handleOf(){var b=window.__ATOMS_BACKEND__;return (b&&typeof b.handle==="function")?b.handle:null;}',
  'window.fetch=function(input,init){',
  '  var path=pathOf(input);',
  '  if(path.indexOf("/api/")===0){',
  '    var method=String((init&&init.method)||(input&&input.method)||"GET").toUpperCase();',
  '    var body=bodyOf(init,input);',
  '    var boot=window.__ATOMS_BOOT_READY__||Promise.resolve();',
  '    var timeout=new Promise(function(_,reject){setTimeout(function(){reject(new Error("后端启动超时（30s）"));},30000);});',
  '    return Promise.race([boot,timeout]).then(function(){',
  '      var h=handleOf();',
  '      if(h===null)return{code:503,message:"后端未生成或未就绪（缺少 app/backend/api.py）"};',
  '      return h(method,path,body);',
  '    }).then(function(envelope){',
  '      var result=envelope||{};',
  '      var payload=(result.data!==undefined)?result.data:((result.message!==undefined)?result.message:null);',
  '      return new Response(JSON.stringify(payload),{status:Number(result.code)||200,headers:{"Content-Type":"application/json"}});',
  '    }).catch(function(error){',
  '      return new Response(JSON.stringify({message:"后端处理出错："+((error&&error.message)?error.message:String(error))}),{status:500,headers:{"Content-Type":"application/json"}});',
  '    });',
  '  }',
  '  if(nativeFetch===null)return Promise.reject(new Error("非 /api/ 请求且原生 fetch 不可用"));',
  '  return nativeFetch(input,init);',
  '};',
  '})();',
].join('\n');

export const browserPyodideSandbox: PreviewSandboxProvider = {
  kind: 'browser-pyodide',
  assemble(input: PreviewInput): PreviewOutput {
    const boot = input.backendSource === null ? '' : pyodideBoot(input.backendSource);
    const injection = `<script src="${PYODIDE_BASE}pyodide.js"></script>\n${boot}<script>\n${FETCH_SHIM_LAZY}\n</script>`;
    return {
      html: injectIntoHtml(input.indexHtml, injection),
      cspExtras: {
        scriptSrc: ['https://cdn.jsdelivr.net', "'wasm-unsafe-eval'"],
        connectSrc: ['https://cdn.jsdelivr.net'],
      },
    };
  },
};
```

sandbox/index.ts：import 加 `browserPyodideSandbox`，注册表加一行：

```ts
const SANDBOXES: Partial<Record<PreviewRuntime, PreviewSandboxProvider>> = {
  'browser-js': browserJsSandbox,
  'browser-pyodide': browserPyodideSandbox,
};
```

- [ ] **Step 4: 跑测试确认通过（含 Task 2 回归锁）**

Run: `npx vitest run tests/preview`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/preview/sandbox tests/preview
git commit -m "feat: browser-pyodide preview sandbox with json envelope bridge"
```

### Task 12: Python 骨架渲染 + mock/保底分派

**Files:**
- Modify: `src/lib/agents/roles/samples/app-skeleton.ts`（新增 renderApiPy）
- Modify: `src/lib/llm/mock.ts`（.py 分支）
- Modify: `src/lib/agents/roles/engineer.ts` renderFallbackFile（.py 分支）
- Test: `tests/agents/render-api-py.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_API_ROUTE`/`resourceOf`（app-skeleton.ts 内部）。
- Produces: `renderApiPy(routes: string[]): string`（CRUD 语义与 renderApiJs 对齐的 Python 版）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/agents/render-api-py.test.ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agents/render-api-py.test.ts`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现（app-skeleton.ts 追加）**

```ts
/** Python 后端骨架：与 renderCrudApi 同语义（内存 CRUD + REST 信封），Pyodide 可跑（纯 list/dict） */
export function renderApiPy(routes: string[]): string {
  const list = routes.length > 0 ? routes : [DEFAULT_API_ROUTE];
  const primary = resourceOf(list[0] ?? DEFAULT_API_ROUTE);
  const lines: string[] = [
    '"""内存态后端（Python、无框架、同构）：handle(method, path, body)',
    '运行边界：浏览器 Pyodide 沙箱内执行——禁 fs/net/本地存储，刷新页面即重置。',
    `路由：${list.join(', ')}`,
    '响应统一为 {"code": int, "data"?: any, "message"?: str}；REST 状态码：200/201/400/404/405。',
    '"""',
    'db = {}',
    'next_id = [1]',
    ...list.flatMap((r) => [`db['${resourceOf(r)}'] = [{'id': next_id[0], 'title': '示例任务', 'done': False}]`, 'next_id[0] += 1', '']),
    '',
    'def handle(method, path, body):',
    '    parts = [p for p in str(path or "").split("/") if p]',
    `    resource = parts[1] if len(parts) > 1 else '${primary}'`,
    '    item_id = int(parts[2]) if len(parts) > 2 else None',
    '    bucket = db.get(resource)',
    '    if bucket is None:',
    '        return {"code": 404, "message": "未知资源：" + resource}',
    '    action = str(method or "GET").upper()',
    '    if action == "GET" and item_id is None:',
    '        return {"code": 200, "data": bucket}',
    '    if action == "POST":',
    '        title = (body or {}).get("title", "").strip() if isinstance(body, dict) else ""',
    '        if not title:',
    '            return {"code": 400, "message": "title 不能为空"}',
    '        created = {"id": next_id[0], "title": title, "done": False}',
    '        next_id[0] += 1',
    '        bucket.insert(0, created)',
    '        return {"code": 201, "data": created}',
    '    if action not in ("GET", "PUT", "PATCH", "DELETE"):',
    '        return {"code": 405, "message": "不支持的方法：" + action}',
    '    if item_id is None:',
    '        return {"code": 404, "message": "缺少资源 id"}',
    '    at = next((i for i, entry in enumerate(bucket) if entry["id"] == item_id), None)',
    '    if at is None:',
    '        return {"code": 404, "message": "条目不存在"}',
    '    if action == "GET":',
    '        return {"code": 200, "data": bucket[at]}',
    '    if action in ("PUT", "PATCH"):',
    '        patch = body if isinstance(body, dict) else {}',
    '        if isinstance(patch.get("title"), str) and patch["title"].strip():',
    '            bucket[at]["title"] = patch["title"].strip()',
    '        if isinstance(patch.get("done"), bool):',
    '            bucket[at]["done"] = patch["done"]',
    '        return {"code": 200, "data": bucket[at]}',
    '    removed = bucket.pop(at)',
    '    return {"code": 200, "data": {"ok": True, "id": removed["id"]}}',
    '',
  ];
  return lines.join('\n');
}
```

mock.ts（.ts 分支之后）插入：

```ts
  if (path.endsWith('.py')) {
    return renderApiPy(routes);
  }
```

engineer.ts renderFallbackFile（.ts 分支之后）插入：

```ts
  if (/\.py$/.test(path)) return renderApiPy(routes);
```

（两处 import 各补 `renderApiPy`。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agents/render-api-py.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/lib/agents/roles/samples/app-skeleton.ts src/lib/llm/mock.ts src/lib/agents/roles/engineer.ts tests/agents
git commit -m "feat: python backend skeleton for mock and fallback renderers"
```

### Task 13: Python 全链路集成 + 文档收尾（DEMO-SCRIPT / rules07 / DESIGN §12 / spec 修订）

**Files:**
- Test: `tests/preview/assemble-python.test.ts`
- Modify: `docs/DEMO-SCRIPT.md`（增 Python/TS 演示段）
- Modify: `.claude/rules/07-security.md`（「预览隔离」节增补多语言条目）
- Modify: `docs/DESIGN.md` §12 表格（「预览沙箱」行标已落地；新增「语言」行）
- Modify: `docs/superpowers/specs/2026-09-06-multi-language-design.md` §7（SSE error → 横幅修订）

- [ ] **Step 1: 写集成测试**

```ts
// tests/preview/assemble-python.test.ts
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
```

Run: `npx vitest run tests/preview/assemble-python.test.ts`
Expected: PASS

- [ ] **Step 2: 全量验证**

Run: `npx vitest run && npm run build && npm run lint`
Expected: 全绿（含 Task 2 的 js byte 级回归锁——最终确认零行为变化）

- [ ] **Step 3: 文档四处收尾**

`docs/DEMO-SCRIPT.md` 末尾追加（按该文件现有格式）：

```markdown
## 多语言演示（TS + Python，2026-09-06 增补）

1. 新建项目，需求输入「用 Python 写一个待办清单」→ 快速模式关键词命中 → 文件树后端入口为 app/backend/api.py
2. 生成完成后打开预览：首载拉取 Pyodide（~10MB，需外网），随后浏览器内跑真 Python 后端，CRUD 全通
3. 再建一个「用 TypeScript 写一个待办清单」→ 入口 api.ts → 预览为转译后 JS（无 Pyodide、CSP 不变）
4. 话题点：语言维 = LanguageProfile 注册表（§12）；预览沙箱 = PreviewSandboxProvider（js/pyodide 两实现）
```

`.claude/rules/07-security.md`「预览隔离」节末尾追加：

```markdown
- 多语言预览（2026-09-06）：TS 经服务端进程内转译（devDep typescript）走既有 JS 管线，CSP 不变；Python 预览加载 Pyodide（固定版本 jsDelivr CDN），CSP 增量仅 script-src 追加该 CDN + 'wasm-unsafe-eval'、connect-src 由 'none' 放开为该 CDN 单域（composePreviewCsp 合成，JS 项目逐字节不变）。已知限制：Python 首载 ~10MB 需外网；语法校验降级放行（boot 失败横幅 + fetch 500 信封兜底）
```

`docs/DESIGN.md` §12 表格：「预览沙箱」行当前实现列改为 `iframe srcDoc + fetch 拦截（browser-js / browser-pyodide 两沙箱已落地，src/lib/preview/sandbox/）`；表格新增一行：

```markdown
| 语言 | `LanguageProfile`（契约/构建/校验/运行时） | javascript + typescript（转译）+ python（Pyodide） | cpp（browser-wasm）、java（server-process，需重估安全姿态） |
```

spec `2026-09-06-multi-language-design.md` §7 的 py 语法错误行改为：

```markdown
| py 语法错误 | 校验放行 → 预览 boot 时 pyodide 抛 SyntaxError → 预览页中文错误横幅 + /api/ 请求 500 信封（修订：iframe 禁 postMessage、connect-src 'none'，SSE error 不可达）→ 单文件重试修 |
```

- [ ] **Step 4: 人工验收（浏览器真跑）**

Run: `npm run dev`，按 DEMO-SCRIPT 新增段手动走一遍 Python/TS 项目（Pyodide 真加载、CRUD、断网时 CDN 失败提示页）。

- [ ] **Step 5: 提交**

```bash
git add tests/preview docs/DEMO-SCRIPT.md .claude/rules/07-security.md docs/DESIGN.md docs/superpowers/specs
git commit -m "feat: python end-to-end preview with docs and security posture updates"
```

---

## 计划自审记录

- **Spec 覆盖**：§3 双注册表（T1/T2/T11）、§4.1 行为矩阵（T4/T10）、§4.2 Pyodide 桥（T11）、§4.3 正则规则（T10）、§4.4 生成侧（T6/T7/T12）、§4.5 物化投影（T8）、§5 数据流（T2/T9/T13）、§6 CSP（T2 合成器 + T11 增量）、§7 错误（T4 转译重试链/T11 横幅/T10 校验降级）、§8 测试（各任务 + T9/T13 集成 + T2 byte 锁）、§9 分期 = 本计划 P1/P2/P3 段。P4（server.py runner、自托管 pyodide、cpp/java）不在本计划——spec 演进位。
- **类型一致性**：`LanguageProfile`/`PreviewInput`/`PreviewOutput`/`transpileBackend`/`pickLanguage`/`renderApiTs`/`renderApiPy`/`composePreviewCsp` 各任务引用与定义处签名一致。
- **风险点**：Task 2 是全计划咽喉（byte 级搬动），FETCH_SHIM 复制必须逐字节（测试锁死）；Task 5 有意的模块环规避（types.ts 注释立规）。

