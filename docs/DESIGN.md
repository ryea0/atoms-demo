# Atoms-Demo 设计文档

> 多智能体团队驱动的应用生成平台（笔试挑战：48h 硬上限，建议有效投入 6-8h——本项目按 14-16h 规划，超出建议值，已知悉并接受）
> 状态：已评审 + 红队拷打修订 v2（2026-09-05），随实施持续更新；同日增补 D5/§12.1（多用户取舍）
> 挑战原文：实现一个可运行网页应用，具备类似 Atoms 的能力与 UI 交互体验——通过智能体驱动的方式完成代码（应用）生成，并将生成的应用以可视化形式展示。交付硬性要求：真实交互、数据持久化、基本流程完整、至少一个扩展能力、可测试线上链接（非 PoC）。

## 已拍板决策（红队评审结论）

| # | 分叉 | 决策 |
|---|---|---|
| D1 | 工程师执行模式 | **混合**：编排器按 file_tree 确定性逐文件派发（骨架可靠），工程师在单文件任务内自主（可读其他文件、可覆写修正） |
| D2 | 生成物范围 | **全栈可运行**——浏览器内全栈方案（见 §3.7 预览契约），非服务端执行 |
| D3 | 演示节奏 | **快速模式 + 预置项目兜底**（完整流水线留给评委追问） |
| D4 | 范围 | 维持全量范围（14-16h，48h 硬上限内） |
| D5 | 用户体系 | **单人匿名 session，多用户友好预留**——隔离/偏好/计量/存储/认证五处留口子（§12.1），V1 不实现账户体系 |

## 1. 产品定义

**一句话**：网页版 mini-Atoms（对标 atoms.dev / bolt.new，架构上与 Claude Code 的 subagent 机制同构）——用户输入一句话需求 → 智能体团队接力（领导分派 → PM 出 PRD → 架构师出设计+图 → 工程师逐文件写码）→ 全程 IDE 可视化（文件树实时生长、内容打字机流式追加、Markdown/代码/图表渲染）→ 一键预览生成的全栈应用。

**多角色智能体团队**：
| 角色 | 职责 | 产出 |
|---|---|---|
| 团队领导 | 意图路由 + 动态分派 + 收尾汇报 | 任务 DAG、MEMORY.md |
| 产品经理 | 需求分析 | docs/prd.md |
| 架构师 | 技术选型/架构设计（功能、并发、安全、UI） | docs/system_design.md + 5 张图 + file_tree.md（结构化 JSON） |
| 工程师 | 按设计实现全栈代码 | app/frontend/index.html、app/backend/api.js、start_app.sh |
| 数据分析师/SEO/广告专家（可选） | 专项报告 | docs/ 对应报告 |

**产出文件结构**（对标 Atoms 实测）：
```
docs/    prd.md · system_design.md · file_tree.md
         architecture.mmd · er_diagram.mmd · sequence_diagram.mmd · class_diagram.mmd · ui_navigation.mmd
app/     frontend/index.html · backend/api.js · start_app.sh
.atoms/  reports/PROGRESS.md · MEMORY.md · PREFERENCES.md
```
（图用 mermaid 而非 PlantUML：纯客户端渲染零后端依赖；渲染失败兜底：显示源码+错误提示）

## 2. 界面形态（对标 Atoms 原版截图，2026-09-05 实测）

**应用骨架 = 全局左侧边栏 + 三个页面**（首页 / 我的项目 / 工作台 `/p/[id]`）：

```
┌───────────┬─────────────────────────────────────────────┐
│ 侧栏 240px │  页面主区（首页 hero / 项目列表 / 工作台）      │
│ ⚛ logo    │                                             │
│ ─────────│                                             │
│ 🏠 首页    │                                             │
│ 🗂 我的项目 │                                             │
│ ─────────│                                             │
│ 最近       │                                             │
│ ·会话A    │                                             │
│ ·会话B    │                                             │
│ (hover␡)  │                                             │
│ ─────────│                                             │
│ 底部:头像  │                                             │
│ ⚙设置 🔔  │                                             │
└───────────┴─────────────────────────────────────────────┘
```

**首页（hero 起始页，对标原版）**：居中布局——agent 团队彩色头像排（7 角色，正好呼应多智能体）→ 大标题「输入想法，产出产品」→ **核心大输入框**（20px 圆角卡片：placeholder「描述你想构建的应用…」、⊕附件位、@成员、快速/完整模式胶囊、黑色圆形发送↑）→ 快捷示例 chips（番茄钟/待办/数据看板，点击填入）→ 顶部通栏公告条（模型上新/版本提示，可关闭）。**提交即建项目并跳转工作台开始生成**。

**我的项目 tab**：项目卡片墙——每卡显示：标题（可重命名）、需求摘要、**最近会话摘要**（最后一条消息预览）、状态徽章（进行中/完成/失败/已停止）、模式标签（快速/完整）、文件数、token 用量、更新时间；卡片操作：**删除（二次确认，级联删数据）**、重命名（inline）、导出 zip、进入工作台；空态引导去首页创建；seed 预置项目在此展示。

**最近（侧栏）**：最近会话时间倒序（最近 8 条），点击直达工作台，hover 显示删除。

