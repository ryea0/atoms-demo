# CLAUDE.md

> 状态：文档先行。下方命令/目录为**规划**（P0 起逐项落地，落地前的条目以 〰 标注），架构规则与设计决策以 `docs/DESIGN.md`（v2）为准。

## 项目

Atoms-Demo：多智能体团队驱动的应用生成平台（网页版 mini-Atoms，笔试挑战项目）。
用户一句话需求 → 领导 agent 路由分派 → PM/架构师/工程师接力产出 PRD、架构设计（mermaid 图）、全栈代码 → IDE 式界面实时可视化（文件树生长、打字机流式）→ 一键预览全栈应用（浏览器内后端，fetch 拦截装配）。

**必读**：
- `docs/DESIGN.md` v2——已拍板决策（D1 混合执行模式 / D2 浏览器内全栈 / D3 快速模式+预置项目 / D4 全量范围）、leader 工具协议 zod schema、SSE 恢复语义、预览契约、**§12 扩展性架构（Provider+Registry）**
- **`.claude/rules/01-07`——写码必须遵守的业界规范**：01 TypeScript / 02 Next.js App Router / 03 React / 04 Tailwind / 05 Drizzle+SQLite / 06 SSE 流式 / 07 安全。技术栈相关代码改前先读对应规则文件。

## 技术栈（已定，勿随意更换）

- Next.js 15 App Router + TypeScript(strict) + Tailwind CSS + shadcn/ui
- SSE 流式（Route Handler + ReadableStream，自写事件协议含 seq/Last-Event-ID；不用 WebSocket；stream 路由 force-dynamic + 禁缓冲）
- 自写 Agent 编排器（不上 LangGraph/LangChain）
- react-markdown + Shiki（代码高亮）+ mermaid（渲染失败降级显示源码）
- SQLite + Drizzle ORM（sqlite dialect + better-sqlite3，WAL；文件 `data/app.db`）
  - 原因：本机无 Postgres、docker daemon 不可用；编排器单写者，够用零配置。升级路径：换 pg dialect + DATABASE_URL，仓库层不变
  - **方言注意：没有 jsonb，JSON 一律 TEXT 存取（repo 层封装 parse/stringify）**
- LLM：OpenAI 兼容 API（env 晚绑定）+ mock provider（`LLM_PROVIDER=mock`，行为规格见 DESIGN §5⑥）；dev 真实冒烟可用本机 DASHSCOPE_API_KEY（不进 git）

## 命令 〰

```bash
npm run dev          # 开发（默认 mock，配 env 即真实模型）
npm run build        # 生产构建（提交前必须通过）
npm run lint         # eslint
npm run db:push      # 应用 Drizzle schema 到 SQLite
npm run seed         # 预置演示项目（P3）
```

## Git 纪律

- 每个任务（P0..P5）完成且验证后 commit；feat/fix/chore 前缀，message 英文
- 不提交：`.env*`、`data/*.db`、`node_modules`；首次 commit 前检查 .gitignore 覆盖
- 分支：单人项目直接 main，不做分支仪式

## 目录结构 〰（约定，落地时遵循）

```
src/app/                 # /（卡片墙）、/p/[id]（工作台）、/settings（模型管理）
src/app/api/             # projects、projects/[id]/stream(SSE|stop|messages|preview|export|files/[fid]/regenerate)、settings
src/components/          # file-tree/ viewer/ chat/ timeline/
src/lib/agents/          # runner.ts(AgentRunner) orchestrator.ts(串行DAG+干预+停止) roles/(角色prompt+工具)
src/lib/agents/roles/samples/   # 黄金样例（few-shot + seed 用）
src/lib/agents/tools/    # write_file 等（路径沙箱校验在此，闭包绑定 project_id）
src/lib/exec/            # 受控执行层（终端/bash 自检：物化+守卫+进程管理，EXEC_PROVIDER 开关）
src/lib/db/              # schema.ts、index.ts、repo/（强制 project_id 过滤）
src/lib/llm/             # client.ts(openai兼容+mock)、usage.ts(llm_calls 落库+估算降级)
scripts/seed.ts          # 预置项目
docs/DESIGN.md           # 设计文档（单一事实来源）
```

