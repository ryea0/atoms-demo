# 多语言生成与运行支持（TS + Python 垂直切片）设计

> 状态：已与用户逐节确认（2026-09-06）。定位：演示垂直切片——TypeScript 与 Python 真走通全链路，C++/Java 只留接口位。
> 关联：`docs/DESIGN.md` §12（扩展性架构）、D2（浏览器内全栈）、`.claude/rules/07-security.md`（预览隔离）。

## 1. 背景与目标

当前平台生成物语言被 D2 契约硬编码为 JavaScript：工程师 prompt 契约、`src/lib/preview/assemble.ts`（CommonJS 垫片 + fetch 拦截器）、校验层（acorn/parse5）、`__atoms/server.js` runner 全线只认 JS。DESIGN §12 的 `PreviewSandboxProvider` 仅留名未建文件。

**目标**：以垂直切片方式支持 TypeScript 与 Python 后端——用户一句「用 Python 写个 todo」→ 生成 `api.py` → 预览在浏览器内（Pyodide）真跑通 CRUD；同时把语言维度抽象成 §12 形状的注册表，使 C++/Java 的未来接入 = 新增文件而非改调用方。

**非目标**：C++/Java 实现、多语言混用（一个项目一种后端语言）、前端语言变体（前端恒 HTML + Tailwind + JS）、自托管 Pyodide、终端 Python runner（均列演进位）。

## 2. 方案取舍（决策记录）

### 2.1 架构方案三选一

| 方案 | 形状 | 取舍 | 结论 |
|---|---|---|---|
| A 装配层分派 | `assemble.ts` 内按扩展名 switch | 触点最少（~4 文件），但 §12 叙事零兑现，后续加语言继续堆 case | 否 |
| **B 双注册表** | LanguageProfile 注册表 + PreviewSandboxProvider 接口抽取 | 加语言 = 新增 profile 文件 + sandbox 实现，零改调用方；比 A 多一层接口抽取（~1.5-2× 工作量） | **采纳** |
| C 全运行时抽象 | 连 WasmSandbox/ServerProcessSandbox stub、BuilderProvider 编译管线一并建好 | 道背 YAGNI，切片定位下做不完 | 否 |

### 2.2 关键实现取舍

| 决策点 | 选择 | 备选与放弃理由 |
|---|---|---|
| Python 运行位置 | **Pyodide 浏览器内**（WASM CPython） | 服务端进程：Python 保真度更高（完整 stdlib）但突破 D2、把攻击面扩到宿主进程；双通道工作量翻倍。Pyodide 保「浏览器内全栈」叙事、无新进程面，代价 ~10MB 首载 + CSP 放宽（见 §6） |
| 语言判定源 | **后端入口扩展名**（`api.js/.ts/.py`） | DB 加 `backend_language` 列：要迁移、要双写保持一致；扩展名是 file_tree 已有信息，零迁移。leader 决策语言的方式 = 决定入口后缀 |
| TS 转译 | 服务端进程内 `typescript.transpileModule` | 浏览器内转译（sucrase-wasm 等）：多一个运行时依赖与 CSP 面。服务端转译复用 devDep（见下）。不依赖 node `--experimental-strip-types`（runner 保持零依赖、版本无关） |
| Python 语法校验 | **降级放行 + 软警告**，真校验靠预览时 pyodide 抛 SyntaxError 回传 | 无可靠纯 JS Python 解析器；服务端 spawn `python3 -m py_compile` 违反校验层「纯函数无 IO」契约（留作 bash 自检提示与演进位） |
| Python 危险 API 扫描 | 正则规则集 | acorn 只懂 JS。Pyodide 环境本身无 fs/net/socket，正则兜底是纵深第 3 道的合理降级 |
| boot 竞态 | fetch 拦截器 await bootPromise | 503+前端重试：把复杂度推给生成物代码，不可靠 |
| TS 物化投影 | 转译产物投 `__atoms/backend.js` | 物化 api.js 投影会污染导出；`__atoms/` 是平台内置区（幂等覆写、不参与导出/回滚），语义现成 |
| typescript 依赖姿态 | 用 devDep 现状（build 本身需要） | 演示姿态成立（部署含 devDeps）；生产化时挪到 `dependencies` 一行改动，spec 记录 |

