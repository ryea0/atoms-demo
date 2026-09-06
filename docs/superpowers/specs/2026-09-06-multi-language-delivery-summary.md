# 多语言支持（TS + Python 垂直切片）交付总结

> 交付时间：2026-09-07
> 版本区间：`feat/multi-language-plan-start` (24559ad) → `feat/multi-language-ts-python` (822f9df)
> 设计文档：`docs/superpowers/specs/2026-09-06-multi-language-design.md`
> 实施计划：`docs/superpowers/plans/2026-09-06-multi-language-ts-python.md`

## 交付物

后端语言从单一 JavaScript 扩展为 **JavaScript / TypeScript / Python** 三种，同时把语言维度抽象为 DESIGN §12 风格的 Provider+Registry 双注册表架构，C++/Java 未来接入 = 新增文件而不改调用方。

### 核心架构

```
src/lib/languages/                 # LanguageProfile 注册表（新增）
  types.ts                         #   接口：LanguageProfile / LanguageId / PreviewRuntime
  profiles/javascript.ts           #   JavaScript 档案（现契约原样搬入）
  profiles/typescript.ts           #   TypeScript 档案（typescript.transpileModule 转译）
  profiles/python.ts               #   Python 档案（正则危险规则 + 降级放行）
  index.ts                         #   注册表：后缀查表 / 路径集合判定 / 缺省回退

src/lib/preview/sandbox/           # PreviewSandboxProvider（DESIGN §12 兑现，新增）
  types.ts                         #   接口：PreviewInput / PreviewOutput / PreviewSandboxProvider
  browser-js.ts                    #   浏览器 JS 沙箱（原 assemble.ts 逐字节搬入）
  browser-pyodide.ts               #   Pyodide 沙箱（WASM CPython + JSON 信封桥）
  index.ts                         #   注册表：runtime → sandbox + warn-once 回退

src/lib/validation/index.ts        # validateFile 改为按语言档案分派（改）
src/lib/preview/assemble.ts        # 重写为编排器：探测→build→sandbox→CSP 合成（改）
src/lib/agents/roles/engineer.ts   # 工程师契约段按项目语言注入 + buildFastFileTree 语言感知（改）
src/lib/exec/materialize.ts        # TS 项目物化投影 __atoms/backend.js + runner 候选链（改）
src/lib/agents/roles/architect.ts  # 主 prompt + 补发模板语言感知措辞（改）
src/lib/llm/mock.ts                # mock 工程师 .ts/.py 分派（改）
src/lib/agents/roles/samples/app-skeleton.ts  # renderApiTs / renderApiPy 骨架（增）
```

### 三种语言对照

| | JavaScript | TypeScript | Python |
|---|---|---|---|
| 入口 | `app/backend/api.js` | `app/backend/api.ts` | `app/backend/api.py` |
| 运行时 | browser-js（iframe 内原生） | 转译后走 browser-js | browser-pyodide（WASM CPython） |
| 契约 | CommonJS `module.exports = { handle }` | ESM `export function handle(...)` | `def handle(method, path, body) -> dict` |
| 语法校验 | acorn AST | 转译错误 → acorn | 降级放行（boot 抛错横幅兜底） |
| 危险 API | acorn AST 扫描 | 转译后复用 AST 规则 | 正则规则（hard: eval/exec/__import__/os.system/subprocess/socket；soft: requests/urllib） |
| CSP | 基线（零增量） | 基线（转译后 JS） | +script-src: cdn.jsdelivr.net + 'wasm-unsafe-eval'；connect-src: cdn.jsdelivr.net |
| 终端 runner | `__atoms/server.js` 直接 require | `__atoms/backend.js` 转译投影 | P4 演进位 |

### 新增测试文件

```
tests/languages/registry.test.ts              # 注册表 + js 档案
tests/languages/typescript-profile.test.ts     # TS 档案转译/校验/危险扫描
tests/languages/python-profile.test.ts         # Python 档案正则规则
tests/validation/profile-dispatch.test.ts      # validateFile 按语言分派
tests/agents/engineer-prompt.test.ts            # 工程师 prompt 字节一致锁
tests/agents/language-routing.test.ts           # pickLanguage + 快速模式入口
tests/agents/render-api-ts.test.ts              # TS 骨架
tests/agents/render-api-py.test.ts              # Python 骨架
tests/preview/assemble.test.ts                  # JS byte 级回归锁（29 行 FETCH_SHIM）
tests/preview/pyodide-sandbox.test.ts           # Pyodide 装配 + CSP 增量
tests/preview/assemble-typescript.test.ts       # TS 全链路集成
tests/preview/assemble-python.test.ts           # Python 全链路集成
tests/exec/ts-projection.test.ts                # __atoms/backend.js 物化投影
```