**工作台 `/p/[id]`：三栏 + 顶部全局条**（布局与原版一致：聊天左 / 文件树中 / 编辑器右）：

```
┌──────────────────────────────────────────────────────────────┐
│ 顶部条(50px)：logo · 项目标题下拉 · 视图切换tab[编辑器|预览] · agent头像组 · 设置 │
├───────────────┬─────────────┬────────────────────────────────┤
│ 聊天区 ~30%     │ 文件树 ~20%   │ 编辑器/预览区 ~50%（主区）          │
│ · 消息流        │ · 搜索框      │ · tab 页签（多文件打开，×关闭）      │
│ · 任务时间线     │ · 树形结构     │ · Markdown 渲染（表格/引用徽章）    │
│   (圆点+竖线)   │ · 修改M角标   │ · 代码高亮（Shiki）               │
│ · 工具调用卡片   │ · 生成中流式   │ · mermaid 渲染（失败降级源码）      │
│   (📄读文件…)  │   图标/完成✓  │ · 打字机自动滚动                   │
│ · 干预注入提示   │ · ⬇下载项目   │ · [预览tab] iframe 全宽 App Viewer │
│ ├─────────────┤   (zip导出)  │   （全栈预览，fetch 拦截装配）      │
│ │ 底部固定输入卡 │              │                                  │
│ │ 大圆角+发送↑  │              │                                  │
│ │ @成员浮层/chip│              │                                  │
│ │ 停止⏹/模式开关│              │                                  │
└───────────────┴─────────────┴────────────────────────────────┘
```

对标原版的关键细节：
- 聊天区：消息无气泡底色直接排列；agent 动作以**工具调用卡片**呈现（📄 读取文件 xxx.md）；**任务时间线**=小圆点+竖向连线；底部**大圆角输入卡片**（+附件位、**@成员浮层/chip**、黑色圆形发送↑、运行中变停止⏹）
- 文件树：顶部搜索框、类型图标、**M 蓝色角标=AI 已修改**（生成中=流式图标）、底部下载项目按钮、选中行浅蓝高亮圆角
- 编辑器：tab 页签、渲染态 markdown、右上动作图标（复制/下载/全屏）
- 视觉风格：**浅色主题**、极简生产力工具风（白/#F7F7F8 背景、蓝色强调、黑色点睛）、8-12px 圆角、几乎无阴影、无衬线正文+等宽文件名
- 差异化保留：Agent 状态时间线（并入聊天区）、快速/完整模式开关、项目状态徽章

**首页**：项目卡片墙（对标 App World）——标题/需求摘要/状态徽章/文件数/token 用量/模式标签；首次访问 seed 预置项目

## 3. 智能体编排——双层架构：LLM 决策 + 确定性执行

### 3.1 领导层（意图路由 + 动态分派）
领导是带工具循环的 agent，工具（zod schema 已定）：
```
reply_to_user(content: string)                        // 直接回答，结束本轮
assign_task({                                          // 一次调用=一个任务，可多次调用
  task_key: string,          // LLM 自拟短标识，如 "pm-prd"，供 depends_on 引用
  agent: 'pm'|'architect'|'engineer'|'analyst'|'seo'|'ads',
  instruction: string,       // 任务指令（该角色的目标与边界）
  writes_paths: string[],    // 预估写路径前缀（如 ["docs/"]、["app/frontend/"]）
  depends_on?: string[]      // 前置任务的 task_key 列表
})
finish()                                               // 无更多任务
```
用户自由输入、无需指定 agent，自动路由四类意图：新建需求→任务 DAG；迭代修改→只派工程师；咨询问答→reply_to_user；单领域专项→只派对应专家。编排器循环收集 assign_task 直到 reply_to_user/finish/maxSteps。

**@ 指定成员（手动路由覆盖，对标原版 @Sarah）**：输入 `@` 弹成员浮层（头像+职责，数据源=RoleRegistry，自定义角色自动出现），可多选，选中渲染为 chip。消息带 `mentions: AgentRole[]`：非空则**绕过领导 LLM 路由**直接建任务（省一次调用），跑完由领导收尾汇报保持闭环；多 @ 串行接力；时间线显示「⭐ 用户指定 → 工程师」。

### 3.2 执行层（按角色分配自主权）
- PM / 架构师：结构化单发产出（决策空间小，最可靠）
- 工程师（D1 混合模式）：**编排器按 file_tree.json 顺序逐文件派发"单文件任务"**（骨架确定性：进度可预测、失败只重试该文件）；工程师在单文件任务内自主——上下文含 system_design 摘要+file_tree 全文+相关已生成文件，可用 `read_file` 读任意已生成文件、`write_file` 写目标文件（也允许覆写修正其他文件），写完目标文件即任务完成

### 3.3 运行时（手写确定性编排器 ~400 行）
- **执行模型：V1 纯串行**——按拓扑序逐任务执行，无并发写路径；assign_task 的 writes_paths 仅做校验与展示（并行执行+写集检测列为演进方向，不在本期）
- 职责划分：拆分任务=领导（LLM）；标记进度=编排器（代码：步骤边界更新 agent_runs + 模板化追加 PROGRESS.md）；收尾总结=领导（一次 LLM 调用写"领导汇报"）。首尾是智能，中间是执行