## 3. 架构

```
src/lib/languages/                 # §12 新行：语言注册表
  types.ts        # LanguageProfile 接口 + 后缀查表
  profiles/javascript.ts   # 现契约原样搬入（零行为变化）
  profiles/typescript.ts
  profiles/python.ts
  index.ts        # resolveProfileByEntry(tree) → LanguageProfile
                  # 未知后缀回退 javascript + 软警告（先例：EXEC_PROVIDER 回退 local）

src/lib/preview/sandbox/           # §12 兑现：PreviewSandboxProvider
  types.ts        # 接口 + runtime → sandbox 注册表
  browser-js.ts   # 现 assemble.ts 的 CommonJS 垫片 + FETCH_SHIM 原样搬入
  browser-pyodide.ts
```

### 3.1 LanguageProfile 接口

```ts
interface LanguageProfile {
  id: 'javascript' | 'typescript' | 'python';   // 'cpp' | 'java' 只留注释位
  backendExtension: 'js' | 'ts' | 'py';
  runtime: 'browser-js' | 'browser-pyodide';    // sandbox 选型依据
  engineerContract: string[];   // 工程师 prompt【全栈契约】段（js = 现文案逐字）
  build(files: BackendFileMap): BackendFileMap; // 预览/物化前纯函数变换；js/py 恒等
  checkSyntax(path: string, content: string): SyntaxReport;   // syntax.ts 改查表分派
  scanDanger(path: string, content: string): Danger[];        // danger.ts 规则按语言注册
  selfCheckHint: string;        // bash 工具描述按项目语言动态拼
}
```

### 3.2 PreviewSandboxProvider 接口

```ts
interface PreviewSandboxProvider {
  readonly kind: 'browser-js' | 'browser-pyodide';
  assemble(input: PreviewInput): PreviewOutput;
}
interface PreviewInput {
  indexHtml: string;             // app/frontend/index.html
  backendFiles: BackendFileMap;  // 已经 profile.build 变换后的后端文件
  profile: LanguageProfile;
}
interface PreviewOutput {
  html: string;
  cspExtras?: { scriptSrc?: string[]; connectSrc?: string[] }; // preview route 合成 CSP
}
```

## 4. 组件明细

### 4.1 三语言行为矩阵

| | javascript | typescript | python |
|---|---|---|---|
| 契约表达 | `module.exports = { handle }`（现状） | `export function handle(method: string, path: string, body: unknown): { code, data?, message? }`，强制类型注解 | `def handle(method: str, path: str, body) -> dict`，纯内存 list/dict |
| build | 恒等 | `typescript.transpileModule` | 恒等 |
| 语法校验 | acorn（现状） | 先转译再 acorn；转译失败 = tsc 报错进重试链 | 放行 + 软警告；预览 boot 抛 SyntaxError 回传 |
| 危险 API | acorn AST（现状） | 转译后复用现有 acorn 规则 | 正则版（见 4.3） |
| 禁止项 | fs/net/进程/timer | 同左 | socket/subprocess/os.system/文件 IO/eval/exec/__import__ |

### 4.2 Pyodide 桥（browser-pyodide.ts）

注入三段：① pyodide CDN loader（`cdn.jsdelivr.net` 固定版本）；② api.py 源码内联 + `runPythonAsync` 求值后 `pyodide.globals.get('handle')`；③ 复用同一 FETCH_SHIM 信封：`window.__ATOMS_BACKEND__ = { handle: (m, p, b) => pyHandle(m, b).toJs() }`，返回 dict 对齐 `{code, data?, message?}`。

boot 竞态：fetch 拦截器返回 Promise，boot 未完成时 await bootPromise（30s 超时转错误信封）；现有「handle === null → 503」分支保留作兜底。

### 4.3 Python 危险 API 正则规则（hard）

`eval(`、`exec(`、`__import__`、`os.system`、`subprocess`、`import socket`。soft：`import requests/urllib`（Pyodide 内不可用，生成即废）。规则名沿用 `DangerRule` 联合扩展。

### 4.4 生成侧

- leader prompt 增一条：默认 javascript；用户明确要求 TS/Python 时选之，决策落 file_tree 交接 summary（架构师据此定入口后缀）。leader zod schema 不变（语言不进路由输出）。
- 快速模式：`pickLanguage` 关键词确定性选型（先例 `pickTemplate`）。
- mock engineer：新增 `renderApiTs`/`renderApiPy` 骨架，按路径后缀路由（先例 `renderIndexHtml`）。

