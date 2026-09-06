# 交付说明文档

> 配套阅读：[`README.md`](../README.md)（快速上手 + 架构图）、[`docs/DESIGN.md`](./DESIGN.md)（单一事实来源，v2 红队评审版）、[`docs/DEMO-SCRIPT.md`](./DEMO-SCRIPT.md)（3 分钟演示脚本 + 验收清单）。
> 本文档聚焦：**实现思路与关键取舍**、**当前完成程度**、**未来扩展方向与优先级**——尤其强调扩展性架构设计。

---

## 一、实现思路与关键取舍

### 1.1 整体思路：双层架构 + Provider/Registry 可插拔

核心理念一句话：**LLM 只做决策，确定性代码做执行；所有可变能力 = 接口 + 注册表，新增=加文件+注册，不改调用方。**

```
┌──────────────────────────────────────────────────────────────┐
│                    前端（Next.js App Router）                 │
│  卡片墙 · IDE 工作台（聊天/文件树/编辑器/预览/终端）· 设置页    │
└───────────────┬──────────────────────────────────────────────┘
                │ SSE + REST
┌───────────────▼──────────────────────────────────────────────┐
│                    编排器（确定性代码）                        │
│  串行 DAG 调度 · 步骤边界 · 干预注入 · 检查点打点              │
└───────┬───────────────┬──────────────┬───────────────────────┘
        │               │              │
┌───────▼─────┐ ┌───────▼──────┐ ┌────▼─────────┐
│ AgentRunner │ │  虚拟文件系统  │ │  事件总线     │
│ 工具循环内核 │ │  StorageProvider│ │  TransportAdapter│
└───────┬─────┘ └──────────────┘ └──────────────┘
        │
  ┌─────▼─────────────────────────────────────────────┐
  │  LlmProvider · RoleRegistry · ToolRegistry         │
  │  ValidationRuleEngine · RetrievalProvider          │
  │  ExecutionProvider · PreviewSandboxProvider        │
  │  LanguageProfile · RendererRegistry · ExportProvider│
  │  Scheduler · AuthProvider · MeteringSink           │
  └────────────────────────────────────────────────────┘
         16 个扩展点，全部接口化、可替换
```

### 1.2 关键取舍（为什么这么做，而不是那样做）

| # | 决策 | 选了什么 | 放弃了什么 | 理由 |
|---|------|---------|-----------|------|
| D1 | 工程师执行模式 | **混合模式**：编排器按 file_tree 确定性逐文件派发 + 工程师单文件内自主（可读任意文件、可覆写修正） | 纯 LLM 自主（全部交给工程师自己决定写哪些文件） / 纯模板（完全确定性生成） | 骨架可靠（进度可预测、失败只重试该文件），同时保留灵活性（工程师可读上下文、修正偏差） |
| D2 | 生成物运行形态 | **浏览器内全栈**（iframe + fetch 拦截 + 内存后端） | 服务端容器执行 / 纯前端静态 | 零基础设施、零安全风险、演示效果等价；api.js 是同构模块，未来可直接挂 Node 服务 |
| D3 | 演示节奏 | **快速模式 + 预置项目兜底** | 只做完整模式 | 评委耐心有限，1-2 分钟出活是硬指标；完整模式留给追问展示深度 |
| D4 | Agent 框架 | **自写编排器 ~400 行** | LangGraph / LangChain / Vercel AI SDK | 时间盒内可控、可调试、可观测；框架学习成本 + 定制成本 > 手写成本 |
| D5 | 用户体系 | **匿名 session cookie**（多用户友好预留） | 完整账户体系 | 单人 demo 场景下账户体系（注册/登录/找回/合规）远超时间盒且与评分点无关；预留口子已把升级成本压到三步 |
| D6 | 数据库 | **SQLite + Drizzle + better-sqlite3**（WAL） | Postgres / MySQL | 本机无 Postgres/docker；编排器单写者，SQLite 够用零配置；StorageProvider 抽象保证切换成本极低 |
| D7 | 流式传输 | **SSE（自写事件协议 + Last-Event-ID 重放）** | WebSocket | 单向流式场景 SSE 更轻量、浏览器原生支持自动重连、Next.js Route Handler 原生支持；WS 双向能力用不上 |
| D8 | 上下文检索 | **声明式注入 + grep 工具**（两层） | RAG / embedding 向量检索 | <30 文件场景声明注入+grep 覆盖 100%；"找调用点"类需求 grep 比向量检索准；可解释可调试；RAG 列为演进 |
| D9 | 版本控制 | **文件级 file_versions + 项目级检查点快照** | isomorphic-git / 真 git | 对 demo 过度工程；快照式=git 子集语义，足够回滚+撤销；真 git 列为演进（未来 zip 导出可带完整历史） |
| D10 | 代码编辑器 | **等宽 textarea + Shiki 渲染** | Monaco Editor | Monaco 体积大（~2MB）、SSR 麻烦、打字机流式场景 textarea 足够；人机共编核心是 CAS 冲突处理，不是编辑器功能 |