### 3.4 可靠性三段式（每个 LLM 决策点统一套用）
1. 工具参数 schema 约束（zod 校验）
2. 校验失败 → 带错误信息重试一次
3. 仍失败 → 回退默认流水线（PM→架构师→工程师；迭代场景回退为直接派工程师）

**自主权分配原则**：任务分派错代价小→给 LLM 自由；文件内容错代价大→单文件粒度+重试兜底。

### 3.5 人工干预（Human-in-the-Loop）
1. **暂停/停止**：停止图标 → AbortController 取消进行中 LLM 调用、agent_runs 标 stopped、已生成文件保留；新指令可从断点续跑（幂等落库；**中断 run 无交接摘要时，续跑用其已产文件清单拼装降级摘要**）
2. **运行中追加指令**：不打断当前文件生成；编排器在**两级边界**检查待注入消息并拼进下一步上下文——任务边界（必检）+ 工程师任务的文件边界（每文件完成间检，2026-09-06 增强把插入延迟从任务级压到文件级）；聊天区以**队列卡片**展示积压的待注入消息（内容+「将在下一边界注入」标注，T19）；时间线显示"📥 已注入下一步骤"。**队列载体=messages 表**（role='intervention'，delivered_at IS NULL 即待注入 FIFO，注入后打时间戳）。**不做**中断当前 LLM 调用的中途插入（abort 烧半截内容+整文件重跑，代价>收益）

### 3.6 流式协议（SSE，含恢复语义）
```
{seq, projectId, runId, event, agent?, path?, content?, summary?, error?}
event: agent_start | file_start | delta | file_end | agent_end | message | intervention_injected | reasoning | done | stopped | error
```
- **落库时机= file_end**（delta 只走 SSE 不落库，消除写放大；编排器内存缓冲当前文件全文）
- **reasoning（2026-09-06 T31）= 思考流直播，ephemeral**：只走 SSE，不进环形缓冲、不进内存缓冲——断线重连/刷新**不重放**思考流，快照也不含（现场感糖，落库与重放开销不值）；seq 照常单调分配，故重放窗口内允许跳号。前端在聊天区渲染「谁在思考/正在写哪个文件」的直播块，窄屏单栏也能看到过程
- **刷新/断线恢复**：`GET /api/projects/[id]` 返回快照（files 表当前内容 + agent_runs 状态 + **正在生成文件的内存缓冲全文**）；SSE 重连带 `Last-Event-ID=seq`，服务端从内存事件环形缓冲（最近 500 条）重放
- Next.js 注意：stream 路由 `force-dynamic`、响应禁用缓冲；反代（nginx/Zeabur 网关）需关 proxy buffering

### 3.7 全栈可运行预览契约（D2）
- **工程师约束**：`app/backend/api.js` 为**无框架同构 JS 模块**——导出 `handle(method, path, body) -> {code, data?, message?}`（`code` 携带 HTTP 状态语义，预览垫片映射为 Response.status；T13 评审裁决 6(b)，2026-09-06 修订），数据存内存 Map/数组，禁止 fs/net/进程/timer API；`app/frontend/index.html` 一律通过 `fetch('/api/...')` 调后端（标准契约）；纯前端应用（无后端需求）可不产 api.js
- **预览装配（服务端拼接）**：`GET /api/projects/[id]/preview` 取 index.html，在 `<head>` 顶部注入运行时垫片：① api.js 源码（内联）② fetch 拦截器把 `/api/*` 路由到内存 handler ③ 再执行应用代码。模型无法"忘记"垫片（注入是服务端行为）
- 效果：CRUD 全流程在预览中真实可用（内存态，刷新重置）；api.js 是真交付物（同构模块，未来可直接挂 Node 服务）
- 取舍（写进 README）：服务端真执行需容器沙箱（Docker/Firecracker），列为演进方向；浏览器内全栈零基础设施、零安全风险、演示效果等价
- **iframe 已知限制**：`sandbox="allow-scripts"`（无 allow-same-origin）→ 生成应用不可用 localStorage/cookie（工程师 prompt 明确引导用内存/后端模块存态）；Tailwind CDN 正常可用

### 3.8 快速模式（D3）
- 领导路由识别 UI 模式开关（默认快速）：快速模式跳过完整文档链——精简 PRD（半页）+ 精简设计（单图）→ 工程师按**内置应用模板骨架**直接生成单文件应用，1-2 分钟出活
- 完整模式产全部文档与图，供评委追问时展示
- **预置项目**：首次启动 seed 2-3 个成功项目（`scripts/seed.ts`，由真实模型预跑或高质量手写样例），作为演示保底与首页卡片墙初始内容

### 3.9 人机共编与冲突处理（红队评审第 2 轮新增）

**编辑能力开关**：顶栏 + 设置页（preferences，session 级 `editing_enabled`，默认开）。关=纯只读查看器、agent 永不遇软锁（演示纯 agent 流程用）；开=完整人机共编。对标原版编辑付费门控的权限边界叙事。

人工可编辑代码（对标原版付费核心功能），冲突防线三层：