### 4.5 物化投影（终端侧）

TS 项目物化时转译产物投 `__atoms/backend.js`，`__atoms/server.js` require 它（平台内置区语义：幂等覆写、不参与导出/回滚）。JS/Python 项目物化行为不变。终端 Python runner（`__atoms/server.py`）为 P4 演进位。

## 5. 数据流

```
用户需求（含语言意图）→ leader 决策语言／快速模式 pickLanguage
  → file_tree：后端入口 app/backend/api.<ext>（扩展名即语言）
  → 工程师按 profile.engineerContract 逐文件生成（契约段运行时注入）
  → file_end 落库：validation 按 profile 查表校验
  → 预览：入口后缀 → resolveProfileByEntry → sandbox 注册表 → 装配
      js：现状管线（byte 级不变）／ts：build 转译 → browser-js／py：browser-pyodide
  → CSP 合成 cspExtras → iframe（sandbox 依旧 allow-scripts，srcDoc 依旧）
```

## 6. 安全面变化

- **JS 项目 CSP 逐字节不变**。Python 项目预览 CSP 增量：`script-src += https://cdn.jsdelivr.net + 'wasm-unsafe-eval'`；`connect-src` 从 `'none'` 放开仅 `cdn.jsdelivr.net`。增量来自 `cspExtras`，preview route 合成——放宽面收在单个语言的单个 CDN 域。
- 自托管 Pyodide（CSP 收回 `'self'`）留演进位，切片不做。
- TS 转译在服务端进程内，无新供应链面；生成物依旧零 npm 依赖。
- `.claude/rules/07-security.md` 增补「多语言预览」一节。

## 7. 错误处理（可靠性三段式：zod → 带错重试一次 → 回退）

| 故障 | 行为 |
|---|---|
| ts 转译失败 | file_end 校验期拦 → 带错重试 → 仍败则单文件任务失败落 agent_runs.error + SSE error |
| py 语法错误 | 校验放行 → 预览 boot 时 pyodide 抛 SyntaxError → 预览页中文错误横幅 + SSE error → 单文件重试修 |
| pyodide import 禁止模块 | 同上路径，错误信息透传 |
| CDN 加载失败（离线） | previewErrorPage 中文提示页（现先例） |
| 未知后缀 / 入口缺失 | 回退 javascript + 软警告，不炸 |
| boot 超时 | 30s 转错误信封 |

## 8. 测试策略

- **单元**：profile 查表（后缀 → profile / 未知回退）、ts 转译 roundtrip、pyodide 装配 HTML 快照、CSP 合成、py 正则规则、boot-pending 排队语义。
- **集成（mock 全链路）**：python 项目 建 → 生成 → 落库 → 预览装配；ts 项目同。
- **回归护栏**：javascript 项目 assemble 输出与改造前 **byte 级一致**（快照锁死零行为变化）。
- **人工验收**：DEMO-SCRIPT.md 增 Python/TS 演示段（pyodide 真加载、浏览器内 CRUD）。

## 9. 分期（每期独立可 commit）

1. **P1 抽取**：LanguageProfile + PreviewSandboxProvider 落地，javascript 搬入，全仓行为零变化（byte 级回归锁）。
2. **P2 TypeScript**：profile + 转译 + 校验 + mock 骨架 + leader/快速选型 + `__atoms/backend.js` 投影。
3. **P3 Python**：pyodide sandbox + CSP 增量 + 正则危险规则 + mock 骨架 + bash 自检提示。
4. **P4 可选**：终端 `__atoms/server.py`、自托管 pyodide、C++/Java 接口注释位。

## 10. 演进位与明确不做

- C++/Java：`LanguageId` 注释位 + 新增 profile/sandbox 文件即接入（C++ 预期 browser-wasm + 服务端 Emscripten 构建，Java 预期 server-process——届时需重估安全姿态）。
- 多语言混合后端、前端语言变体：不做。
- 校验层 spawn 宿主 python3：不做（违反纯函数契约）；bash 自检提示 `python3 -m py_compile` 已覆盖工程师侧。
