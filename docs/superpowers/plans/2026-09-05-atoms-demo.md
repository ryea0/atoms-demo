# Atoms-Demo 多智能体应用生成平台 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建网页版 mini-Atoms：用户一句话需求 → 多智能体团队（领导/PM/架构师/工程师/专家）流式生成 PRD、架构图、全栈代码 → IDE 三区实时可视化（文件树生长/打字机/图表渲染）→ 一键全栈预览。

**Architecture:** 双层编排（LLM 决策 + 确定性串行 DAG 编排器）；AgentRunner 工具循环内核（write_file 等工具操作 SQLite 虚拟文件系统，路径沙箱）；SSE 事件流（seq/Last-Event-ID 重放）；生成物为单文件 HTML + 同构 api.js handler，预览经服务端注入 fetch 拦截垫片跑在 sandbox iframe。

**Tech Stack:** Next.js 15 App Router + TypeScript strict + Tailwind + shadcn/ui；Drizzle + better-sqlite3（WAL，StorageProvider 抽象）；zod；Shiki/mermaid/react-markdown；vitest + @testing-library/react；jszip。

**Spec:** `/home/ryea0/Project/Atom/docs/DESIGN.md`（v2，含全部拍板决策 D1-D4 与 §12 扩展点）。执行者必读 DESIGN 对应章节 + `.claude/rules/01-07`。

## Global Constraints

- TypeScript `strict`；禁 `any`/`@ts-ignore`（规则 01）
- 注释与用户可见文案中文；标识符/commit message 英文
- 所有表带 `project_id`；一切查询经仓库层强制过滤（规则 05）
- SQLite 方言：JSON 用 `text({mode:'json'})`；无 jsonb（规则 05）
- 事务短小：事务内不做 LLM 调用/IO（规则 05）
- SSE 路由 `force-dynamic`；头：`text/event-stream`、`no-cache, no-transform`、`X-Accel-Buffering: no`；事件带 `id:`（规则 06）
- 路径沙箱：拒绝对对路径/`..`/`\0`/反斜杠；字符白名单 `[a-zA-Z0-9._/-]`（规则 07）
- 不做 bash 工具、不做服务端代码执行、不做 RAG
- V1 编排纯串行（拓扑序）
- 生成物契约：`app/frontend/index.html`（Tailwind CDN + vanilla JS，禁 localStorage）+ `app/backend/api.js`（`handle(method,path,body)` 内存态）
- LLM 调用一律经 `src/lib/llm/`（计量落库）
- 每个 Task 结束：`npx vitest run`（相关文件）通过 + `npm run build` 通过 + commit

---

### Task 1: 脚手架与工程基础

**Files:**
- Create: `package.json`（create-next-app 生成 + 依赖追加）、`vitest.config.ts`、`tests/setup.ts`、`.env.example`
- Modify: `.gitignore`（追加 `data/`、`.env*`）

**Interfaces:**
- Produces: vitest 可跑（`npx vitest run`）；目录 `src/{app,components,lib}`；shadcn 组件可用；命令 `dev/build/lint/db:push/seed/test`

- [ ] **Step 1: 脚手架**（项目根已有 CLAUDE.md/docs/.claude，先在临时目录生成再合并）

```bash
cd $CLAUDE_JOB_DIR/tmp && rm -rf scaffold && mkdir scaffold && cd scaffold
CI=true npx --yes create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --turbopack --import-alias "@/*" --use-npm --yes </dev/null
# 合并进项目（不覆盖已有文件）
cp -rn . /home/ryea0/Project/Atom/ 2>/dev/null; cd /home/ryea0/Project/Atom && npm install
```

- [ ] **Step 2: 依赖**

```bash
npm i drizzle-orm better-sqlite3 zod react-markdown shiki mermaid jszip clsx tailwind-merge lucide-react
npm i -D drizzle-kit @types/better-sqlite3 vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom @testing-library/user-event jsdom
npx shadcn@latest init -y -b neutral 2>/dev/null || echo "shadcn init 失败则手写最小组件（见 Task 17 备注）"
npx shadcn@latest add -y button input tabs badge dialog dropdown-menu tooltip switch avatar popover card scroll-area separator sonner 2>/dev/null || true
```

- [ ] **Step 3: vitest 配置** `vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins: [react()],
  test: { environment: 'jsdom', setupFiles: ['./tests/setup.ts'], globals: true },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
```

`tests/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
```

`package.json` scripts 追加：`"test": "vitest run"`、`"db:push": "drizzle-kit push"`、`"seed": "tsx scripts/seed.ts"`（`npm i -D tsx`）。

`drizzle.config.ts`:

```ts
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite', schema: './src/lib/db/provider/sqlite/schema.ts',
  out: './drizzle', dbCredentials: { url: process.env.DB_FILE ?? 'data/app.db' },
});
```

- [ ] **Step 4: 环境样例** `.env.example`

```bash
LLM_PROVIDER=mock            # mock | openai
LLM_BASE_URL=                # OpenAI 兼容地址
LLM_API_KEY=
LLM_MODEL=                   # 默认模型
LLM_MODEL_LEADER=            # 可选角色覆盖
LLM_MODEL_ENGINEER=
DB_DRIVER=sqlite
DB_FILE=data/app.db
```

`.gitignore` 追加：`data/`、`.env*`、`*.db`。

- [ ] **Step 5: 验证 + commit**

```bash
npx vitest run --passWithNoTests && npm run build
git add -A && git commit -m "chore: scaffold Next.js 15 + vitest + deps"
```

---

### Task 2: SQLite Schema 与 StorageProvider 工厂

**Files:**
- Create: `src/lib/db/provider/sqlite/schema.ts`、`src/lib/db/provider/types.ts`、`src/lib/db/index.ts`、`src/lib/db/test-util.ts`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Produces: `createStorage(env?): StorageProvider`（工厂，`DB_DRIVER` 选择，默认 sqlite）；`newTestStorage(): StorageProvider`（`:memory:` 库，跑 PRAGMA）；全部领域类型（见下）

领域类型（`provider/types.ts` 核心，后续所有 Task 依赖）：

```ts
export type AgentRole = 'leader'|'pm'|'architect'|'engineer'|'analyst'|'seo'|'ads';
export type ProjectStatus = 'draft'|'running'|'paused'|'done'|'failed';
export type RunStatus = 'pending'|'running'|'done'|'failed'|'stopped'|'rolled_back';
export interface Project { id:number; sessionId:string; title:string; requirement:string;
  mode:'fast'|'full'; status:ProjectStatus; createdAt:number; updatedAt:number; }
export interface Message { id:number; projectId:number; role:'user'|'assistant'|'intervention'|'system';
  content:string; meta?:{mentions?:AgentRole[]}|null; deliveredAt:number|null; createdAt:number; }
export interface AgentRun { id:number; projectId:number; taskKey:string; agent:AgentRole; task:string;
  status:RunStatus; summary:string|null; startedAt:number|null; endedAt:number|null; error:string|null; }
export interface FileRow { id:number; projectId:number; path:string; content:string;
  producedBy:AgentRole|'seed'; lastEditor:AgentRole|'human'|'seed'; editingBy:string|null; editingExpiresAt:number|null;
  version:number; createdAt:number; updatedAt:number; }
export interface FileVersion { id:number; fileId:number; version:number; content:string; editor:string; createdAt:number; }
export interface Checkpoint { id:number; projectId:number; label:string; agentRunId:number|null; createdAt:number; }
export interface CheckpointFile { checkpointId:number; path:string; content:string; }
export interface LlmCall { id:number; projectId:number; agentRole:AgentRole; model:string;
  promptTokens:number; completionTokens:number; estimated:number; cost:number; latencyMs:number; createdAt:number; }
export interface StorageProvider { /* Task 3-5 分组填充全部方法 */ }
```