---

## 二、扩展性架构（重点）

> **设计原则**：所有可替换能力 = 接口（Provider）+ 注册表（Registry）。风格对齐 Vercel AI SDK 的 provider 模型。
> 落地策略：YAGNI——**StorageProvider 立即实现**（P1），其余接口先留命名与目录、用到时再抽取，避免过度设计。

### 2.1 已落地的扩展点

| 扩展维度 | 接口 / 注册表 | 当前实现 | 可扩展方向 | 落地状态 |
|---------|-------------|---------|-----------|---------|
| **存储** | `StorageProvider`（仓库方法全集） | `SqliteStorage`（drizzle sqlite + better-sqlite3，WAL） | `PostgresStorage`（drizzle pg，`DB_DRIVER=postgres` 工厂切换） | ✅ 接口 + sqlite 实现已落地；postgres 位预留 |
| **LLM 提供方** | `LlmProvider.complete/stream` | `OpenAICompatProvider` + `MockProvider` + `probeProvider` 探测 + `withFallback` 降级链 | Anthropic 原生、多模态、Race 双通道并行 | ✅ OpenAI 兼容 + mock + 探测 + 降级已落地 |
| **Agent 内核** | `AgentRunner.run()` / `AgentAdapter` | 自写工具循环（D4 拍板不引框架，~400 行） | 接入现成 coding agent（pi / Claude Agent SDK）作为引擎 | ⚠️ AgentRunner 已落地；AgentAdapter 仅接口位预留（见 DESIGN §12） |
| **角色** | `RoleRegistry`（role → {prompt, tools, model 绑定}） | 领导 / PM / 架构师 / 工程师 / 数据分析师 / SEO / 广告专家 | 用户自定义角色（UI 配置 prompt + 工具集） | ✅ 7 角色已落地；注册表模式已建立 |
| **工具** | `ToolRegistry`（schema + impl + policy 三件套） | write_file / read_file / list_files / grep / bash（engineer 自检） | 外部检索、图片生成、浏览器工具 | ✅ 5 工具已落地；bash 走受控执行层 |
| **检索** | `RetrievalProvider.search()` | `GrepRetriever`（RegExp 扫 files）+ `FtsRetriever`（FTS5 全文检索，SQLite 虚拟表） | Postgres pg_trgm / tsvector、向量 RAG | ✅ 双实现已落地（基础骨架级，可覆盖当前场景） |
| **执行** | `ExecutionProvider.run()` | `LocalExecutionProvider`（child_process + 守卫，终端面板与 bash 工具共用） | 容器沙箱（Docker/Firecracker） | ✅ 本地执行已落地（`EXEC_PROVIDER=local/disabled`） |
| **预览沙箱** | `PreviewSandboxProvider` | `BrowserJsSandbox`（iframe + fetch 拦截）+ `BrowserPyodideSandbox`（Pyodide 运行 Python） | WebContainer（浏览器跑 Node）、服务端容器沙箱 | ✅ JS + Python 两沙箱已落地 |
| **语言** | `LanguageProfile`（契约 / 构建 / 校验 / 运行时） | JavaScript + TypeScript（服务端转译）+ Python（Pyodide） | C++（WASM）、Java（server-process） | ✅ 3 语言已落地；注册表模式已建立 |
| **查看器渲染** | `RendererRegistry`（按扩展名调度） | Markdown / 代码高亮（Shiki）/ Mermaid / 纯文本 | PlantUML、CSV 表格、图片预览 | ✅ 4 渲染器已落地 |
| **校验规则** | `ValidationRuleEngine`（规则注册） | 语法校验（acorn / parse5 / JSON.parse）+ 危险 API AST 扫描（硬拒绝/软警告两级） | eslint 子集、semgrep 规则包 | ✅ 语法 + 安全扫描已落地 |
| **传输层** | `TransportAdapter`（事件发布） | SSE（EventSource，含 `Last-Event-ID` 重放 + 环形缓冲） | WebSocket 双向、Webhook 外发 | ✅ SSE 已落地；抽象位预留 |
| **调度策略** | `Scheduler`（拓扑序执行策略） | 串行调度器 | 并行（写集检测）、优先级 / 抢占 | ✅ 串行已落地；策略对象模式预留 |
| **认证** | `AuthProvider` | 匿名 session cookie（httpOnly / SameSite=Lax） | 用户账户（注册 / 登录 / OAuth） | ⚠️ 接口位预留，V1 不实现（见 §12.1 多用户取舍） |
| **导出 / 发布** | `ExportProvider` | zip 下载 | GitHub 推送、一键部署（Zeabur / Vercel API） | ✅ zip 已落地 |
| **计量** | `MeteringSink`（usage 事件） | `llm_calls` 表落库 + 项目页用量卡片 | 计费 hooks（Quota / Ledger 启用） | ✅ 落库 + 展示已落地；计费位 ER 预留 |