1. **预防（声明式软锁）**：人开始编辑 → 文件标记 `editing_by=human`（TTL 10min）；agent 写同文件前在步骤边界检查——有未保存人工修改则该文件任务挂起，聊天区请求裁决（保留人工修改并迭代 / 覆盖 / 稍后）。裁决等待无独立硬超时：锁 TTL 到期即按「稍后」收场（该文件本轮不动），用户停止可立即打断等待（2026-09-06 T23 评审裁定留档）
2. **检测（乐观锁 CAS）**：人工保存带 `base_version`，`UPDATE...WHERE version=base_version` 失败 ⇒ 409 → 冲突对话框（用我的版本 / 用 agent 版本 / 并排 diff 后选）
3. **溯源与语义防冲突**：`files.last_editor`（agent 角色/human）；M 角标双色（蓝=agent、绿=人）；MEMORY.md 记录人工修改清单，工程师迭代上下文注入「以下文件含用户手动修改，必须保留其意图」+ 永远读 DB 最新快照

- 文本冲突用 CAS；**语义冲突（agent 全量重写冲掉人工定制）靠 prompt 约束+快照+清单注入**——这是最隐蔽的坑，重点防
- 三向合并（git 式）不做，列为演进方向；不做实时光标协同（OT/CRDT）
- 交互：查看器右上「编辑」按钮进编辑态（等宽 textarea，不上 Monaco）；agent 流式生成该文件时顶部横幅警告
- **人写路径也必须走统一 write API**（与 agent 同一入口、同样落 file_versions）

### 3.10 检查点与回滚（双层，不嵌真 git）

不用 isomorphic-git（对 demo 过度工程；快照式版本控制=git 子集语义，真 git 列为演进——未来 zip 导出可带完整历史）：

**① 文件级**：`file_versions`（已设计）——覆盖写时旧版本入历史，查看器侧栏版本列表一键恢复。

**② 项目级检查点**：`checkpoints(id, project_id, label, agent_run_id?, created_at)` + `checkpoint_files(checkpoint_id, path, content)`（全量快照，<30 文件×20KB≈600KB/个，SQLite 无压力；引用去重优化标注不做）。打点时机：**每个 agent 任务开始前自动**（"任务前基线"）+ 人工保存前（并入 file_versions）+ 可选手动打标。回滚 `POST /api/projects/[id]/checkpoints/[cpId]/restore`：事务内恢复 files（当前内容先入 file_versions，**回滚可撤销**），相关 agent_runs 标 rolled_back。UI：时间线任务节点「回到此任务前」/ 失败后领导聊天区建议回滚（一键）/ 查看器版本侧栏。

**③ 生成错误回滚策略**：单文件校验失败→重试→仍败：只标 ⚠ 该文件+单文件重试，不自动全项目回滚；任务中途挂→已生成文件保留（续跑友好）+时间线回滚入口；整体失败→领导建议回滚（人拍板，半自动）。

## 4. Harness 运行时设计

### 4.1 上下文组装器
```
[SystemPrompt（角色+输出契约）]
[个人偏好 preferences（session 级）]
[项目偏好 .atoms/reports/PREFERENCES.md + 长期记忆 .atoms/reports/MEMORY.md]（路径以 §1 结构定义为准，2026-09-06 统一）
[文件上下文：file_tree + 依赖声明文件全文（按 token 预算裁剪）]
[任务指令 + 上游交接摘要 + 待注入干预指令]
```

**相关代码检索：两层策略（不用 embedding）**
- **第 1 层 自动注入（规则式）**：file_tree.json 即检索索引——架构师为每个文件声明 `desc`（职责）+ `depends`（依赖文件）。工程师接到单文件任务时，编排器按 depends 声明直接拉取依赖文件全文注入；固定注入 file_tree 全文（项目全貌）+ system_design 相关章节；兜底启发式：无声明时按路径规则补（写 frontend 必注入 api.js、写 backend 必注入调用页）。**把检索问题前置成设计问题，一次声明每次复用**。
- **第 2 层 主动检索（工具循环）**：`read_file`（读任意已生成文件）/`grep`（正则扫 files 表，如"这个 API 谁在调"）/`list_files`——Claude Code 同款模式，模型按需自取，检索行为全落库可审计。
- 不用 RAG 的理由：<30 文件场景声明注入+grep 覆盖 100%；"找调用点"类需求 grep 比向量检索准；可解释可调试。RAG 列为演进（文件>100 或跨项目知识库）。
- 预算典型构成（上限 24k 字符）：file_tree ~1k + 依赖文件全文 ~12k + 设计章节 ~4k + 指令/交接 ~2k，超限触发 §4.4 裁剪。

### 4.2 记忆与偏好
- 短期=当前 run；长期=`MEMORY.md`（领导收尾写入，下次迭代注入）
- 两级偏好：项目级 `.atoms/reports/PREFERENCES.md`（设置页或领导 update_memory 捕捉）；个人级 `preferences` 表（scope=session）。demo 做项目级+session 级

### 4.3 子任务交接协议（防漂移）
每个任务结束产出结构化交接摘要（`agent_runs.summary`：完成内容/产出文件/关键决策/下游注意事项）；下一任务**全新上下文**（零历史共享），只注入 需求+交接摘要+按需重读文件。中断无 summary 时用文件清单拼装降级摘要。