- [ ] **Step 1: 失败测试** `tests/db/schema.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { newTestStorage } from '@/lib/db/test-util';
describe('schema', () => {
  it('建表并可插入项目', async () => {
    const s = newTestStorage();
    const p = await s.createProject({ sessionId:'sx', title:'t', requirement:'r', mode:'fast' });
    expect(p.id).toBeGreaterThan(0);
    expect((await s.listProjects('sx')).length).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**：`npx vitest run tests/db/schema.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现** `schema.ts`（drizzle sqlite-core；所有表含 `createdAt integer`；`files` 上 `unique('files_project_path').on(projectId,path)`；外键 `onDelete:'cascade'`；`preferences(id, scope, targetId, data text json, unique(scope,targetId))`；`llmProviders/llmModels/agentModelBindings` 同 DESIGN §7）。`db/index.ts`：

```ts
import { createSqliteStorage } from './provider/sqlite/storage';
export function createStorage(env = process.env) {
  if ((env.DB_DRIVER ?? 'sqlite') !== 'sqlite') throw new Error('postgres provider 未实现（DESIGN §12 预留）');
  return createSqliteStorage(env.DB_FILE ?? 'data/app.db');
}
```

`test-util.ts`：`newTestStorage()` = `createSqliteStorage(':memory:')`（含 WAL/foreign_keys PRAGMA，`data/` 目录自动创建）。

- [ ] **Step 4: 跑测试通过** → `npx vitest run tests/db/schema.test.ts`
- [ ] **Step 5: Commit** `git add -A && git commit -m "feat(db): sqlite schema + storage provider factory"`

---

### Task 3: 仓库层 — 项目/消息/干预队列

**Files:**
- Create: `src/lib/db/provider/sqlite/repo-projects.ts`、`repo-messages.ts`（挂到 storage）
- Test: `tests/db/repo-projects.test.ts`

