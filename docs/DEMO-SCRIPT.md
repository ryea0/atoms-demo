# 演示脚本（3 分钟）与验收清单

> 配套文档：[`README.md`](../README.md)（架构与设计取舍）、[`docs/DESIGN.md`](./DESIGN.md)（单一事实来源）。
> 三个版本：**A 真实模型版**（主打）、**B mock 离线版**（无密钥/无网兜底）、**C Docker 版**（部署验收）。

---

## A. 3 分钟演示脚本（真实模型，快速模式主线 + 完整模式深度）

**开场一句话**：用户给一句话需求，多智能体团队接力产出 PRD、架构图与全栈代码，IDE 界面实时可视化，并一键预览可交互的全栈应用；LLM 只做决策，调度、流式、落库全部是确定性代码。

### A1 (0:00–0:40) 需求 → 团队接力

- **操作**：首页卡片墙输入「一个团队待办事项管理应用，支持增删改查与完成标记」→ 模式选**快速** → 发送。
- **看什么**：进入工作台，聊天区出现领导消息，时间线出现「⭐ 用户指定 / 任务节点」，左侧文件树逐个长出文件，选中文件看打字机流式。
- **预期**：1-2 分钟内出完整应用；SSE 实时推进、无卡顿；`PROGRESS.md` 随任务推进追加。
- **不合格信号**：长时间无 delta、文件树不长文件、出现 error 事件未提示。

### A2 (0:40–1:10) 预览真实可交互

- **操作**：点顶栏「预览」→ iframe 内新增一条待办 → 勾选完成 → 删除。
- **预期**：CRUD 全流程真实生效（浏览器内内存后端 + fetch 拦截垫片）；**如实说明**：刷新预览即重置（内存态），`app/backend/api.js` 是同构模块、未来可直接挂 Node 服务。

### A3 (1:10–1:50) 完整模式深度（评委追问弹药）

- **操作**：另建一个项目，模式选**完整**（可 @架构师 指定成员）。
- **预期**：产出精简 PRD → 架构设计（**mermaid 架构图 + ER 图**，渲染失败自动降级显示源码）→ `file_tree.json` → 逐文件代码；右侧时间线按 agent_runs 展示每步状态与摘要；用量卡片展示 token/费用（含 `estimated` 标记的估算调用）。

### A4 (1:50–2:10) 刷新恢复现场

- **操作**：在生成中途按 F5。
- **预期**：快照对齐 + SSE `Last-Event-ID` 重放，文件树/聊天/时间线完整恢复；正在生成的文件**续读**（内存缓冲全文回放，不从头重生成）。

### A5 (2:10–2:30) 人机共编与冲突

- **操作**：打开一个生成文件 → 右上「编辑」→ 改一行保存；再故意用旧版本号触发冲突（另一处改动后保存）。
- **预期**：第一次保存成功，M 角标由蓝（agent）变绿（human）；第二次返回 **409** → 冲突对话框三选一（用我的版本 / 用 agent 版本 / 并排 diff）。顶栏编辑开关关闭则整体只读（演示纯 agent 流程用）。

### A6 (2:30–2:45) 干预与停止

- **操作**：生成运行中在聊天区追加指令（如「优先移动端适配」）→ 再点停止。
- **预期**：指令入队并以「队列卡片：将在下一边界注入」展示 → 时间线出现「已注入下一步骤」；点停止 → 状态 `paused`、已生成文件保留、`agent_runs` 标 `stopped`；再发消息可从断点续跑（无摘要的 run 用已产文件清单拼降级交接摘要）。

### A7 (2:45–3:00) 回滚兜底 + 平台能力

- **操作**：时间线某任务节点点「回到此任务前」；随后切到设置页。
- **预期**：回滚后文件恢复到检查点（当前内容先入 `file_versions`，回滚可撤销）、相关 run 标 `rolled_back`；设置页可看 Provider 预设/「测试连接」探测、模型单价、agent 级模型绑定。
- **收尾话术**：生成物跑在 `sandbox="allow-scripts"` iframe + CSP，服务端零代码执行；危险 API AST 扫描 + 写后自审 + 回滚兜底。