### 4.4 上下文压缩（规则式）+ token 估算
- **中文场景校准**（修正 v1 的 chars/4）：中文 ≈1.2 token/字、代码/英文 ≈ chars/3.5，混合估算 + 20% 裕量
- 预算数值（v1 定值）：工程师单文件任务 maxSteps=12；单次调用 max_output=4096 token；组装上下文上限 24k 字符，超限分级裁剪（非相关文件→文件树、旧消息→recap、system_design→相关章节）
- 不引入 RAG（演进方向）

### 4.5 工具与沙箱
模型只发起调用，执行者是 AgentRunner 内核注册的服务端函数（schema+实现+策略）。工具集：`write_file/read_file`（必备）、`list_files/glob`（轻量）、`grep`（可选 LIKE）；**不做 bash**。沙箱两级：文件沙箱=虚拟文件系统（files 表 per project_id，路径校验拒绝 `../`/绝对路径）；执行沙箱=iframe sandbox（§3.7）。

### 4.6 防失控
工具结果截断（大文件首尾 200 行+行数提示）、maxSteps、token 预算、单步超时重试。超时语义按路径区分（2026-09-06 真机探针修订：ARK plan + seed 推理模型流式健康——均隔 0.04s、最大间隙 9.3s——但 PRD 总时长 >90s，原「总时长 90s」一刀切误杀健康流）：complete 非流式 = 总时长 90s；stream 流式 = 空闲超时 45s（无新 chunk 即判死，阈值须大于实测最大间隙）+ 总时长上限 300s。均 env 可调（`LLM_TIMEOUT_MS` / `LLM_STREAM_IDLE_TIMEOUT_MS` / `LLM_STREAM_TOTAL_TIMEOUT_MS`）；超时/中止的调用也须落 llm_calls 计量（completion 按已收部分估算并标 estimated）。

### 4.7 项目间上下文隔离（四层）
数据层（全表 project_id + 仓库层强制过滤）／Agent 上下文（组装只取当前项目）／工具层（路径校验，闭包绑定 project_id）／运行层（每项目独立运行队列）。

## 5. 关键设计决策与取舍

**① 模型提供商切换（agent 粒度 + 探测/fallback，2026-09-06 增强）**：设置页管理 Provider（预设豆包/ARK、DeepSeek、GLM、Kimi、OpenAI + 自定义）+ 模型列表（含 `price_input/price_output` 单价字段，默认 0）+ 全局默认；绑定=agent 级（`agent_model_bindings`）。不做 leader 动态选模型；静态绑定为 Race Mode 预留。**增强（参考 hify-provider 设计）**：`probeProvider` 探测 base_url 下可用模型（OpenAI 兼容 `/models`）+ 响应速度（墙钟），设置页「测试连接/导入模型」直接消费；`resolveRoleModel` 三级路由（DB 绑定 → `LLM_MODEL_<ROLE>` → `LLM_MODEL`）；`withFallback` 显式降级链（类型化错误分类：aborted 永不降级、auth 同 provider 不重试但换 provider 正当、timeout/rate_limited/network/bad_response 可降级；内存健康度 fail≥3 排后——单实例内存态，多实例外置为 §12 演进位）。默认无 fallback（链为空=现行为），显式 opt-in。

**② 并发控制**：V1 纯串行执行（无并发写）；文件写锁保留为防御层（per-path mutex，防未来引入并行）；files 乐观锁 version。多实例/并行演进路径写入 README。

**③ Token 用量与计费**：每次调用落 `llm_calls`；**usage 获取降级链**：流式响应 usage 字段 → `stream_options:{include_usage}` 重试 → 字符公式估算（§4.4）并标记 `estimated=1`；cost=usage×单价表。项目页按 agent/模型分组用量卡片。套餐扩展只留接口（Quota 中间件 + Plan/Ledger ER 设计，不实现 UI）。

**④ 模块复用**：通用内核 `AgentRunner.run({role, systemPrompt, tools, context, model, callbacks})`；角色=内核+工具集+prompt+模型绑定四要素；新增专家 agent 零代码。AgentAdapter 接口留作接入已有 agent 实现。

**⑤ 生成质量工程**（红队新增，与编排同优先级）：工程师 system prompt 内置**应用模板骨架库**（精致布局/配色/交互模式，2-3 套：仪表盘、列表 CRUD、落地页）+ 风格指南（现代 UI 基线：暗色/亮色、间距、圆角、微交互）；架构师 prompt 要求 UI 规格具体到组件级。**下限保证：最差输出也是一套完整像样的应用**。黄金样例进 `src/lib/agents/roles/samples/` 供 prompt few-shot 与 seed。

**⑤′ 生成物校验与安全层**（语言特性=可嵌入库，不依赖外部 coding agent）：

*静态校验*：file_end 落库前——JS 用 acorn 解析、HTML 用 parse5、JSON 用 JSON.parse（纯 JS 库，服务端）；语法错 → 三段式自动重试一次 → 仍错标 ⚠ 落库（拦截"半截代码"）。代码查找=JS 正则扫 files 表（tree-sitter 语义搜索列为演进）。