**Interfaces:**
- Produces（StorageProvider 新增方法）：
  - `createProject(input:{sessionId,title,requirement,mode}):Promise<Project>`
  - `listProjects(sessionId):Promise<Array<Project & {fileCount:number; totalTokens:number; lastMessage:string|null}>>`（groupBy 聚合，禁 N+1）
  - `getProject(projectId):Promise<Project|null>`
  - `renameProject(projectId,title):Promise<void>`
  - `deleteProject(projectId):Promise<void>`（级联）
  - `updateProjectStatus(projectId,status):Promise<void>`
  - `addMessage(input:{projectId,role,content,meta?}):Promise<Message>`
  - `listMessages(projectId):Promise<Message[]>`
  - `takePendingInterventions(projectId):Promise<Message[]>`（role=intervention 且 deliveredAt IS NULL）
  - `markDelivered(messageIds:number[]):Promise<void>`
  - `getRecentSessions(sessionId,limit=8):Promise<Project[]>`（updatedAt 倒序）

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { newTestStorage } from '@/lib/db/test-util';
describe('repo projects/messages', () => {
  it('删除项目级联消息；干预队列取后标记', async () => {
    const s = newTestStorage();
    const p = await s.createProject({ sessionId:'s1', title:'t', requirement:'r', mode:'fast' });
    await s.addMessage({ projectId:p.id, role:'intervention', content:'按钮改蓝色' });
    const pend = await s.takePendingInterventions(p.id);
    expect(pend.length).toBe(1);
    await s.markDelivered([pend[0].id]);
    expect((await s.takePendingInterventions(p.id)).length).toBe(0);
    await s.deleteProject(p.id);
    expect(await s.getProject(p.id)).toBeNull();
    expect((await s.listMessages(p.id)).length).toBe(0);
  });
  it('跨 session 隔离', async () => {
    const s = newTestStorage();
    await s.createProject({ sessionId:'a', title:'t', requirement:'r', mode:'fast' });
    expect((await s.listProjects('b')).length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（drizzle 查询，全部 where 带 sessionId/projectId；聚合用 `leftJoin+groupBy`）
- [ ] **Step 4: 跑测试通过**
- [ ] **Step 5: Commit** `feat(db): project/message/intervention repos`

---

### Task 4: 仓库层 — files 虚拟 FS（乐观锁/版本/人工 CAS）

**Files:**
- Create: `src/lib/db/provider/sqlite/repo-files.ts`
- Test: `tests/db/repo-files.test.ts`

**Interfaces:**
- Produces:
  - `upsertFile(input:{projectId,path,content,editor:AgentRole|'human'|'seed'}):Promise<{fileId,version}>`——已存在时旧版本入 `file_versions`、version+1；**事务内不做 IO**
  - `getFile(projectId,path):Promise<FileRow|null>`、`getFileById(projectId,fileId)`
  - `listFiles(projectId):Promise<Array<{path,version,lastEditor}>>`（file_tree 用）
  - `saveHuman(input:{projectId,fileId,content,baseVersion}):Promise<{ok:true,version:number}|{ok:false,conflict:true,current:string}>`（CAS）
  - `listFileVersions(projectId,fileId):Promise<FileVersion[]>`
  - `restoreFileVersion(projectId,fileId,version):Promise<number>`（恢复=新版本写入，可再撤销）
  - `setSoftLock(projectId,fileId,on:boolean):Promise<void>`（editingBy='human'，10min 过期）
  - `getSoftLockedFiles(projectId):Promise<FileRow[]>`（未过期）
  - `readAllFiles(projectId):Promise<FileRow[]>`（快照/导出用）

- [ ] **Step 1: 失败测试**

```ts
it('CAS：并发写一个成功一个冲突', async () => {
  const s = newTestStorage();
  const p = await s.createProject({ sessionId:'s', title:'t', requirement:'r', mode:'fast' });
  const f = await s.upsertFile({ projectId:p.id, path:'app/a.js', content:'v1', editor:'engineer' });
  const a = await s.saveHuman({ projectId:p.id, fileId:f.fileId, content:'human', baseVersion:1 });
  const b = await s.saveHuman({ projectId:p.id, fileId:f.fileId, content:'human2', baseVersion:1 });
  expect(a).toEqual({ ok:true, version:2 });
  expect(b.ok).toBe(false);
  const vers = await s.listFileVersions(p.id, f.fileId);
  expect(vers.length).toBeGreaterThanOrEqual(1); // 旧版本已存
});
it('软锁过期不计入', async () => { /* setSoftLock(true) → getSoftLockedFiles 有；把 editingExpiresAt 改过去 → 无 */ });
```

- [ ] **Step 2-4: 红绿**（实现：CAS 用 `update().set().where(and(eq(id),eq(version,base)))`，changes=0 → conflict 并回读 current）
- [ ] **Step 5: Commit** `feat(db): virtual FS repo with optimistic CAS + versions + soft lock`

---

### Task 5: 仓库层 — agent_runs / checkpoints / llm_calls / preferences

**Files:**
- Create: `src/lib/db/provider/sqlite/repo-runs.ts`、`repo-misc.ts`
- Test: `tests/db/repo-runs.test.ts`

**Interfaces:**
- Produces:
  - `createAgentRun(input:{projectId,taskKey,agent,task}):Promise<AgentRun>`
  - `updateAgentRun(id,patch:{status?,summary?,error?,startedAt?,endedAt?}):Promise<void>`
  - `listAgentRuns(projectId):Promise<AgentRun[]>`
  - `markRunsRolledBack(projectId,uptoRunId:number):Promise<void>`
  - `createCheckpoint(projectId,label,agentRunId|null):Promise<number>`（快照当前全部 files 入 checkpoint_files，事务）
  - `restoreCheckpoint(projectId,cpId):Promise<number[]>`（当前内容先各入 file_versions，再恢复快照，返回受影响 fileId）
  - `listCheckpoints(projectId):Promise<Checkpoint[]>`
  - `recordLlmCall(input:{projectId,agentRole,model,promptTokens,completionTokens,estimated,cost,latencyMs}):Promise<void>`
  - `usageByProject(projectId):Promise<Array<{agentRole,model,tokens:number,calls:number}>>`（groupBy）
  - `getPreference(scope:'session',targetId:string):Promise<unknown|null>`、`setPreference(scope,targetId,data)`

- [ ] **Step 1-4: 红绿**（测试覆盖：checkpoint 恢复后 files 内容回到快照且旧内容可再找回；rolled_back 标记）
- [ ] **Step 5: Commit** `feat(db): runs/checkpoints/llm_calls/preferences repos`

---

### Task 6: LLM 层 — 类型 / Mock / OpenAI 兼容客户端 / 计量

**Files:**
- Create: `src/lib/llm/types.ts`、`mock.ts`、`client.ts`、`usage.ts`、`estimate.ts`
- Test: `tests/llm/client.test.ts`

**Interfaces:**
- Produces:

```ts
export interface LlmMessage { role:'system'|'user'|'assistant'|'tool';
  content:string; toolCalls?:ToolCall[]; toolCallId?:string; }
export interface ToolCall { id:string; name:string; args:unknown; }
export interface ToolDef { name:string; description:string; parameters:Record<string,unknown>; } // JSON Schema
export interface LlmRequest { model:string; messages:LlmMessage[]; tools?:ToolDef[];
  maxTokens?:number; signal?:AbortSignal; }
export interface LlmResult { content:string; toolCalls:ToolCall[]; usage:{promptTokens:number;completionTokens:number}|null; }
export interface LlmProvider { name:string;
  complete(req:LlmRequest):Promise<LlmResult>;
  stream(req:LlmRequest, onDelta:(text:string)=>void):Promise<LlmResult>; }
export function getLlmProvider(env=process.env):LlmProvider;   // LLM_PROVIDER=mock|openai
export function resolveModel(role:AgentRole, env=process.env):string; // 全局默认+角色覆盖
export function estimateTokens(text:string):number; // 中文≈1.2/字 + 其他≈chars/3.5，ceil
export async function meteredCall(storage, projectId, role, req, onDelta?):Promise<LlmResult>;
// meteredCall：调用→usage 缺失则 estimateTokens 估算标 estimated=1→cost=0（单价默认 0）→recordLlmCall
```

Mock 行为规格（DESIGN §5⑥，**离线全链路的基石**）：按消息中的角色标记路由固定优质样例——
- leader 收到路由请求 → 返回 toolCalls：`assign_task`×3（pm→architect→engineer，task_key 依赖链）
- pm → 返回样例 PRD markdown（含功能清单/用户故事/验收标准，引用 `src/lib/agents/roles/samples/prd.md`）
- architect → 返回样例 system_design.md + 5 段 mermaid + `file_tree` JSON（samples/design.md、filetree.json）
- engineer → 对每个目标 path 用模板生成对应内容（samples/app-skeleton.ts：index.html/api.js/start_app.sh 模板函数，按 requirement 注入标题）
- expert → 固定报告模板；closer → 固定 MEMORY/总结
- stream 以 6 字符/chunk、5ms 间隔吐出（测试用 0ms）

- [ ] **Step 1: 失败测试**（mock 流式完整、estimateTokens 中文校准：`estimateTokens('一二三四五')≈6`、`'abcdefgh'≈3`、meteredCall 落库 estimated=1 当 usage=null）
- [ ] **Step 2-4: 红绿**（openai 客户端用 fetch 直连 `${LLM_BASE_URL}/chat/completions`，stream=true + `stream_options:{include_usage:true}`，SSE 解析 `data:` 行聚合 tool_calls 增量；超时 90s AbortSignal.timeout）
- [ ] **Step 5: Commit** `feat(llm): provider abstraction + mock + openai-compat + metering`

---

### Task 7: 工具层 — 路径沙箱 + FS 工具

**Files:**
- Create: `src/lib/agents/tools/sandbox.ts`、`fs-tools.ts`、`index.ts`
- Test: `tests/agents/tools.test.ts`

**Interfaces:**
- Produces:

```ts
export function normalizeProjectPath(input:string):{ok:true,path:string}|{ok:false,error:string};
// 拒绝：空、以/开头、含 \ 或 \0、分段含 .. 或 .、非法字符（白名单 [A-Za-z0-9._-] 每段）、>200 字符、以/结尾
export interface ToolContext { storage:StorageProvider; projectId:number; }
export interface Tool { name:string; description:string; parameters:JSONSchema; 
  execute(args:unknown, ctx:ToolContext):Promise<{ok:boolean;output:string}>; }
export const fsTools:Tool[]; // write_file/read_file/list_files/grep
// write_file：normalize→upsertFile(editor=当前角色)→输出 `已写入 <path> v<version>`
// read_file：截断保护（>400 行返回首尾各 200 行 + 行数提示）
// grep：JS RegExp 扫 readAllFiles，输出 path:line 匹配行（上限 50 行）
```

- [ ] **Step 1: 失败测试**（`../escape`、`/abs`、`a\\b`、`a/./b` 拒绝；`docs/prd.md` 通过；write_file 落库；read_file 截断）
- [ ] **Step 2-4: 红绿**
- [ ] **Step 5: Commit** `feat(agents): path sandbox + fs tools`

---

### Task 8: AgentRunner 内核（工具循环）

**Files:**
- Create: `src/lib/agents/runner.ts`、`types.ts`
- Test: `tests/agents/runner.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RunnerCallbacks {
  onToolCall?: (call:{name:string;args:unknown;output:string})=>void;   // 落库/展示
  onDelta?: (text:string)=>void;                                        // 流式转发
}
export interface RunOptions { role:AgentRole; systemPrompt:string; userPrompt:string;
  tools:Tool[]; model:string; maxSteps?:number; ctx:ToolContext; provider?:LlmProvider;
  callbacks?:RunnerCallbacks; signal?:AbortSignal; }
export interface RunResult { content:string; steps:number; toolCalls:{name:string;args:unknown}[]; }
export async function runAgent(opts:RunOptions):Promise<RunResult>;
```

内核行为（对齐 DESIGN §3.4 三段式与 §4.6 防失控）：循环 `messages → provider.stream`；有 toolCalls → zod 校验（由 Tool 自带 zod schema，Task 7 的 parameters 由 `zodToJsonSchema` 生成）→ 校验失败：把错误作为 tool 结果回喂重试（同一循环内**仅重试一次**，再失败终止并抛 `AgentValidationError`）；成功 → `execute` → 结果以 `{role:'tool',toolCallId}` 回喂；无 toolCalls → 结束返回 content。`maxSteps`（默认 12）超限抛错；`signal.aborted` 抛 `AbortError`。

- [ ] **Step 1: 失败测试**（用注入的 FakeProvider：①模型先调坏参数 write_file 再调正确 → 一次重试后成功 ②两轮坏 → AgentValidationError ③maxSteps=1 且持续 toolCalls → 超限 ④onDelta 收到流式文本）
- [ ] **Step 2-4: 红绿**
- [ ] **Step 5: Commit** `feat(agents): AgentRunner tool loop with validation retry`

---

### Task 9: 上下文组装器 + 预算裁剪

**Files:**
- Create: `src/lib/agents/context.ts`
- Test: `tests/agents/context.test.ts`

**Interfaces:**
- Consumes: `readAllFiles/getFile/estimateTokens`、`MAX_CONTEXT_CHARS=24000`
- Produces:

```ts
export interface AssembleInput { storage:StorageProvider; projectId:number; role:AgentRole;
  systemPrompt:string; task:string; upstreamSummaries:string[]; interventions:string[];
  fileTreePath?:string; extraFiles?:string[]; /* 依赖声明文件 */ }
export async function assembleContext(input:AssembleInput):Promise<{system:string;user:string}>;
```

组装顺序（DESIGN §4.1）：system = 角色提示词 + 个人偏好（preferences session）+ `.atoms/PREFERENCES.md` + `.atoms/reports/MEMORY.md`（存在时）；user = 需求（project.requirement）+ 上游交接摘要 + 干预指令 + file_tree 全文 + 依赖文件全文（fileTree JSON 的 depends ∪ extraFiles）+ 任务指令。**裁剪**：总量 > 24000 字符时依序丢：非依赖文件正文→MEMORY 详情保留首 2000 字符→system_design 仅保留含关键词段。返回的 user 末尾固定一行：`（当前打开的文件：…；生成的文件将被实时写入并可视化展示）`可省略——保持纯业务。

- [ ] **Step 1: 失败测试**（注入超长依赖文件 → 裁掉非依赖文件但 file_tree 保留；中文估算触发阈值正确；MEMORY/PREFERENCES 注入存在）
- [ ] **Step 2-4: 红绿**
- [ ] **Step 5: Commit** `feat(agents): context assembler with rule-based trimming`

---

### Task 10: 校验与安全层

**Files:**
- Create: `src/lib/validation/syntax.ts`、`danger.ts`、`index.ts`
- Test: `tests/validation/danger.test.ts`

**Interfaces:**
- Produces:

```ts
export function checkSyntax(path:string, content:string):{ok:boolean;error?:string};
// .js/.mjs → acorn.parse(content,{ecmaVersion:'latest'})；.json → JSON.parse；.html → parse5.parse（必检 <html 与 </script> 配对粗检）；.md/.mmd/.sh → 放行
export interface Danger { severity:'hard'|'soft'; rule:string; detail:string; }
export function scanDanger(path:string, content:string):Danger[];
// acorn 遍历 AST：hard=eval/new Function/setTimeout(字符串)/postMessage 且 target 含 parent|top
// 正则辅检 .html：hard=<script src="http:（非白名单）；soft=while(true) 无 break、fetch( 非 /api/ 开头
export function validateFile(path:string, content:string):{ok:boolean; hard:Danger[]; soft:Danger[]; syntaxError?:string};
```

- [ ] **Step 1: 失败测试**（eval→hard；`postMessage(msg,'*')` 到 parent→hard；`while(true){}` 无 break→soft；坏 JS `function{`→syntaxError；正常 index.html→ok）
- [ ] **Step 2-4: 红绿**（`npm i acorn parse5`）
- [ ] **Step 5: Commit** `feat(validation): syntax + dangerous API AST scan`

---

### Task 11: 角色 — 领导（路由/分派/回退/@覆盖）

**Files:**
- Create: `src/lib/agents/roles/leader.ts`
- Test: `tests/agents/leader.test.ts`

**Interfaces:**
- Consumes: `runAgent`、mock provider
- Produces:

```ts
export interface TaskAssignment { taskKey:string; agent:AgentRole; instruction:string;
  writesPaths:string[]; dependsOn:string[]; }
export interface LeaderDecision { kind:'tasks'; tasks:TaskAssignment[]; reply?:string }
                 | { kind:'reply'; reply:string }
export async function routeLeader(input:{ storage:StorageProvider; projectId:number;
  userMessage:string; mode:'fast'|'full'; mentions:AgentRole[]; hasFiles:boolean;
  signal?:AbortSignal }):Promise<LeaderDecision>;
```

行为：mentions 非空 → 直接 `{kind:'tasks', tasks: mentions.map((a,i)=>({taskKey:`user-${a}-${i}`,agent:a,instruction:userMessage,writesPaths:['docs/','app/'],dependsOn:[]}))}`（**不调 LLM**）。否则 leader system prompt（含 7 角色职责表、四类意图、assign_task JSON 契约、模式说明）+ runAgent 工具 `assign_task/reply_to_user/finish` 收集；**回退**：解析失败或零任务且无 reply → 默认流水线——full 模式 `pm-prd→arch-design→eng-code`（链式 dependsOn），fast 模式 `pm-lite→eng-code`；迭代场景（hasFiles && 消息含"改/加/换/调整"或 instruction 短）回退为仅 `eng-iterate`。

- [ ] **Step 1: 失败测试**（mock：①mentions=[engineer] 不调 LLM 直出任务 ②mock leader 正常出 3 任务链 ③leader mock 配置为坏输出 → 回退默认流水线 3 任务）
- [ ] **Step 2-4: 红绿**
- [ ] **Step 5: Commit** `feat(agents): leader routing with mentions override and fallback`

---

### Task 12: 角色 — PM 与架构师（含黄金样例）

**Files:**
- Create: `src/lib/agents/roles/samples/prd.md`、`samples/design.md`、`samples/filetree.json`、`roles/pm.ts`、`roles/architect.ts`
- Test: `tests/agents/pm-architect.test.ts`

**Interfaces:**
- Produces:
  - `runPm(ctx:{storage,projectId,requirement,fast:boolean,signal?}):Promise<{runId:number;files:string[]}>`——产出 `docs/prd.md`（fast=true 时 prompt 要求半页精简版）
  - `runArchitect(ctx:{storage,projectId,signal?}):Promise<{runId:number;files:string[];fileTree:FileTree}>`——产出 `docs/system_design.md`、5 张 `.mmd`（architecture/er_diagram/sequence_diagram/class_diagram/ui_navigation）、`docs/file_tree.md`（人读）+ 解析出结构化 `FileTree` 存 run.summary（JSON 序列化）
  - `export interface FileTreeNode { path:string; desc:string; depends:string[]; }  export type FileTree = FileTreeNode[]`

PM/架构师实现为"结构化单发"：不用工具循环，`runAgent` 零工具 + system prompt 规定输出为**单个 markdown 代码块内的完整文件内容**（架构师则约定每张图/文档以 `===== path =====` 分隔的多段输出），runner 返回后由角色代码切分落库（upsertFile），每段落库前过 `validateFile`（soft 记录即可）。samples/ 三份黄金样例既是 mock 数据源也是 prompt 中的 few-shot 示例。

- [ ] **Step 1: 失败测试**（mock 下 PM 产出 docs/prd.md 落库；架构师产出 7 个 docs 文件且 fileTree 解析出 nodes 带 depends；输出缺图 → 缺什么少什么，不抛错）
- [ ] **Step 2-4: 红绿**
- [ ] **Step 5: Commit** `feat(agents): pm + architect roles with golden samples`

---

### Task 13: 角色 — 工程师（混合模式 + 模板骨架 + 自审）

**Files:**
- Create: `src/lib/agents/roles/samples/app-skeleton.ts`、`roles/engineer.ts`
- Test: `tests/agents/engineer.test.ts`

**Interfaces:**
- Consumes: `FileTree`、fsTools、runAgent、validateFile
- Produces:
  - `buildFastFileTree(requirement:string):FileTree`——关键词确定性选型（todo/list→CRUD 模板；dashboard/看板→仪表盘；默认落地页），返回 4-5 节点固定树（index.html 依赖 api.js）
  - `runEngineerFile(ctx:{storage,projectId,requirement,target:FileTreeNode,fileTree:FileTree,designSummary:string,signal?}):Promise<{runId:number;path:string;version:number;ok:boolean;softWarnings:string[]}>`——**单文件任务**：assembleContext（依赖文件全文注入）→ runAgent（工具：write_file/read_file/list_files）→ 模型必须 write_file 目标文件；产出后 `validateFile`：syntaxError/hard → 带错误反馈**重试一次** → 仍败标 ⚠（ok=false，落库保留，SSE 标记）；soft 记录
  - `runEngineerReview(ctx:{...同上,path}):Promise<boolean>`——自审调用（廉价 review prompt：语法/逻辑/遗漏/XSS 清单，发现问题→覆写 write_file）；一次即止

app-skeleton.ts 提供 `renderIndexHtml(requirement, apiRoutes)`/`renderApiJs(routes)`/`renderStartSh()`：现代 UI 基线（Tailwind CDN、#F7F7F8、蓝强调、圆角、空态/加载态、CRUD 交互、`fetch('/api/...')`、内存态、无 localStorage）——**保底模板即质量下限**。

- [ ] **Step 1: 失败测试**（buildFastFileTree('做一个待办清单') → 含 app/frontend/index.html 与 app/backend/api.js 且前者 depends 后者；mock engineer 单文件任务落库 v1；validateFile hard → 重试路径被调（用 FakeProvider 计数）→ 第二次成功；两次 hard → ok=false 且文件仍落库带 ⚠ meta）
- [ ] **Step 2-4: 红绿**
- [ ] **Step 5: Commit** `feat(agents): hybrid engineer with skeleton templates and self-review`

---

### Task 14: 角色 — 专家 + 收尾（MEMORY/汇报）

**Files:**
- Create: `src/lib/agents/roles/experts.ts`、`roles/closer.ts`、`src/lib/agents/registry.ts`
- Test: `tests/agents/experts.test.ts`

**Interfaces:**
- Produces:
  - `runExpert(ctx:{storage,projectId,role:'analyst'|'seo'|'ads',instruction,signal?})`——各产出一篇 `docs/{analyst|seo|ads}_report.md`（结构化单发，同 PM 模式）
  - `runCloser(ctx:{storage,projectId,signal?})`——收尾：写 `.atoms/reports/MEMORY.md`（选型/约束/人工修改清单文件列表/偏好捕捉）+ 追加 PROGRESS.md「领导汇报」段 + 返回汇报文本（作为 assistant message）
  - `roleRegistry:Record<AgentRole,{name:string;emoji:string;color:string;blurb:string}>`——@ 浮层与头像数据源（蓝#3B82F6 领导/紫#8B5CF6 PM/青#06B6D4 架构师/绿#10B981 工程师/橙#F59E0B 分析师/粉#EC4899 SEO/红#EF4444 广告）

- [ ] **Step 1-4: 红绿**（测试：analyst 产出报告落库；closer 写 MEMORY 且汇报文本非空；registry 七角色齐全）
- [ ] **Step 5: Commit** `feat(agents): expert roles + closer + role registry`

---

### Task 15: 编排器 — 串行 DAG / 检查点 / 干预 / 停止 / 事件总线

**Files:**
- Create: `src/lib/agents/events.ts`、`orchestrator.ts`、`progress.ts`
- Test: `tests/agents/orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 3-14 全部产物
- Produces:

```ts
// events.ts
export type StreamEventName='agent_start'|'file_start'|'delta'|'file_end'|'agent_end'|'message'
  |'intervention_injected'|'done'|'stopped'|'error';
export interface StreamEvent { seq:number; projectId:number; runId:number|null;
  event:StreamEventName; agent?:AgentRole; path?:string; content?:string; summary?:string;
  error?:string; meta?:Record<string,unknown>; }
export class ProjectEventBus { // 每 project 一个，单例 Map
  emit(projectId:number, e:Omit<StreamEvent,'seq'|'projectId'>):StreamEvent;
  subscribe(projectId:number, fn:(e:StreamEvent)=>void, afterSeq?:number):()=>void; // afterSeq 重放 ring buffer（cap 500）
  snapshotBuffer(projectId:number, afterSeq:number):StreamEvent[]; liveBuffer(projectId:number, path:string):string; // 正在流式文件全文
}
// orchestrator.ts
export async function startGeneration(input:{storage:StorageProvider;projectId:number;
  userMessage:string; mode:'fast'|'full'; mentions:AgentRole[]; signal:AbortSignal; }):Promise<void>;
export async function stopProject(storage:StorageProvider, projectId:number):Promise<void>;
export function orchestratorStatus(projectId:number):'idle'|'running';
```

编排流程（DESIGN §3.3/3.5/3.10）：每 project 互斥队列（Map<id,Promise>）；`addMessage(user)` → `routeLeader` → 拓扑序**串行**执行任务：每任务前 `createCheckpoint('任务前:'+taskKey)` + `takePendingInterventions` 注入（emit intervention_injected）→ 软锁检查（目标文件被 human 锁且 agent=engineer → 该文件任务挂起并在聊天区 message 请求裁决，跳过）→ 角色执行（PM/架构师单发；工程师遍历 fileTree：每文件 runEngineerFile，onDelta→emit delta，file_start/file_end 包夹；专家单发）→ validate hard 重试在角色内部 → 成功 `updateAgentRun(done)` + summary；失败标 failed、emit error（不中断后续无依赖任务，工程师文件失败继续下一文件）→ 全部完成 `runCloser` + `updateProjectStatus(done)` + emit done。**停止**：stopProject → AbortController.abort() → 各层抛 AbortError → 标 stopped、emit stopped。PROGRESS.md 由 progress.ts 在每个任务边界模板化追加（✅/🔄/⏸/❌ 行）。流式中断的文件内容保存在 bus.liveBuffer（file_end 时清除）。

- [ ] **Step 1: 失败测试**（mock 全链路：①建项目→startGeneration→订阅事件序列包含 agent_start(pm)…file_start…delta…file_end…done；files 最终含 docs/*+app/*；PROGRESS.md 存在且含 ✅ ②stopProject 中途 → 事件含 stopped、project.status=paused ③注入 pending intervention → 事件 intervention_injected 且 PM 产物上下文含指令（以 messages deliveredAt 断言）④单文件 hard×2 → 该文件 ok=false，流程继续，done 仍发出）
- [ ] **Step 2-4: 红绿**（这是最大的实现任务，~300 行）
- [ ] **Step 5: Commit** `feat(orchestrator): serial DAG + checkpoints + intervention + stop + event bus`

---

### Task 16: API 路由 — SSE / 项目 CRUD / 干预 / 停止 / 重试 / 恢复 / 预览 / 导出

**Files:**
- Create: `src/app/api/projects/route.ts`、`[id]/route.ts`、`[id]/stream/route.ts`、`[id]/stop/route.ts`、`[id]/messages/route.ts`、`[id]/preview/route.ts`、`[id]/export/route.ts`、`[id]/files/[fid]/route.ts`、`[id]/files/[fid]/regenerate/route.ts`、`[id]/checkpoints/[cpId]/restore/route.ts`
- Create: `src/lib/preview/assemble.ts`、`src/lib/session.ts`
- Test: `tests/api/routes.test.ts`（vitest 直调 route handler 函数 + mock Request）

**Interfaces:**
- Produces（全部 handler 输入 zod 校验；session cookie `atoms_session` httpOnly SameSite=Lax）：
  - `GET /api/projects`：listProjects(session)；`POST`：{requirement,mode,mentions?} → 建项目 + addMessage → **后台启动 startGeneration（不 await）** → 201 {project}
  - `GET /api/projects/[id]`：现场恢复快照 = project + messages + files(全量) + agentRuns + checkpoints + usage + 正在流式文件（bus.liveBuffer）+ 软锁列表；`PATCH`：重命名；`DELETE`：删除（200）
  - `GET /api/projects/[id]/stream`：SSE——立即返回 Response（force-dynamic），头含 `X-Accel-Buffering:no`；`Last-Event-ID` → subscribe(afterSeq) 重放；心跳 20s `: ping`；`request.signal` 触发 unsubscribe
  - `POST /api/projects/[id]/messages`：{content,mentions?} → running 时 role=intervention 入队，否则作为新一轮 startGeneration；返回 200
  - `POST .../stop`：stopProject；`POST .../files/[fid]/regenerate`：按该文件 path 重跑 runEngineerFile（单文件重试）；`POST .../checkpoints/[cpId]/restore`：restoreCheckpoint + SSE message 通知
  - `PATCH .../files/[fid]`：{content,baseVersion} → saveHuman（409 时返回 {conflict:true,current}）
  - `GET .../preview`：`assemblePreview(storage,projectId)` 返回 text/html + CSP 头（`default-src 'none'; script-src 'unsafe-inline' https://cdn.tailwindcss.com; style-src 'unsafe-inline' https://cdn.tailwindcss.com; img-src data: https:; connect-src 'none'`）；`GET .../export`：jszip 打包 readAllFiles → application/zip
- `assemble.ts`：取 index.html，在 `<head>` 后注入 `<script>` = api.js 源码（包装 `window.__ATOMS_BACKEND__=(function(){const module={exports:{}};...return module.exports})()`，api.js 用 CommonJS `module.exports={handle}` 约定）+ fetch 拦截器（`/api/` 开头路由到 handle，否则原 fetch）；无 api.js 时只注入拦截器占位

- [ ] **Step 1: 失败测试**（POST 建项目返回 201 且 stream 收到事件；Last-Event-ID 重放；PATCH CAS 冲突返回 409 结构；preview 含 `__ATOMS_BACKEND__` 与 CSP；export zip 字节头 PK；stop 后 status=paused）
- [ ] **Step 2-4: 红绿**（SSE handler 用 `new ReadableStream({start(c){...}})` 包 bus.subscribe）
- [ ] **Step 5: Commit** `feat(api): projects/stream/stop/messages/preview/export routes`

---

### Task 17: 前端基础 — 会话/SSE store/应用骨架/首页/项目页

**Files:**
- Create: `src/lib/client/session.ts`、`src/lib/client/store.ts`（zustand 或自写 useSyncExternalStore——**选自写**，避免新依赖：`workspaceStore`）
- Create: `src/components/shell/AppSidebar.tsx`、`src/app/layout.tsx`（改）、`src/app/page.tsx`（首页 hero）、`src/app/projects/page.tsx`、`src/components/home/HomeHero.tsx`、`src/components/projects/{ProjectsGrid,ProjectCard}.tsx`
- Test: `tests/client/store.test.ts`

**Interfaces:**
- Produces:
  - `workspaceStore`：`{project, files:Map<path,{content,version,lastEditor,streaming}>, messages, runs, checkpoints, usage, connected, applyEvent(e:StreamEvent):void, hydrate(snapshot):void}`——applyEvent 按 event 分流：file_start 建 streaming 占位、delta 追加、file_end 定版+streaming 清除、agent_* 更新 runs、message/intervention_injected 追加消息、done/stopped 收尾；**delta 只渲染当前打开 path 的打字机，其余只更新树状态**
  - `useWorkspace(projectId)` hook：hydrate(GET 快照) → new EventSource(`/api/projects/${id}/stream`) → onmessage applyEvent → onerror 依赖浏览器自动重连（EventSource 自带，带 Last-Event-ID）
  - AppSidebar：logo、首页/我的项目导航（active 态）、最近（GET projects 取 8 条，hover 删除→DELETE+刷新）、底部头像+设置入口
  - HomeHero：7 角色 emoji 头像排（registry）、大标题「输入想法，产出产品」、输入卡（textarea 自适应、@浮层占位 Task 19 接线、模式胶囊 fast/full、⊕、黑色发送↑）、示例 chips（番茄钟/待办清单/数据看板）、公告条（「v1 支持多智能体团队协作」可关闭）；提交 → POST /api/projects → router.push(`/p/${id}`)
  - ProjectsGrid/ProjectCard：卡片含标题（双击 inline 重命名 PATCH）、摘要、lastMessage、状态徽章、模式标签、文件数、tokens、相对时间；操作菜单（进入/导出 zip/删除→Dialog 二次确认→DELETE）

- [ ] **Step 1: 失败测试**（store：喂合成事件序列 [file_start,delta×2,file_end,done] → files 定版、messages 追加、streaming 清除；hydrate 快照幂等）
- [ ] **Step 2: 红绿实现 store**
- [ ] **Step 3: 组件实现**（shadcn 不可用则手写等价组件，样式按 `.claude/rules/04` token）
- [ ] **Step 4: 验证**：`npm run dev` 手动过 首页→建项目（mock）→跳转；`npx vitest run`；`npm run build`
- [ ] **Step 5: Commit** `feat(ui): app shell + home hero + projects grid + SSE store`

---

### Task 18: 工作台三栏布局 + 顶栏

**Files:**
- Create: `src/app/p/[id]/page.tsx`、`src/components/workspace/{Workspace,TopBar}.tsx`
- Test: `tests/client/workspace.test.tsx`（render smoke：三栏存在、空态提示）

**Interfaces:**
- Consumes: useWorkspace、store
- Produces: Workspace 三栏（聊天 30% 含 ChatPanel；文件树 20%；查看器 50% 含 ViewerTabs/PreviewPane——后者 Task 21/22 填充，先占位）；TopBar（返回 logo、项目标题+状态下拉、视图切换 tabs[编辑器|预览]、agent 头像排（运行中角色高亮+脉冲）、分享按钮（复制链接 toast）、设置入口）；窄屏（<lg）折叠为单栏+底部 tab 切换

- [ ] **Step 1-4: 红绿 + 手动验证**
- [ ] **Step 5: Commit** `feat(ui): workspace three-pane layout + topbar`

---

### Task 19: 聊天面板（消息流/工具卡/时间线/@浮层/干预/停止）

**Files:**
- Create: `src/components/chat/{ChatPanel,MessageList,ToolCard,Timeline,ChatInput,MentionPopover}.tsx`、`src/lib/client/mentions.ts`
- Test: `tests/client/mentions.test.ts`、`tests/client/chat.test.tsx`

**Interfaces:**
- Produces:
  - `parseMention(text)`：光标前 `@` 触发、返回 `{query, activeAgent?}`；chip 数据 `roleRegistry`
  - ChatInput：受控 textarea + chips（多选）+ `@` 浮层（↑↓/Enter/Esc/点击；前缀过滤）；运行中发送 → POST messages（干预，输入框上方黄条提示「📥 将注入下一个步骤」）+ 输入框保持可用；左下停止⏹（POST stop，运行中才显示，替代发送钮）；模式胶囊
  - MessageList：user 消息（右对齐浅底）带 chips；assistant 消息直接排列；ToolCard（📄/✏️ 图标 + path + 产物摘要，点击打开文件）；失败红条；领导汇报卡
  - Timeline：圆点+竖线，每任务行（emoji+名称+状态：pending 灰/running 蓝+流式动画/done 绿✓/failed 红/stopped 灰⏸），「⭐ 用户指定」标记，「回到此任务前」按钮（Task 25 接线）

- [ ] **Step 1-4: 红绿**（mentions 纯函数完整测；ChatPanel render smoke + 发送干预按钮行为）
- [ ] **Step 5: Commit** `feat(ui): chat panel with mentions, interventions, timeline`

---

### Task 20: 文件树

**Files:**
- Create: `src/components/tree/FileTree.tsx`、`src/lib/client/tree.ts`（路径→树结构纯函数）
- Test: `tests/client/tree.test.ts`

**Interfaces:**
- Produces: `buildTree(paths:string[]):TreeNode[]`（折叠目录 .atoms/docs/app 顶层默认展开）；FileTree：搜索框过滤、目录折叠箭头、类型图标（md/代码/图/sh）、**M 角标**（蓝=agent、绿=human，取 lastEditor）、streaming 文件=闪烁图标+行数计数、选中浅蓝圆角高亮、底部「⬇ 下载项目」（GET export → blob 下载）；新文件出现动画（CSS transition opacity/translate）

- [ ] **Step 1-4: 红绿**（buildTree 纯函数全测：嵌套/排序/过滤）
- [ ] **Step 5: Commit** `feat(ui): file tree with badges and streaming state`

---

### Task 21: 查看器（tabs/markdown/mermaid/打字机/编辑态/冲突）

**Files:**
- Create: `src/components/viewer/{ViewerTabs,MarkdownView,CodeView,MermaidView,TypewriterScroller,EditToggle,ConflictDialog}.tsx`
- Test: `tests/client/viewer.test.tsx`

**Interfaces:**
- Produces:
  - ViewerTabs：多文件页签（M 图标+文件名+×关闭，激活下划线），点击树文件开新 tab/激活已有
  - 分发渲染：`.md`→MarkdownView（react-markdown+表格/引用徽章，代码块经 Shiki 高亮，动态 import）；`.mmd`→MermaidView（mermaid.render try/catch，**失败降级**：显示源码+「图表语法错误」提示条）；其余→CodeView（Shiki 按扩展名，流式态=已到内容实时高亮 debounce 120ms）
  - TypewriterScroller：流式文件自动滚动（scrollTop 跟随，用户上滚即暂停跟随，回底部恢复）
  - EditToggle：右上「编辑」按钮（偏好开关关闭时隐藏）→ textarea 等宽编辑态 → 保存 PATCH（baseVersion=当前）；409 → ConflictDialog（「工程师已更新」+三选：用我的/用 agent 的/并排 diff（两栏 pre+行级差异高亮简化为整行红绿）后选）；进入编辑即 `setSoftLock(true)`，离开/保存后 false
- [ ] **Step 1-4: 红绿**（ViewerTabs 开关行为、MermaidView 坏语法降级、ConflictDialog 选择回调）
- [ ] **Step 5: Commit** `feat(ui): viewer tabs with markdown/mermaid/typewriter/edit`

---

### Task 22: 预览面板（E1 全栈预览）

**Files:**
- Create: `src/components/preview/PreviewPane.tsx`
- Test: `tests/client/preview.test.tsx`

**Interfaces:**
- Consumes: `/api/projects/[id]/preview`
- Produces: TopBar「预览」tab → PreviewPane：`<iframe src="/api/projects/{id}/preview" sandbox="allow-scripts" className="w-full h-full">`；工具条（刷新=重设 src、新窗口全屏=open(url)、设备宽度切换 375/768/100%）；生成中显示占位（「工程师完成 frontend 后可预览」）；iframe 已由服务端 CSP + sandbox 隔离

- [ ] **Step 1-4: 红绿 + mock 链路手动点验（todo CRUD 在预览里真实可用）**
- [ ] **Step 5: Commit** `feat(ui): full-stack preview pane (E1)`

---

### Task 23: 人机共编编排接线（软锁裁决 + 偏好开关）

**Files:**
- Modify: `src/lib/agents/orchestrator.ts`（工程师文件任务前检查软锁）、`src/app/api/settings/route.ts`（新）
- Create: `src/components/common/EditSwitch.tsx`（顶栏）
- Test: `tests/agents/colab.test.ts`

**Interfaces:**
- Produces: 工程师目标文件被 human 软锁 → 该文件任务跳过 + bus emit `message`（agent=leader，content=「检测到你正在编辑 {path}：保留你的修改并跳过 / 覆盖生成 / 完成编辑后继续」）+ 把 pending 三个选项以 intervention 形式等待（用户回复「覆盖」→ 重跑该文件任务；「跳过」→ 标 rolled_back 该 run；「稍后」→ 不动）；`GET/PUT /api/settings`：preferences session 读写 `{editing_enabled:boolean, default_mode:'fast'|'full'}`；EditSwitch 顶栏持久化

- [ ] **Step 1-4: 红绿**（软锁存在→文件被跳过且裁决消息发出；「覆盖」干预→任务重跑）
- [ ] **Step 5: Commit** `feat(colab): soft-lock negotiation + edit preference switch`

---

### Task 24: 设置页 — Provider/模型/绑定/用量（P3.5）

**Files:**
- Create: `src/app/settings/page.tsx`、`src/app/api/settings/providers/route.ts`（+`[id]`）、`src/components/settings/{ProvidersPanel,ModelBindPanel,UsageCards}.tsx`
- Test: `tests/api/settings.test.ts`

**Interfaces:**
- Produces: Provider CRUD（预设下拉：豆包/ARK、DeepSeek、GLM、Kimi、OpenAI——填 base_url/key/enabled；key 输入框 password 态、列表只显尾 4 位）；模型列表（model_id/display_name/单价 input）；agent 绑定表（7 行×下拉选模型，含「跟随全局默认」）；UsageCards：usageByProject 聚合卡片（按 agent/model 分组，tokens+调用数+estimated 标记）；「测试连接」按钮（发 1 token 请求验证）

- [ ] **Step 1-4: 红绿**（CRUD 往返；绑定为空时 resolveModel 回退全局）
- [ ] **Step 5: Commit** `feat(settings): providers/models/bindings/usage (P3.5)`

---

### Task 25: Seed / 检查点回滚 UI / 收尾打磨

**Files:**
- Create: `scripts/seed.ts`；Modify: `src/components/chat/Timeline.tsx`（回滚按钮接线）
- Test: `tests/e2e/mock-chain.test.ts`

**Interfaces:**
- Produces:
  - `seed.ts`：首次启动（projects 表空）插入 2 个 seed 项目（直接用 samples 渲染文件树落库，status=done，sessionId='seed'）——演示保底 + 卡片墙初始内容
  - Timeline「回到此任务前」：POST checkpoints/{cpId}/restore → 确认 Dialog（提示当前未保存人工修改将被覆盖）→ store hydrate 刷新
  - `mock-chain.test.ts`：**全链路集成**——newTestStorage + mock provider → startGeneration('做一个待办清单', fast) → 断言事件序列完整、files 含 docs/+app/frontend/index.html+app/backend/api.js、PROGRESS/MEMORY 存在、llm_calls 有记录、usageByProject 非空 → `assemblePreview` 含垫片 → 单文件 regenerate 成功 → checkpoint restore 内容回滚

- [ ] **Step 1-4: 红绿**
- [ ] **Step 5: Commit** `feat: seed + checkpoint restore ui + mock e2e chain`

---

### Task 26: 交付物 — README / Docker / 验证

**Files:**
- Create: `README.md`、`Dockerfile`、`docker-compose.yml`、`docs/DEMO-SCRIPT.md`

**Interfaces:**
- Produces:
  - README：架构图（mermaid：用户→Next.js→编排器→AgentRunner→LLM/虚拟FS→SSE→IDE）、30 秒启动（`.env.example` 说明、`npm i && npm run db:push && npm run dev`）、**设计取舍章节**（D1-D4 决策表、为什么 SQLite/为什么浏览器内全栈/为什么不上 RAC/威胁模型/并发演进路径——直接引用 DESIGN 章节链接）、3 分钟演示脚本（同 DEMO-SCRIPT.md）
  - Dockerfile：multi-stage（node:22-alpine + 构建 → runner 仅 `next start` + better-sqlite3 prebuilt）；compose：app + volume `./data`
  - 最终验证清单（全部必须实际执行并在 commit message 记录结果）：`npx vitest run` 全绿 / `npm run build` 通过 / `npm run dev` mock 全链路手动过（建项目→生成→预览→干预→停止→刷新恢复→回滚→编辑冲突→@指定→删除项目）/ 真实模型冒烟（DASHSCOPE env，快速模式一个待办应用，人工验收 UI）/ `docker compose up` 冒烟

- [ ] **Step 1-4: 逐项验证**
- [ ] **Step 5: Commit** `docs: README + docker + demo script; chore: final verification`

---

---

### Task 27: Provider 增强 — 模型探测 / 角色路由 / Fallback 链（用户追加，参考 hify-provider 设计）

**Files:**
- Create: `src/lib/llm/probe.ts`、`fallback.ts`、`resolve.ts`
- Test: `tests/llm/probe.test.ts`、`tests/llm/fallback.test.ts`

**背景**（hify-provider 移植蓝图）：Java 侧的三层实体 provider→model_config→消费者外键、`/v1/models` 发现导入、test-connection 计时、60s 健康探测状态机（fail≥3→DOWN/DEGRADED）可直接借鉴；fallback 链 hify 缺失，由本任务自建（类型化错误 + 顺序降级 + 内存健康度排序）。

**Interfaces:**
- `probeProvider({baseUrl, apiKey, timeoutMs=10_000}): Promise<ProbeResult>`——GET `{baseUrl去尾斜杠}/models`（OpenAI 兼容 `data[].id`），墙钟计时；`ProbeResult = {ok:true, latencyMs:number, models:string[]} | {ok:false, latencyMs:number, error:string}`（密钥不进 error）
- `classifyLlmError(e:unknown): 'aborted'|'auth'|'rate_limited'|'timeout'|'network'|'bad_response'|'unknown'`——abort 永不 fallback；auth 在同 provider 内不重试但**换 provider 正当**；rate_limited/timeout/network/bad_response 可降级
- `withFallback(chain: Array<() => LlmProvider>, opts?): LlmProvider`——按序尝试，可降级错误换下一个，全败抛最后错误；`onFallback?: (from:string, to:string, code) => void`（落 console + 供 T24 用量展示）
- `resolveRoleModel(role:AgentRole, env, storage?): Promise<{model:string; providerConfig?:{baseUrl,apiKey}}>`——优先级：agent_model_bindings（DB，storage 提供时）→ `LLM_MODEL_<ROLE>` → `LLM_MODEL`；DB 路径返回 providerConfig（绑定供应商的连接信息），env 路径 providerConfig 为空（走全局 env）
- 内存健康度：`fallback.ts` 内 `Map<providerKey, {failCount, lastLatencyMs}>`，降级排序参考（fail≥3 的排后）——单实例内存态，多实例外置列为演进（DESIGN §12）

**Steps:**
- [ ] **Step 1: 失败测试**——probe（stub fetch：200 带 data[].id / 401 / 超时；latencyMs>0）、classify（六类各一）、withFallback（①主成功不降级 ②主 timeout→备成功 ③主 auth→备成功（换 provider 正当）④全败抛最后 ⑤aborted 不降级 ⑥链空=原样）、resolveRoleModel（env 三级 + DB 绑定优先，fake storage）
- [ ] **Step 2-4: 红绿**（不改 getLlmProvider 现有行为——fallback 是显式包装，默认链为空）
- [ ] **Step 5: Commit** `feat(llm): provider probe + role model resolution + fallback chain`

**与 T24 的边界**：T27 提供核心层（probe/resolve/fallback）；T24 的设置页 UI 与 providers CRUD API 消费它们（「测试连接」按钮=probeProvider，「模型导入」=probe.models 落 llm_models，绑定下拉=resolveRoleModel 数据源）。

---

### Task 28: RetrievalProvider 扩展点 — Grep 默认 + FTS5 可选（§12 落地，用户追加）

**Files:**
- Create: `src/lib/retrieval/types.ts`、`grep.ts`、`fts.ts`、`registry.ts`
- Modify: `src/lib/agents/tools/fs-tools.ts`（grep 工具走路由）、`src/lib/db/provider/sqlite/ddl.ts`（FTS5 虚表+触发器）、对应 parity 测试
- Test: `tests/retrieval/retrieval.test.ts`

**Interfaces:**

```ts
export interface RankedHit { path:string; line:number; text:string; score:number; }
export interface RetrievalProvider {
  name:'grep'|'fts5';
  search(query:string, opts:{projectId:number; limit?:number}):Promise<RankedHit[]>;
}
export function getRetriever(storage:StorageProvider, env=process.env):RetrievalProvider;
// RETRIEVAL_PROVIDER=fts5 时 FtsRetriever（同 app.db 内 fts5 虚表，trigram 分词，bm25 排序，
// files 表触发器同步索引）；默认 grep（现行为，纯 RegExp 扫描）
```

- grep 工具改经 `getRetriever`（默认输出与今天逐字节等价——行为不变是验收标准）
- FTS5：`CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(path, content, tokenize='trigram')` + INSERT/UPDATE/DELETE 触发器；虚表 DDL 进 ddl.ts 并过 T2 对齐守卫（drizzle-kit 不管虚表，db:push 幂等验证）
- DESIGN §12 表补「检索 | RetrievalProvider | GrepRetriever | FtsRetriever（trigram/bm25）」行

**Steps:**
- [ ] Step 1: 失败测试——grep 路由默认等价；fts5 建表+触发器同步（写文件→立即搜到；删文件→搜不到）；trigram 命中 `api.js` 子串；bm25 排序确定性；跨项目隔离
- [ ] Step 2-4: 红绿 + parity 守卫扩展
- [ ] Step 5: Commit `feat(retrieval): provider registry with grep default + fts5 opt-in`

**排期**：批次 D 之后（不占关键路径；用户可指令提前）。

## Self-Review 结论



- **Spec 覆盖**：DESIGN §1-§12 逐节核对——编排(§3.1-3.4→T11/15)、干预停止(§3.5→T15/16/19)、SSE(§3.6→T15/16/17)、预览(§3.7→T16/22)、快速模式+seed(§3.8→T11/13/25)、人机共编(§3.9→T4/21/23)、检查点(§3.10→T5/25)、Harness(§4→T8/9)、质量+校验(§5⑤⑤′→T10/13)、模型管理/计量(§5①③→T6/24)、隔离(§4.7→T3/7)、检索(§4.1→T9)、布局(§2→T17-22)、@指定(§3.1→T11/19)。Race Mode(E3)/Publish(E4) 按 DESIGN §8 降级阶梯为"时间富余"项，未入计划（如需追加为 T27）。
- **占位符扫描**：无 TBD/TODO；UI 任务给出组件结构+行为规格+关键代码路径。
- **类型一致性**：`AgentRole/StreamEvent/upsertFile/saveHuman/runAgent/routeLeader/startGeneration/FileTree` 等签名在各 Task 间已交叉核对一致。