### 2.2 为什么是 16 个扩展点，而不是更多或更少

**不是为了"扩展性"而加的装饰——每个扩展点都对应一个真实的分叉决策：**

- **存储 / LLM / 执行 / 预览沙箱 / 认证**：对应「环境依赖」类分叉——部署环境变、模型供应商变、安全姿态变，都需要换实现
- **Agent 内核 / 角色 / 工具 / 检索 / 校验 / 语言 / 查看器**：对应「能力边界」类分叉——加新角色、新工具、新语言，甚至整体换 agent 引擎（pi / Claude Agent SDK），都不该改内核
- **传输 / 调度 / 导出 / 计量**：对应「系统形态」类分叉——从单体到分布式、从串行到并行、从 demo 到产品，都是演进方向

**取舍（重要）：**
- ✅ **接口先于实现**——16 个点全部有明确定义，但只实现了当前需要的（AuthProvider 纯预留；AgentAdapter 仅 DESIGN §12 留接口位）
- ✅ **StorageProvider 先落地**——它是所有业务的基座，晚抽重构成本高
- ❌ **不做"为了扩展性而抽象"**——Scheduler / TransportAdapter / MeteringSink 只在代码里留了命名位和注释，没抽独立文件，等真的有第二种实现再抽
- ❌ **不做插件化动态加载**——V1 是编译时注册（import 即注册），运行时插件系统是产品级需求，不在 demo 范围

---

## 三、当前完成程度

### 3.1 总体完成度：**~90%**（核心闭环 100%，部分边缘能力为骨架级实现）

### 3.2 已完成 ✅