*安全检测（纵深 5 道）*：① iframe sandbox 能力隔离（已设计，威胁模型天然小）② preview 响应 CSP：`connect-src 'none'`/白名单 + `script-src` 白名单 CDN（堵数据外传）③ **危险 API AST 扫描**（acorn 遍历，~100 行自写规则）：硬违规拒绝落库+带错重试——eval/new Function/字符串 setTimeout（注入）、postMessage to parent（逃逸）、非白名单 script src；软警告标 ⚠——无限 while(true) 无 break、非白名单外部 fetch ④ LLM 安全审查：复用写后自审调用，清单含 innerHTML 拼接用户输入（XSS）、敏感信息硬编码 ⑤ 人工兜底（编辑开关+回滚）。

*不做*：eslint 全规则/semgrep/CodeQL（超时间盒）；**依赖漏洞扫描不需要——生成物零依赖=无供应链风险**（无框架生成的隐藏收益）；运行时 RASP。威胁模型：生成代码只跑在用户浏览器沙箱 iframe，无服务端执行无跨租户暴露；真实风险是质量差与 LLM 无意危险模式（eval/死循环），非蓄意攻击——安全层价值=工程完整度+拦截无意危险。

*LLM 自审*=工程师写完文件后一次廉价 review 调用（质量+安全清单），可覆写修复（agent 版 lint）。不做：完整 eslint 规则集、AST 级重构、跨文件类型推断。

**⑥ mock provider 行为规格**（P1 交付物）：按角色返回固定优质样例（PM→样例 PRD；架构师→样例设计+图+file_tree；工程师→按模板骨架逐文件吐码），流式 chunk 吐出、延迟 env 可配（`LLM_MOCK_DELAY_MS`，默认 5ms/chunk；原定 30ms，随实现按 plan 裁决收敛为 5ms——测试/离线可置 0）；`LLM_PROVIDER=mock` 启用。真实模型冒烟：本机 `DASHSCOPE_API_KEY`（OpenAI 兼容）dev 冒烟，密钥不进 git。

## 6. 技术栈

| 层 | 选型 |
|---|---|
| 前端 | Next.js 15 App Router + TS(strict) + Tailwind + shadcn/ui |
| 流式 | SSE（Route Handler + ReadableStream，自写事件协议） |
| Agent 层 | 自写编排器 + 每角色独立 system prompt（不上 agent 框架） |
| 文件渲染 | react-markdown + Shiki + mermaid（渲染失败降级显示源码） |
| 数据库 | **StorageProvider 抽象**（§12）——当前实现：SQLite + Drizzle + better-sqlite3（WAL，`data/app.db`）；可扩展 Postgres |
| LLM | OpenAI 兼容 API（env 晚绑定）+ mock provider |
| 用户体系 | 无登录，匿名 session cookie（SameSite=Lax） |

DB 决策：本机无 Postgres/docker；编排器单写者，SQLite 够用零配置；部署侧持久卷挂 `data/`。升级路径：换 pg dialect + DATABASE_URL，仓库层接口不变。**SQLite 方言注意：jsonb→TEXT 存 JSON**。

## 7. 数据模型与 API

**表**（SQLite 方言，JSON 一律 TEXT）：
- `projects(id, session_id, title, requirement, mode[fast|full], status[draft|running|paused|done|failed], created_at, updated_at)`
- `messages(id, project_id, role[user|assistant|intervention|system], content, delivered_at?, created_at)`（干预队列：role=intervention 且 delivered_at IS NULL）
- `agent_runs(id, project_id, task_key, agent, task, status[pending|running|done|failed|stopped], summary?, started_at, ended_at, error?)`
- `files(id, project_id, path UNIQUE(project_id,path), content, produced_by, last_editor[agent角色名|human], editing_by?, version, created_at, updated_at)`；`file_versions(id, file_id, version, content, editor, created_at)`——**file_end/人工保存覆盖写时旧版本入 file_versions（真实 diff/回滚）**；人工软锁 `editing_by` 带过期时间
- `llm_providers(id, name, base_url, api_key, enabled)`、`llm_models(id, provider_id, model_id, display_name, price_input, price_output, enabled)`
- `agent_model_bindings(role UNIQUE, provider_id, model_id)`
- `llm_calls(id, project_id, agent_role, model, prompt_tokens, completion_tokens, estimated, cost, latency_ms, created_at)`
- `preferences(id, scope[session|user], target_id, data TEXT<json>)`
- `checkpoints(id, project_id, label, agent_run_id?, created_at)`、`checkpoint_files(checkpoint_id, path, content)`——任务前自动快照，事务回滚（§3.10）
- （计费预留仅 ER：plans / quotas / ledger）