### 异常兜底（演示翻车预案）

| 状况 | 处理 |
|---|---|
| 真实模型慢/超时 | 切 mock 版（见 B）；或设置页换 Provider/模型后重试 |
| 生成质量差 | 打开 seed 模板项目（首页带「示例」角标）展示保底产出 |
| mermaid 语法错 | 已降级显示源码，顺势讲降级策略 |
| 断网 | mock 全链路可完整演示 |

---

## B. mock 离线版（无密钥，几十秒跑完一轮）

```bash
npm install && npm run db:push && npm run dev     # 默认 LLM_PROVIDER=mock
# 可选提速：.env.local 里 LLM_MOCK_DELAY_MS=0
npm run seed                                      # 预置演示项目（幂等）
```

脚本同 A，差异：每步几乎瞬时完成、产出为黄金样例（PM→样例 PRD、架构师→样例设计+图+file_tree、工程师→按模板骨架逐文件吐码，含写后自审覆写 v2）。适合：环境无密钥、录屏备份、评审现场网络不稳。

**已验证的 mock 全链路 HTTP 轨迹**（交付时实测，dev server PORT=3300）：

| 步骤 | 请求 | 结果 |
|---|---|---|
| 建项目（fast + @engineer） | `POST /api/projects` | `201 {project}`，后台起跑 |
| SSE 直播 | `GET /api/projects/1/stream?lastEventId=0` | `200 text/event-stream`（`no-cache,no-transform`/`keep-alive`/`X-Accel-Buffering: no`），帧 `agent_start/delta/file_start/file_end/agent_end/message/done`，seq 连续自增 |
| 快照 | `GET /api/projects/1` | `200`：6 文件 / 9 agent_runs / 2 检查点 / usage / lastSeq=1804，状态 `done` |
| 预览 | `GET /api/projects/1/preview` | `200` HTML + `CSP: connect-src 'none'` + `__ATOMS_BACKEND__` fetch 拦截垫片 |
| 干预（运行中） | `POST /api/projects/2/messages` | `200 {delivered:"intervention", messageId}`；SSE 出 `intervention_injected`，`delivered_at` 落戳 |
| 停止 | `POST /api/projects/2/stop` | `200 {ok:true}` → 状态 `paused`、SSE `stopped`、run 标 `stopped` |
| 刷新恢复 | 重取快照 + `Last-Event-ID: 2050` | 快照 `200`；重放 2051-2055 共 5 条（重放窗口受环形缓冲上限约束，超出靠快照补齐） |
| 回滚 | `POST /api/projects/1/checkpoints/2/restore` | `200 {ok:true, restoredFiles:5}`；文件版本 +1、`last_editor=human`、runs 标 `rolled_back`、聊天区追加回滚通知 |
| 编辑冲突 | `PATCH /api/projects/1/files/2`（旧 `baseVersion`） | `409 {conflict:true, current, version}`；用当前版本重发 → `200 {version:4}` |
| @指定 | 建项目带 `mentions:["engineer"]` | 绕过领导路由直接派工程师，run 全为 engineer + 领导收尾 |
| 删除项目 | `DELETE /api/projects/2` | `200 {ok:true}` → 复查 `404`；跨会话访问他人项目 `404` |

---

## C. Docker 部署验收清单

> 交付说明：开发机 Docker daemon 不可用，以下为**交付物级验证**——Dockerfile/compose 已按规范编写并做语法自查（`docker compose config` 语义对照人工核对），容器冒烟留待有 daemon 的环境执行。若 musl 下 better-sqlite3 无预编译产物，把 base 换 `node:22-bookworm-slim`。

**首跑前（宿主，必做）**：`mkdir -p ./data && chown 1001:1001 ./data`。干净 clone 上 `./data` 不存在时，Docker 以 root:root 创建 bind mount，容器内非 root 用户 `nextjs(1001)` 无权写 `app.db`/`-wal` → better-sqlite3 直接失败（症状：容器 crash loop，日志 `SQLITE_CANTOPEN`/`EACCES`）；镜像内 `mkdir + chown` 会被 bind mount 覆盖，救不了这条路径。