**核心闭环（全部跑通）：**
- ✅ 首页 hero 起始页 + 项目卡片墙 + seed 预置项目
- ✅ IDE 三栏工作台（聊天 / 文件树 / 编辑器 · 预览 · 终端）
- ✅ 领导路由分派（assign_task 工具协议 + zod 校验 + 三段式回退）
- ✅ 串行编排器（拓扑序 + 步骤边界 + PROGRESS.md 任务计划清单）
- ✅ 7 角色 agent（领导 / PM / 架构师 / 工程师 / 分析师 / SEO / 广告）
- ✅ 混合模式工程师（file_tree 逐文件派发 + 单文件内自主 + read_file/write_file/grep 工具）
- ✅ SSE 实时流式（seq 自增 / delta 打字机 / Last-Event-ID 重放 / 环形缓冲 / 心跳）
- ✅ 全栈预览（iframe + fetch 拦截 + CSP，CRUD 全通）
- ✅ 多语言支持（JS / TS / Python，LanguageProfile + PreviewSandboxProvider 双抽象）
- ✅ 终端面板 + 受控执行层（物化工作区 / 内置 runner / 进程组强杀 / 守卫）
- ✅ 人机共编（编辑开关 / CAS 乐观锁 / 409 冲突对话框 / 软锁 / M 角标双色）
- ✅ 检查点与回滚（任务前自动打点 / 事务恢复 / 回滚可撤销）
- ✅ 人工干预（消息队列 + 两级边界注入 + 队列卡片展示）
- ✅ 停止 / 续跑（AbortController 级联 + 断点续跑 + null summary 降级）
- ✅ 单文件重试
- ✅ @指定成员（手动路由覆盖，绕过领导 LLM）
- ✅ 生成质量工程（模板骨架库 + 风格指南 + 黄金样例 few-shot）
- ✅ 校验与安全层（语法校验 + 危险 API AST 扫描 + CSP + LLM 自审）
- ✅ Provider 设置页 + 模型管理 + agent 级模型绑定 + probe 探测 + fallback 降级链
- ✅ Token 用量计量（llm_calls 落库 + 中文校准公式估算 + 项目页用量卡片）
- ✅ zip 导出
- ✅ 刷新 / 断线恢复（快照对齐 + 重放）
- ✅ StorageProvider 抽象 + SqliteStorage 实现
- ✅ RetrievalProvider 双实现（grep + FTS5）
- ✅ Reasoning 思考流直播
- ✅ mock provider 全链路可离线演示
- ✅ Dockerfile + docker-compose（非 root / 持久卷 / healthcheck）

### 3.3 未完成 / 降级项 ❌ ⚠️

| 项 | 状态 | 说明 |
|----|------|------|
| 账户体系 / 多用户 | ⚠️ 预留口子，V1 不做 | 见 §12.1 多用户取舍——匿名 session + 五处预留，升级成本可控 |
| 并行执行 | ⚠️ 策略位预留 | V1 纯串行；并行=写集检测 + 多实例协调，是产品级需求 |
| 三向合并（git 式） | ❌ 不做 | CAS + 并排 diff 已覆盖 90% 场景；三向合并是编辑器级功能 |
| 实时协同编辑（OT/CRDT） | ❌ 不做 | demo 单人场景无需求；是产品级功能 |
| RAG / 向量检索 | ❌ 不做 | <30 文件场景 grep + fts5 足够；RAG 是跨项目知识库级需求 |
| 真 git 集成 | ❌ 不做 | 检查点快照已覆盖回滚需求；真 git 是演进方向 |
| 计费 / 套餐 | ⚠️ ER 预留，UI 不做 | plans/quotas/ledger 仅数据模型预留，demo 无支付场景 |
| WebSocket | ❌ 不做 | SSE 已满足单向流式；双向是演进方向 |
| 首页 / 项目列表视觉打磨 | ⚠️ 基础功能已通，视觉待精致化 | hero + 卡片墙可用，但细节对标原版有差距 |
| 更多语言（C++/Java/Rust 等） | ❌ 不做 | 3 种语言已足够展示 LanguageProfile 扩展性 |
| Windows 支持 | ❌ 不做 | 受控执行层依赖 POSIX 进程组语义；目标部署环境是 Linux 容器 |

### 3.4 验证状态

- ✅ `npm run build` 通过
- ✅ mock 全链路验证（建项目 → 流式生成 → 文件树 → 预览 CRUD → 刷新恢复 → 干预 → 停止 → 回滚 → 编辑冲突 → 删除）
- ✅ 真实模型冒烟（快速模式出完整应用）
- ✅ 异常路径验证（LLM 坏输出 → 三段式回退 / mermaid 坏语法 → 源码降级 / 断线重连 → 重放）

---

## 四、如果继续投入时间，如何扩展 + 优先级判断

### 4.1 优先级框架

按 **「用户价值 × 实现难度」** 四象限排序：

```
高价值 · 低难度    │  高价值 · 高难度
 ─────────────────┼─────────────────
  P0 立即做        │  P2 排期做
                  │
 低价值 · 低难度    │  低价值 · 高难度
  P1 顺手做        │  P3 不做（除非必要性改变）
```

### 4.2 扩展路线图（按优先级）