## 核心架构规则（改代码前对照）

1. **双层架构**：LLM 只做决策（领导路由分派、角色产出）；确定性代码做执行（串行 DAG 调度、SSE、落库、进度）。不把调度写进 prompt，也不让代码替模型决策。
2. **V1 纯串行执行**：编排器按拓扑序逐任务跑，无并发写路径；per-path 写锁只是防御层。
3. **工程师混合模式（D1）**：编排器按 file_tree 逐文件派发单文件任务；工程师任务内自主（read_file 任意、write_file 目标文件+可覆写修正）。**单文件重试 = 重跑该单文件任务**。
4. **全栈预览契约（D2）**：backend 只能是无框架同构模块 `handle(method, path, body)`（内存态、禁 fs/net）；预览 = 服务端把 api.js + fetch 拦截垫片注入 index.html。生成应用禁用 localStorage（iframe 无 same-origin）。
5. **可靠性三段式**（所有 LLM 工具调用）：zod 校验 → 带错误重试一次 → 回退默认流水线。
6. **虚拟文件系统**：agent 读写只操作 files 表（per project_id），路径必须过沙箱校验（拒 `../`、绝对路径）；命令执行一律走**受控执行层** `src/lib/exec/`（2026-09-06 增补：终端面板 + engineer bash 自检，演示姿态守卫见 rules/07——仅限本机/内网，物化投影 `data/workspaces/`）。
7. **子任务交接**：任务间零历史共享，只传 agent_runs.summary + 按需重读文件；中断无 summary 用文件清单拼降级摘要。
8. **SSE 协议**：`{seq, projectId, runId, event, agent?, path?, content?, summary?, error?}`；**落库时机=file_end**（delta 只走 SSE，内存缓冲）；断线重连 Last-Event-ID 重放。新增状态要同时改协议与前端。
9. **仓库层纪律**：所有查询强制 `WHERE project_id = ?`；干预队列 = messages 表（role=intervention AND delivered_at IS NULL）。
10. **LLM 调用必须走 src/lib/llm/**（统一 llm_calls 计量；usage 缺失按 DESIGN §4.4 中文校准公式估算并标 estimated）。
11. **人机共编**（DESIGN §3.9）：**编辑能力开关**（顶栏+设置页，preferences.editing_enabled，默认开）控制是否启用人工编辑；人工编辑与 agent 写入走**同一 write API + 同一 CAS 乐观锁**；agent 写文件前检查 editing_by 软锁，冲突时聊天区请求裁决；人工修改清单进 MEMORY 注入工程师上下文（防语义冲突）。

## 编码约定

- TypeScript strict；新文件一律 TS/TSX
- 注释与用户可见文案中文；标识符、commit message 英文
- 组件放 `src/components/`，服务端逻辑放 `src/lib/`；编排逻辑不进组件
- env 只在服务端读取；密钥不进代码、不进前端 bundle、不进 git
- 错误处理：agent 步骤失败落库（agent_runs.error）+ SSE 发 error 事件，不静默吞

## 验证（宣称"完成"前必须跑）

1. `npm run build` 通过
2. mock 全链路：建项目→流式生成→文件树长文件→预览 CRUD→刷新恢复
3. 异常抽查：停止、单文件重试、干预注入
4. 真实模型冒烟（至少一次，快速模式出完整应用人工验收）

## 环境变量（.env.local，不入 git）

```
LLM_PROVIDER=mock|openai        # 默认 mock
LLM_BASE_URL=                   # OpenAI 兼容地址
LLM_API_KEY=
LLM_MODEL=                      # 默认模型
# 角色级覆盖（可选）：LLM_MODEL_LEADER / LLM_MODEL_ENGINEER ...
```