**API**：
- `POST /api/projects`（建项目+需求+模式，首页 hero 提交入口）、`GET /api/projects`（列表，含最近会话摘要/统计）、`PATCH /api/projects/[id]`（重命名）、`DELETE /api/projects/[id]`（删除，二次确认，级联 messages/agent_runs/files/file_versions/checkpoints）
- `GET /api/projects/[id]`（快照+现场恢复）、`GET /api/projects/[id]/stream`（SSE，支持 Last-Event-ID）
- `POST /api/projects/[id]/stop`、`POST /api/projects/[id]/messages`（干预入队）
- `POST /api/projects/[id]/files/[fileId]/regenerate`（单文件重试=重跑该单文件任务）、`PATCH /api/projects/[id]/files/[fileId]`（人工编辑保存，CAS 带 base_version，409=冲突）
- `GET /api/projects/[id]/preview`（全栈预览装配 HTML）、`GET /api/projects/[id]/export`（zip）
- `POST /api/projects/[id]/checkpoints/[cpId]/restore`（项目级回滚，§3.10）
- `GET/POST/PATCH/DELETE /api/settings/providers|models|bindings`（模型管理 CRUD）
- `GET /p/[slug]`（E4 分享，可选）

## 8. 任务拆解（WBS，总计 17-19h）

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | 脚手架 + 三区布局骨架 + CLAUDE.md 命令落地 | 0.5h |
| P1 ★ | 数据层；AgentRunner 内核 + mock 规格；领导路由（工具协议+zod+回退）；串行编排器 + SSE(seq/恢复/干预/停止)；PM/架构师/工程师（混合模式）+ 专家角色；**生成质量工程（模板骨架+风格指南+黄金样例）**；**校验与安全层（语法+危险 API AST 扫描+CSP）**；全栈预览契约（backend handler 约束+垫片注入） | 6.5h |
| P2 ★ | IDE 前端（文件树/打字机三态/时间线/聊天/模式开关/停止/@成员浮层与chip） | 3.3h |
| P2.5 | 人机共编：编辑态 + CAS 保存 + 冲突对话框 + 简易并排 diff + 软锁（DESIGN §3.9） | 1h |
| P3 ✅ | 应用骨架：侧栏（导航+最近会话+设置入口）、**首页 hero**（头像排/大输入框/示例 chips/公告条）、**我的项目 tab**（卡片墙+删除/重命名+会话摘要）、现场恢复、zip 导出、**seed 预置项目**、**检查点/回滚（自动快照+时间线回滚入口+失败建议）** | 3h |
| P3.5 | Provider 设置页 + agent 绑定 + 用量卡片 | 1h |
| P4 ✅ | E1 全栈预览 tab、E2 附加专家（领导动态分派） | 1.5h |
| P5 | 单文件重试、README（架构图+取舍+演示脚本）、Dockerfile/compose、部署验证 | 1h |

降级阶梯（若时间不足按序砍）：① provider 页→env+全局默认 ② 用量只落库 ③ 打字机降纯高亮 ④ 记忆只做 MEMORY 注入 ⑤ zip/Publish 延后 ⑥ 个人级偏好延后——核心闭环（路由分派+流水线+打字机+持久化+全栈预览+快速模式）任何组合下保留。

## 9. 部署与交付

**首选：Zeabur 常驻容器 + 持久卷（挂 `data/`）**
- 理由：全流程 5-15 分钟串行 LLM 调用，serverless 60s 上限不可行；常驻容器无限制；国内访问稳
- **部署验证清单（P5 必做）**：① Zeabur 免费档是否有持久卷、重新部署是否保留 ② better-sqlite3 原生模块构建（node:22 镜像需 python3/make/g++，Zeabur Nixpacks 默认具备，验证之）③ SSE 过网关不被缓冲 ④ 内存事件缓冲单实例约束（重启丢直播缓冲，快照仍可恢复——标注为已知限制）

**备选链**：② 腾讯云 CloudBase 云托管（国内容器）③ 自有 VPS docker-compose ④ 本机 + Cloudflare Tunnel（应急演示兜底）。环境变量：`LLM_BASE_URL/LLM_API_KEY/LLM_MODEL`（+角色覆盖）。

**交付物**：①线上可测链接 ②GitHub 仓库（README：架构图、30 秒启动、设计取舍、演示脚本）③3 分钟演示脚本：快速模式输入需求→1-2 分钟看打字机出活→预览交互（CRUD）→切完整模式展示 PRD/架构图/ER 图→刷新恢复现场→（追问）模型管理/用量/干预。

## 10. 风险

- **生成质量（最高优先）**：模板骨架+风格指南+few-shot 黄金样例保下限；工程师单文件粒度+重试
- **演示翻车**：快速模式 1-2 分钟出活 + seed 预置项目保底 + 全链路 mock 可离线演示
- 长流水线中断：幂等落库+断点续跑（含 null summary 降级）
- token 成本：架构师输出上限；seed 项目预跑
- mermaid 语法错误：渲染失败降级显示源码（客户端 try/catch）
- 48h 时间盒：WBS 14-16h，降级阶梯兜底

## 11. 验证方式

1. `npm run build` 通过
2. mock 全链路：建项目→SSE 直播→文件树长文件→全栈预览 CRUD 交互→刷新恢复→干预指令注入→停止/续跑→单文件重试
3. 真实模型冒烟（DASHSCOPE）：快速模式出一套完整应用，人工验收 UI 质量
4. 异常路径：LLM 超时/坏输出→三段式回退；mermaid 坏语法→源码降级；断线重连→Last-Event-ID 重放
5. 部署后线上重跑同链路

## 12. 扩展性架构（Provider + Registry 模式）