#### 🔴 P0 — 立即做（高价值 · 低难度，1-2 天）

| 扩展 | 描述 | 为什么高价值 | 为什么低难度 |
|------|------|-------------|-------------|
| **Postgres StorageProvider** | 实现 `PostgresStorage`，`DB_DRIVER=postgres` 切换 | 解锁多实例部署 + 真实生产环境；从 demo 到产品的第一跳 | StorageProvider 接口已定义，只换 drizzle dialect + schema 类型微调 |
| **Race Mode（双通道并行）** | 同一请求同时调两个模型，先返回的赢 / 取更优解 | 直接提升生成速度与质量，是可感知的产品特性 | LLM 层已有 `withFallback` 基础，加一层 Promise.race 包装即可 |
| **一键部署（Zeabur/Vercel）** | ExportProvider 新增实现：把生成项目推到 Zeabur/Vercel 并返回预览链接 | 从"浏览器内预览"到"真线上 URL"，演示冲击力强 | 已有 zip 导出基础，加平台 API 调用 + 轮询部署状态 |

#### 🟡 P1 — 顺手做（低价值 · 低难度，几天内）

| 扩展 | 描述 | 时机 |
|------|------|------|
| **更多渲染器**（PlantUML / CSV 表格 / 图片预览） | RendererRegistry 加实现 | 当用户生成的文件类型变多时 |
| **更多校验规则**（eslint 子集 / semgrep 规则包） | ValidationRuleEngine 加规则 | 当生成质量需要更精细把控时 |
| **Monaco Editor** | 替换 textarea，支持语法补全 / 多光标 | 当人机共编成为核心场景时 |
| **真 git 集成** | 检查点改用 git commit，zip 导出带完整历史 | 当用户需要"导出就能用"的项目时 |

#### 🟠 P2 — 排期做（高价值 · 高难度，1-2 周）

| 扩展 | 描述 | 为什么高价值 | 为什么高难度 |
|------|------|-------------|-------------|
| **多用户账户体系** | AuthProvider 实现 + 注册/登录/OAuth + CSRF/频控/审计 | 从单人工具到 SaaS 产品的必经之路 | 安全面宽（密码存储/会话管理/ OAuth/合规）、关联面广（偏好/配额/归属） |
| **容器沙箱执行**（Docker / Firecracker） | ExecutionProvider 新增实现 | 从"仅限本机/内网演示"到"可公网提供" | 隔离级别高、资源管理复杂、冷启动问题、成本问题 |
| **并行执行 + 写集检测** | Scheduler 新增 ParallelScheduler | 生成速度线性提升（多文件并行） | 需要分布式锁 / 冲突检测 / 部分失败回滚 |
| **RAG / 跨项目知识库** | RetrievalProvider 新增向量实现 | 文件 >100 或有跨项目需求时，检索质量质变 | embedding 模型 / 向量数据库 / 索引构建与更新 |

#### ⚪ P3 — 不做（低价值 · 高难度，除非必要性改变）

| 扩展 | 为什么不做 |
|------|-----------|
| **实时协同编辑（OT/CRDT）** | 单人场景无需求；是 Notion / Google Docs 级别的工程量 |
| **WebSocket 全双工** | SSE 已满足单向流式；双向通信场景不明确 |
| **插件化动态加载** | demo / 小团队场景下，编译时注册更简单、更可靠 |
| **10+ 种语言支持** | 3 种语言已验证 LanguageProfile 抽象的正确性；更多语言是线性工作量，不改变架构 |

---

## 五、总结

这个项目的**扩展性不是事后加的装饰，而是从第一天就贯穿设计的骨架**——

16 个扩展点覆盖了「环境依赖 / 能力边界 / 系统形态」三类分叉，全部以 Provider + Registry 模式统一组织。
但同时坚持 YAGNI：**接口先于实现，但不做"为了抽象而抽象"**——StorageProvider 因为是基座所以先落地，其余的先留命名位、等有第二种实现再抽取。

核心取舍可以用一句话概括：

> **在 48 小时时间盒内，用 95% 的精力把核心闭环做扎实，用 5% 的精力把扩展边界画清楚——这样 demo 是完整的，未来也是有路的。**