```bash
mkdir -p ./data && chown 1001:1001 ./data
docker compose up --build
```

1. **启动**：容器 `Up (healthy)`（HEALTHCHECK 打 `http://127.0.0.1:3000/`），日志无 `Cannot find module` / better-sqlite3 加载错误。
2. **打开** http://localhost:3000 → 卡片墙正常。预置演示项目如需：容器启动前在宿主对同一数据目录执行 `npm run seed`（写入 `./data/app.db`，卷内共享；runner 镜像为生产依赖、不含 tsx，故不在容器内跑 seed）。
3. **mock 一轮**：建项目（快速模式）→ 文件树长文件 → 预览可交互。
4. **持久化**：`docker compose down && docker compose up`（不删 `./data`）→ 项目仍在、文件内容不变（卷挂载生效）。
5. **SSE 不过网关缓冲**：`curl -N http://localhost:3000/api/projects/<id>/stream` 能看到逐帧输出（`X-Accel-Buffering: no` 生效；若前面有 nginx 需 `proxy_buffering off`）。
6. **非 root**：`docker compose exec app id` → `nextjs(1001)`；`ls -l /app/data` 属主可写。

---

## 真实模型人工验收清单（UI 逐项）

> 用途：接真实模型后按此单打勾。每项给「操作 → 预期 → 不合格信号」。

**0. 配置**

- `.env.local`：`LLM_PROVIDER=openai`、`LLM_BASE_URL`（OpenAI 兼容地址）、`LLM_API_KEY`、`LLM_MODEL`（可选 `LLM_MODEL_LEADER/PM/ARCHITECT/ENGINEER` 角色级覆盖）。
- `npm run dev` → 首页无报错；设置页该 Provider「测试连接」通过、模型列表可导入。
- 不合格信号：密钥出现在浏览器请求/日志/`llm_calls` 记录中（必须只存服务端 env）。

**1. 快速模式端到端（必过）**

- 操作：建项目（快速模式，一句话待办/书签类需求）。
- 预期：1-2 分钟 `done`；产出 ≥ 3 个文件且含 `app/frontend/index.html`（+ `app/backend/api.js`）。
- 不合格信号：状态 `failed`、出现 ⚠ 语法警告文件、预览白屏。

**2. 生成 UI 质量（人工验收）**

- 打开预览逐项看：布局是否对齐、间距/圆角/配色是否现代、交互（按钮/输入/列表）是否可用、有无 console 报错（浏览器 DevTools）、移动端宽度不塌版。
- 不合格信号：裸 HTML 无样式、Tailwind CDN 未生效、生成应用调用 localStorage（iframe 无 same-origin，必失败）。

**3. 文档链（完整模式）**

- 预期：PRD 结构完整（用户故事/验收标准）、mermaid 架构图与 ER 图渲染成功、file_tree 与实际文件一致。
- 不合格信号：mermaid 长期转圈（应降级显示源码）、file_tree 与文件树对不上。

**4. 流式与恢复**

- 预期：打字机流畅、切文件不打断其他文件生成；刷新后现场完整恢复、在流文件续读。
- 不合格信号：刷新后文件丢失、SSE 重连后时间线重复。

**5. 可靠性**

- 操作：故意填错 `LLM_API_KEY` 建项目。
- 预期：三段式回退/降级后仍能收敛（或明确 `error` 事件 + 项目 `failed` 落库），`llm_calls` 有记录且 `estimated` 标记正确；错误信息不含 Authorization 头。
- 不合格信号：静默吞错、页面无反馈、`llm_calls` 缺失。

**6. 人机共编 / 干预 / 停止 / 回滚**

- 同 A5/A6/A7 三项逐条打勾（编辑开关、409 冲突对话框、干预注入、停止续跑、检查点回滚）。

**7. 用量与成本**

- 预期：项目页按 agent/模型分组的用量卡片数值合理；模型单价可在设置页维护；缺 usage 的调用被标 `estimated` 并按中文校准公式估算。