**原则**：所有可替换能力 = 接口（Provider）+ 注册表（Registry）。新增实现=新增文件+注册，不改调用方。风格对齐 Vercel AI SDK 的 provider 模型。

| 扩展点 | 接口 | 当前实现 | 未来实现 |
|---|---|---|---|
| 存储 | `StorageProvider`（projects/messages/agent_runs/files/… 仓库方法全集） | `SqliteStorage`（drizzle sqlite + better-sqlite3，WAL） | `PostgresStorage`（drizzle pg，`DB_DRIVER=postgres` 工厂切换；Neon/Zeabur） |
| LLM | `LlmProvider.complete/stream` | `OpenAICompatProvider` + `MockProvider` | Anthropic 原生、多模态、Race 双通道 |
| Agent 内核 | `AgentRunner.run()` / `AgentAdapter` | 自写工具循环 | 接入现成 coding agent（pi/Claude Agent SDK）作为引擎 |
| 角色注册表 | `RoleRegistry`（role→{prompt, tools, model 绑定} 配置） | 领导/PM/架构师/工程师/3 专家 | 用户自定义角色（UI 配置 prompt+工具集） |
| 工具注册表 | `ToolRegistry`（schema+impl+policy 三件套） | write/read/list/grep | 外部检索、图片生成、代码执行（沙箱成熟后） |
| 检索 | `RetrievalProvider.search()`（RankedHit[]，bm25 可选） | GrepRetriever（RegExp 扫 files，默认）+ FtsRetriever（trigram/bm25，`RETRIEVAL_PROVIDER=fts5`，T28 已落地） | Postgres 全文检索（pg_trgm/tsvector）复用同一接口 |
| 查看器渲染 | `RendererRegistry`（按文件类型/扩展名） | markdown/代码(Shiki)/mermaid | plantuml、CSV 表格、图片 |
| 传输层 | `TransportAdapter`（事件发布） | SSE（EventSource） | WebSocket 双向、Webhook 外发 |
| 调度策略 | `Scheduler`（拓扑序执行策略对象） | 串行 | 并行（写集检测启用）、优先级/抢占 |
| 校验规则 | `ValidationRuleEngine`（规则注册：severity+check） | 语法校验+危险 API AST 扫描 | eslint 子集、semgrep 规则包 |
| 认证 | `AuthProvider` | 匿名 session cookie | 用户账户（user 级偏好/配额随之启用） |
| 导出/发布 | `ExportProvider` | zip 下载 | GitHub 推送、一键部署（Zeabur/Vercel API） |
| 计量 | `MeteringSink`（usage 事件） | llm_calls 表 | 计费 hooks（Quota/Ledger 启用） |
| 预览沙箱 | `PreviewSandboxProvider` | iframe srcDoc + fetch 拦截 | WebContainer（浏览器跑 Node）、服务端容器沙箱 |

**StorageProvider 落地形态**（P1 实现，其余接口按 YAGNI 在用到时抽取，避免过度设计——只预留命名与目录）：
```
src/lib/db/
  provider/types.ts     // StorageProvider 接口（领域仓库方法契约，类型即文档）
  provider/sqlite/      // drizzle(sqlite dialect) 实现（schema+PRAGMA+事务）
  provider/postgres/    // 未来：drizzle(pg)，同接口
  index.ts              // createStorage(process.env)：DB_DRIVER 工厂
```
业务代码（编排器/角色/API）只依赖 `StorageProvider` 接口与领域类型，不 import 具体 dialect schema——切换存储=改一个环境变量。

### 12.1 多用户支持取舍（预留口子，V1 不实现）

**决策（D5）**：V1 无登录（匿名 session cookie）；多用户定位为「架构友好、功能不做」——将来接账户体系是增量改动，不是重构。

**已预留的口子**

| 口子 | V1 现状 | 多用户演进 |
|---|---|---|
| 认证 | 匿名 session cookie；AuthProvider 只留接口位（上表「认证」行，按 YAGNI 未建文件） | 抽取 AuthProvider：注册/登录/OAuth |
| 归属校验 | 全表 project_id + 仓库层强制过滤（§4.7 四层隔离），归属键=session_id | 仓库层把归属键换成 user_id——单一改动点，不用扫全码 |
| 偏好 | preferences.scope 枚举已含 `user`（§7），表结构免迁移 | scope=user 启用用户级偏好 |
| 计量 | llm_calls 每调用落库；plans/quotas/ledger 仅 ER 预留 | Quota 中间件 + Ledger 启用（按用户配额/计费） |
| 存储 | StorageProvider 工厂（DB_DRIVER=sqlite）；SQLite 单写者 | DB_DRIVER=postgres（Neon/Zeabur），仓库层接口不变 |

**未预留、届时需补**
- `projects` 表加 `user_id` 列 + 匿名历史数据归属绑定策略（session→user）
- 事件总线为单实例内存环形缓冲（§9 已知限制）——多实例需外置（Redis pub/sub，或走 §12 传输层 WebSocket 演进位）
- 账户体系配套安全面（CSRF/频控/审计）从零建

**不做的理由**：单人笔试 demo，账户体系（注册/登录/找回/合规）远超 48h 时间盒且与评分点无关；预留口子已把升级成本压到「加列 + 换归属键 + 抽 AuthProvider」三步。