## 验证证据

| 验证项 | 结果 | 证据 |
|---|---|---|
| 全量测试 | **783 / 783 通过** | `npx vitest run` |
| JS 项目逐字节零变化 | ✅ byte 锁通过 | `tests/preview/assemble.test.ts` 字面量三段钉死注入点+wrapper+FETCH_SHIM |
| `PREVIEW_CSP` 基线不变 | ✅ 逐字节 | composePreviewCsp(undefined) 原样返回 |
| 工程师 prompt 零漂移 | ✅ md5 一致 | `498e1354d36acaf139b08ce02c04a7dd`（1808 字节） |
| TS 转译 → 运行时 | ✅ acorn 校验通过 + 集成测试 | typescript-profile.test.ts + assemble-typescript.test.ts |
| Python 危险规则 | ✅ 6 条 hard 全中 | python-profile.test.ts |
| Pyodide 沙箱装配 | ✅ loader/桥/lazy 拦截/横幅/CSP | pyodide-sandbox.test.ts |
| 物化投影候选链 | ✅ TS 投影 / JS 回退双路径 | ts-projection.test.ts |
| 生产构建 | ✅ 通过 | `npm run build` |
| lint | ✅ 0 errors | 全量 lint |

## 关键设计决策（Rulings）

1. **不建 worktree/分支，main 就地执行** — 项目 CLAUDE.md 「单人项目直接 main，不做分支仪式」约定优先于 skill 默认。
2. **T2 FETCH_SHIM 逐字节搬迁 = byte 锁测试当裁判** — brief 代码块为占位注释，权威文本 = 原 assemble.ts 42-72 行与测试内 FETCH_SHIM_LOCK 常量。
3. **用户主线持续落提交** — 每批审查范围按任务提交逐颗拼装，圈掉用户主线提交；行号漂移按内容定位锚点。
4. **T3 javascript.ts selfCheckHint 对齐现行文本** — 用户 dbeaa6b 提交新增「命令 ≤500 字符」段，T1 快照早于该提交，照抄 brief 会丢用户新约束；实现者主动对齐是正确适应。
5. **提速合并批次** — P2（T4-T9）、P3（T10-T13）分别合成一次派发一次审查，从 13 周期压到 3 周期；实现者不跑 `npm run build`（用户 dev server 在跑，.next 互踩坑）。
6. **T6 补遗并入 P3** — architect 补发模板写死 api.js 改为语言感知措辞，不单独起任务。
7. **Python 语法校验降级放行** — 无可靠纯 JS Python 解析器，校验层保持纯函数；真校验 = 预览 boot 抛错横幅 + bash 自检 `python3 -m py_compile`（spec 拍板取舍）。
8. **终局不挤压 commit** — 多语言 15 个提交与主线 13 个提交深度交错，rebase 会重写所有主线 hash、干扰其他并行会话；用 tag 标记起讫点替代。

## 演进位（P4 及以后）

- `__atoms/server.py` 终端 runner（Python 项目终端侧真跑）
- 自托管 Pyodide（CSP 收回 `'self'`，离线可用）
- C++（browser-wasm + 服务端 Emscripten 构建） / Java（server-process，需重估安全姿态）接口注释位已留
- Python 危险规则剥注释/字符串后再扫（降低误报）
- `server.js` 候选链 catch 加 `console.error` 定位信息
- renderApiPy 类型强转对齐 JS 模板（非数字 id / 非 dict body → 404/400 而非 500）
- 注册表 re-export 补齐 `typescriptProfile`（已在 must-fix 中修复）
- fast-mode `index.html` depends 语言感知（已在 must-fix 中修复）

## 相关标签

- `feat/multi-language-plan-start` — 计划起点（24559ad，plan 文档提交）
- `feat/multi-language-ts-python` — 交付终点（822f9df，含 must-fix 修复）
