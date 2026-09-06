# PROGRESS.md 任务拆解清单（复选框逐项打勾）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把平台产出的 `.atoms/reports/PROGRESS.md` 从「时序状态行日志」改成「任务计划清单」：每轮生成写入一节计划，大任务拆解为小任务复选框（交付物/单文件级），由编排器逐项打勾——小任务勾完才算完成，后续任务在前置打勾后才派发。

**Architecture:** 双层架构不变（DESIGN §3.3：拆分任务=领导 LLM、标记进度=编排器代码）。拆解粒度全部来自**确定性来源**：架构师 8 个固定交付物（`ARCHITECT_DOC_PATHS`）、PM/专家固定产出路径、工程师 file_tree 文件清单——编排器在任务开跑前预写子任务复选框，边界处原地改写（`[ ]`→`[x]`）。「完成确认后才开始后续步骤」由 V1 串行 DAG 天然保证（前一任务 settle 才派发下一个），打勾是该确认的留痕；**不引入人工逐步放行门**（与 D4 全自动演示流冲突，人工介入走既有干预/软锁通道）。人工编辑改坏格式时降级为追加注记行（记录不丢、不崩）。

**Tech Stack:** TypeScript strict（现有 `src/lib/agents/progress.ts` + `orchestrator.ts`），vitest + 内存存储（`@/lib/db/test-util` 的 `newTestStorage`）。

**Spec:** 用户验收反馈（2026-09-06）：「产出的 PROGRESS.md 没有把大任务拆解成小任务，逐个完成后打勾确认开始后续的步骤」；`docs/DESIGN.md` §3.3（标记进度=编排器）、§1（产出结构）；`docs/DEMO-SCRIPT.md` 验收项（PROGRESS.md 随任务推进）。

## Global Constraints

- TypeScript strict；禁 `any`/`@ts-ignore`；数组索引访问判空（noUncheckedIndexedAccess 语义）
- `progress.ts` 服务端专用（写 files 表），不得进客户端 bundle
- 注释与文档中文；标识符/commit message 英文；commit 前缀 feat/fix/chore，直接 main
- 串行编排下无并发写 progress 文件；写入 editor='leader'（与现状一致）
- 所有进度写操作必须在 `CLOSING_SECTION_HEADING`（`## 领导汇报`）**之前**插入/改写——closer 收尾会从该标题整段覆盖到文末
- 用户可见文案中文；emoji 语义沿用现有约定（🔄 进行中 / ✅ 已完成 / ⏸ 挂起或跳过 / ❌ 失败 / ⚠ 注记）

## 目标文档形态（验收基准）

```markdown
# 项目进度（PROGRESS）

> 每轮生成写入一节任务计划：大任务拆成小任务复选框，由编排器逐项打勾（[x]=已完成）；
> 串行执行保证后续任务在前置全部打勾后才派发。⚠/⏸ 为注记行；收尾时团队领导追加「领导汇报」段。

## 任务计划（2026-09-06 14:30）

- [x] pm-prd（产品经理）：已完成快速模式精简 PRD…
  - [x] docs/prd.md
- [x] arch-design（架构师）：架构师产出 8/8 个设计交付物…
  - [x] docs/system_design.md
  - [x] docs/architecture.mmd
  …（8 项）
- [ ] eng-code（工程师）：按 file_tree 逐文件实现全栈应用… —— 🔄
  - [x] app/backend/api.js（v1）
  - [ ] app/frontend/index.html：❌ 硬性违规 dangerous_api——出现 eval 用法
- ⚠ 架构师未产出 file_tree，按内置模板树降级（新写 4 个文件）

## 领导汇报
…
```

行文法（机器可匹配，改写按前缀定位）：
- 任务行：`- [<空格|x>] {taskKey}（{角色名}）：{文本}`
- 子任务行（2 空格缩进）：`  - [<空格|x>] {path}` 或 `  - [<空格|x>] {path}（v{N}）` 或 `  - [ ] {path}：{状态注记}`
- 注记行：`- ⚠ …`（降级/自审失败/环警告），照旧走 `appendProgressLine` 追加

---

### Task 1: progress.ts 复选框原语（TDD）

**Files:**
- Modify: `src/lib/agents/progress.ts`
- Test: `tests/agents/progress.test.ts`（新建）

**Interfaces:**
- Consumes: `PROGRESS_PATH` / `PROGRESS_HEADER` / `CLOSING_SECTION_HEADING`（closer.ts 既有导出）、`roleRegistry`、`StorageProvider`
- Produces（后续任务依赖，签名精确）:
  - `interface RoundPlanRef { heading: string }`
  - `startRoundPlan(storage: StorageProvider, projectId: number, tasks: ReadonlyArray<{ taskKey: string; agent: AgentRole; instruction: string }>): Promise<RoundPlanRef>`
  - `addTaskSubtasks(storage, projectId, ref: RoundPlanRef, taskKey: string, paths: readonly string[]): Promise<void>`
  - `markTaskLine(storage, projectId, ref, taskKey: string, line: string): Promise<void>`
  - `markFileLine(storage, projectId, ref, path: string, line: string): Promise<void>`
  - 既有行构造器改输出：`taskStartLine` → `- [ ] key（角色）：… —— 🔄`；`taskDoneLine` → `- [x] …`；`taskFailedLine`/`taskSkippedLine` → `- [ ] …：❌/⏸ …`；`fileDoneLine` → `  - [x] path（vN）`；`fileFailedLine`/`filePausedLine`/`fileResumedLine`/`fileSkippedLine` → `  - [ ] path：…`；新增 `filePlanLine(path)` → `  - [ ] path`
  - `appendProgressLine` 行为不变（注记行继续用）；内部抽 `appendProgressBlock(storage, projectId, block)` 供多行插入复用

- [ ] **Step 1: 写失败测试** `tests/agents/progress.test.ts`

```ts
/**
 * progress.ts 单元：任务计划清单原语（轮计划 / 子任务 / 原地打勾 / 作用域 / 降级）。
 * 存储走内存桩（newTestStorage），不依赖 LLM。
 */
import { describe, expect, it } from 'vitest';
import { newTestStorage } from '@/lib/db/test-util';
import {
  addTaskSubtasks,
  appendProgressLine,
  fileDoneLine,
  filePlanLine,
  markFileLine,
  markTaskLine,
  startRoundPlan,
  taskDoneLine,
  taskStartLine,
} from '@/lib/agents/progress';
import { CLOSING_SECTION_HEADING, PROGRESS_PATH } from '@/lib/agents/roles/closer';
import type { StorageProvider } from '@/lib/db/provider/types';

async function contentOf(storage: StorageProvider, projectId: number): Promise<string> {
  const row = await storage.getFile(projectId, PROGRESS_PATH);
  if (row === null) throw new Error(`${PROGRESS_PATH} 未生成`);
  return row.content;
}

async function newProject(): Promise<{ storage: StorageProvider; projectId: number }> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'full' });
  return { storage, projectId: project.id };
}

const PM = { taskKey: 'pm-prd', agent: 'pm' as const, instruction: '产出 PRD，写入 docs/prd.md' };
const ENG = { taskKey: 'eng-code', agent: 'engineer' as const, instruction: '逐文件实现' };

describe('progress 任务计划清单', () => {
  it('startRoundPlan：缺失时带头部创建；每任务一行未勾选，顺序即入参序', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [PM, ENG]);
    const content = await contentOf(storage, projectId);
    expect(content).toContain('# 项目进度（PROGRESS）');
    expect(content).toContain(ref.heading);
    expect(content).toMatch(/^- \[ \] pm-prd（产品经理）：产出 PRD/m);
    expect(content).toMatch(/^- \[ \] eng-code（工程师）：逐文件实现/m);
    expect(content.indexOf('pm-prd')).toBeLessThan(content.indexOf('eng-code'));
  });

  it('startRoundPlan：同分钟重跑不撞锚（标题追加序号）', async () => {
    const { storage, projectId } = await newProject();
    const a = await startRoundPlan(storage, projectId, [PM]);
    const b = await startRoundPlan(storage, projectId, [PM]);
    expect(a.heading).not.toBe(b.heading);
  });

  it('addTaskSubtasks：子任务缩进行插在任务行正下方', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [PM, ENG]);
    await addTaskSubtasks(storage, projectId, ref, 'pm-prd', ['docs/prd.md']);
    const lines = (await contentOf(storage, projectId)).split('\n');
    const idx = lines.findIndex((l) => l.startsWith('- [ ] pm-prd（'));
    expect(lines[idx + 1]).toBe(filePlanLine('docs/prd.md'));
  });

  it('markTaskLine：整行原地改写（[ ]→[x]），其余行不动', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [PM, ENG]);
    await markTaskLine(storage, projectId, ref, 'pm-prd', taskStartLine(PM.agent, PM.taskKey, PM.instruction));
    await markTaskLine(storage, projectId, ref, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '完成'));
    const content = await contentOf(storage, projectId);
    expect(content).toMatch(/^- \[x\] pm-prd（产品经理）：完成$/m);
    expect(content).toMatch(/^- \[ \] eng-code（工程师）/m); // 未触碰
    expect(content.match(/pm-prd/g)).toHaveLength(1); // 无重复行
  });

  it('markFileLine：按路径改写子任务行；找不到时降级为文末注记行', async () => {
    const { storage, projectId } = await newProject();
    const ref = await startRoundPlan(storage, projectId, [ENG]);
    await addTaskSubtasks(storage, projectId, ref, 'eng-code', ['app/a.js', 'app/b.js']);
    await markFileLine(storage, projectId, ref, 'app/a.js', fileDoneLine('app/a.js', 1));
    const content = await contentOf(storage, projectId);
    expect(content).toMatch(/^  - \[x\] app\/a\.js（v1）$/m);
    expect(content).toMatch(/^  - \[ \] app\/b\.js$/m);
    // 未登记的路径：降级追加（不崩、不丢记录）
    await markFileLine(storage, projectId, ref, 'app/c.js', fileDoneLine('app/c.js', 2));
    expect((await contentOf(storage, projectId)).split('\n').at(-1)).toBe('  - [x] app/c.js（v2）');
  });

  it('作用域：第二轮不误改第一轮同 taskKey 的复选框', async () => {
    const { storage, projectId } = await newProject();
    const r1 = await startRoundPlan(storage, projectId, [PM]);
    await markTaskLine(storage, projectId, r1, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '第一轮完成'));
    const r2 = await startRoundPlan(storage, projectId, [PM]);
    await markTaskLine(storage, projectId, r2, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '第二轮完成'));
    const content = await contentOf(storage, projectId);
    expect(content).toMatch(/^- \[x\] pm-prd（产品经理）：第一轮完成$/m);
    expect(content).toMatch(/^- \[x\] pm-prd（产品经理）：第二轮完成$/m);
    expect(content.indexOf(r1.heading)).toBeLessThan(content.indexOf(r2.heading));
  });

  it('收尾段保护：已有「## 领导汇报」时，插入与改写都发生在段之前', async () => {
    const { storage, projectId } = await newProject();
    await appendProgressLine(storage, projectId, '- ✅ 历史进度行');
    await storage.upsertFile({
      projectId,
      path: PROGRESS_PATH,
      content: `# 项目进度（PROGRESS）\n\n- ✅ 历史进度行\n\n${CLOSING_SECTION_HEADING}\n旧汇报\n`,
      editor: 'leader',
    });
    const ref = await startRoundPlan(storage, projectId, [PM]);
    await markTaskLine(storage, projectId, ref, 'pm-prd', taskDoneLine(PM.agent, PM.taskKey, '完成'));
    const content = await contentOf(storage, projectId);
    expect(content.indexOf('- [x] pm-prd')).toBeLessThan(content.indexOf(CLOSING_SECTION_HEADING));
    expect(content.indexOf(ref.heading)).toBeLessThan(content.indexOf(CLOSING_SECTION_HEADING));
    expect(content).toContain('旧汇报'); // 段内不越界覆盖
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/agents/progress.test.ts`
Expected: FAIL（`startRoundPlan` 等未导出 / 旧行格式不匹配）

- [ ] **Step 3: 实现 progress.ts v2**

在现有文件上改造（保留 `snippet`/`appendProgressLine` 语义，新增以下内容；行构造器按 Interfaces 改输出）：

```ts
/** 本轮任务计划的作用域锚点：编排器轮内持有，子任务登记与打勾都限定在本节内 */
export interface RoundPlanRef {
  /** 节标题整行（含时间戳；同分钟重跑追加 #N 序号保证全文唯一） */
  heading: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 节标题时间戳（本地时区，分钟粒度） */
function roundStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** [start, end) 行区间：从锚点标题行之后到收尾段标题（无则文末） */
function regionOf(lines: readonly string[], ref: RoundPlanRef): { start: number; end: number } {
  const headingIdx = lines.findIndex((item) => item === ref.heading);
  const closingIdx = lines.findIndex((item) => item.trim() === CLOSING_SECTION_HEADING);
  const end = closingIdx < 0 ? lines.length : closingIdx;
  return { start: headingIdx < 0 ? 0 : headingIdx + 1, end };
}

/** 区间内最后一个匹配行的下标（无匹配返回 -1） */
function lastMatchIn(lines: readonly string[], region: { start: number; end: number }, pattern: RegExp): number {
  for (let i = region.end - 1; i >= region.start; i -= 1) {
    if (pattern.test(lines[i] ?? '')) return i;
  }
  return -1;
}

/** 写回（读-改-写一体：串行编排下无并发写） */
async function writeLines(storage: StorageProvider, projectId: number, lines: readonly string[]): Promise<void> {
  await storage.upsertFile({ projectId, path: PROGRESS_PATH, content: lines.join('\n'), editor: 'leader' });
}

/** 在收尾段之前插入一个多行块（appendProgressLine 的块版本，同一插入纪律） */
async function appendProgressBlock(storage: StorageProvider, projectId: number, block: string): Promise<void> {
  const existing = await storage.getFile(projectId, PROGRESS_PATH);
  if (existing === null) {
    await storage.upsertFile({ projectId, path: PROGRESS_PATH, content: `${PROGRESS_HEADER}\n\n${block}\n`, editor: 'leader' });
    return;
  }
  const lines = existing.content.split('\n');
  const headingIdx = lines.findIndex((item) => item.trim() === CLOSING_SECTION_HEADING);
  if (headingIdx < 0) {
    await writeLines(storage, projectId, [...existing.content.split('\n').map((l, i, arr) => (i === arr.length - 1 && l === '' ? l : l)), ''].length === 0 ? [] : [...lines.slice(0, lines.length - (lines.at(-1) === '' ? 1 : 0)), block, '']);
    return;
  }
  const prefix = lines.slice(0, headingIdx).join('\n').trimEnd();
  const suffix = lines.slice(headingIdx).join('\n');
  await storage.upsertFile({ projectId, path: PROGRESS_PATH, content: `${prefix}\n${block}\n\n${suffix}\n`, editor: 'leader' });
}

export async function startRoundPlan(
  storage: StorageProvider,
  projectId: number,
  tasks: ReadonlyArray<{ taskKey: string; agent: AgentRole; instruction: string }>,
): Promise<RoundPlanRef> {
  const base = `## 任务计划（${roundStamp()}）`;
  const existing = await storage.getFile(projectId, PROGRESS_PATH);
  let heading = base;
  let seq = 2;
  // 锚点行必须全文唯一（同分钟重跑/测试快速连跑时追加序号）
  while (existing !== null && existing.content.split('\n').some((line) => line === heading)) {
    heading = `${base} #${seq}`;
    seq += 1;
  }
  const planLines = tasks.map((t) => `- [ ] ${t.taskKey}（${roleRegistry[t.agent].name}）：${snippet(t.instruction, 60)}`);
  await appendProgressBlock(storage, projectId, [heading, '', ...planLines].join('\n'));
  return { heading };
}

export async function addTaskSubtasks(
  storage: StorageProvider,
  projectId: number,
  ref: RoundPlanRef,
  taskKey: string,
  paths: readonly string[],
): Promise<void> {
  if (paths.length === 0) return;
  const existing = await storage.getFile(projectId, PROGRESS_PATH);
  if (existing === null) return; // 不可达（startRoundPlan 已创建），防御返回
  const lines = existing.content.split('\n');
  const region = regionOf(lines, ref);
  const taskIdx = lastMatchIn(lines, region, new RegExp(`^- \\[[ x]\\] ${escapeRegExp(taskKey)}（`));
  const insertAt = taskIdx >= 0 ? taskIdx + 1 : region.end; // 任务行被人工删除：垫到节末尾（仍在收尾段之前）
  lines.splice(insertAt, 0, ...paths.map((p) => `  - [ ] ${p}`));
  await writeLines(storage, projectId, lines);
}

export async function markTaskLine(
  storage: StorageProvider,
  projectId: number,
  ref: RoundPlanRef,
  taskKey: string,
  line: string,
): Promise<void> {
  const ok = await rewriteRegionLine(storage, projectId, ref, new RegExp(`^- \\[[ x]\\] ${escapeRegExp(taskKey)}（`), line);
  if (!ok) await appendProgressBlock(storage, projectId, line); // 人工改坏格式：降级为注记行，记录不丢
}

export async function markFileLine(
  storage: StorageProvider,
  projectId: number,
  ref: RoundPlanRef,
  path: string,
  line: string,
): Promise<void> {
  const ok = await rewriteRegionLine(storage, projectId, ref, new RegExp(`^  - \\[[ x]\\] ${escapeRegExp(path)}($|（|：)`), line);
  if (!ok) await appendProgressBlock(storage, projectId, line);
}

async function rewriteRegionLine(
  storage: StorageProvider,
  projectId: number,
  ref: RoundPlanRef,
  pattern: RegExp,
  newLine: string,
): Promise<boolean> {
  const existing = await storage.getFile(projectId, PROGRESS_PATH);
  if (existing === null) return false;
  const lines = existing.content.split('\n');
  const idx = lastMatchIn(lines, regionOf(lines, ref), pattern);
  if (idx < 0) return false;
  lines[idx] = newLine;
  await writeLines(storage, projectId, lines);
  return true;
}
```

（实现时把 `appendProgressLine` 改为委托 `appendProgressBlock`，消除两份插入纪律；上面 appendProgressBlock 无收尾段分支的 trimEnd 拼接写法定稿时简化为与 appendProgressLine 现有实现同构的字符串拼接。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/agents/progress.test.ts`
Expected: PASS（7 个用例全绿）

- [ ] **Step 5: 跑编排器既有测试确认破坏面**

Run: `npx vitest run tests/agents/orchestrator.test.ts`
Expected: ①④ 断言 FAIL（`✅` 消失、行格式变化）——这是 Task 2/3 的修改对象，记录失败清单；⑤/降级/自审用例应仍 PASS（注记行未变）

- [ ] **Step 6: Commit**

```bash
git add src/lib/agents/progress.ts tests/agents/progress.test.ts
git commit -m "feat(progress): checklist primitives for round task plans (checkbox subtasks)"
```

---

### Task 2: 编排器接线——轮计划写入 + 任务级打勾

**Files:**
- Modify: `src/lib/agents/orchestrator.ts`（TaskContext 加 `plan`；主循环 4 处 note→markTaskLine；topo 后 startRoundPlan）
- Test: `tests/agents/orchestrator.test.ts`（①⑤ 用例断言更新）

**Interfaces:**
- Consumes: Task 1 的 `startRoundPlan`/`markTaskLine`/`taskStartLine`/`taskDoneLine`/`taskFailedLine`/`taskSkippedLine`/`RoundPlanRef`
- Produces: `TaskContext.plan: RoundPlanRef`（Task 3 的 dispatch* 与 negotiateSoftLock 依赖它做子任务打勾）

- [ ] **Step 1: 更新编排器测试①的断言（先红）**

`tests/agents/orchestrator.test.ts` 用例①中，把：
```ts
expect(progress.content).toContain('✅');
expect(progress.content.indexOf('✅')).toBeLessThan(progress.content.indexOf(CLOSING_SECTION_HEADING));
```
改为：
```ts
// 任务计划清单：节标题 + 任务级打勾 + 勾选项在收尾段之前
expect(progress.content).toContain('## 任务计划（');
expect(progress.content).toMatch(/^- \[x\] pm-prd（产品经理）/m);
expect(progress.content).toMatch(/^- \[x\] arch-design（架构师）/m);
expect(progress.content).toMatch(/^- \[x\] eng-code（工程师）/m);
expect(progress.content.indexOf('- [x]')).toBeLessThan(progress.content.indexOf(CLOSING_SECTION_HEADING));
expect(progress.content).not.toMatch(/—— 🔄/m); // 全部完成，无进行中残留
```
并在文件头注释第 6 行同步描述（「PROGRESS.md 含 ✅」→「PROGRESS.md 为任务计划清单，任务级 [x] 打勾且在收尾段之前」）。

- [ ] **Step 2: 跑①确认失败**

Run: `npx vitest run tests/agents/orchestrator.test.ts -t '完整链路'`
Expected: FAIL（尚无计划节）

- [ ] **Step 3: 实现编排器接线**

`orchestrator.ts`：
1. import 增补 `markTaskLine, startRoundPlan, type RoundPlanRef`（来自 `@/lib/agents/progress`）
2. `TaskContext` 增加字段：
```ts
/** 本轮任务计划锚点（子任务登记与打勾的作用域） */
plan: RoundPlanRef;
```
3. `executeGeneration` 中 `taskByKey` 建好后：
```ts
// 任务计划清单（用户验收 2026-09-06）：整轮 DAG 预写为复选框，边界处逐项打勾
const plan = await startRoundPlan(
  storage,
  projectId,
  topo.order
    .map((key) => taskByKey.get(key))
    .filter((task): task is TaskAssignment => task !== undefined),
);
```
4. 循环内 `c: TaskContext = { ... }` 字面量加 `plan`
5. 四处替换（语义不变，载体从追加改打勾）：
   - `await note(taskSkippedLine(task.agent, taskKey, failedDep))` → `await markTaskLine(storage, projectId, plan, taskKey, taskSkippedLine(task.agent, taskKey, failedDep))`
   - `await note(taskStartLine(...))` → `await markTaskLine(storage, projectId, plan, taskKey, taskStartLine(task.agent, taskKey, task.instruction))`
   - `await note(taskDoneLine(...))` → `await markTaskLine(storage, projectId, plan, taskKey, taskDoneLine(task.agent, taskKey, result.summary))`
   - `await note(taskFailedLine(...))` → `await markTaskLine(storage, projectId, plan, taskKey, taskFailedLine(task.agent, taskKey, message))`

- [ ] **Step 4: 跑①与⑤确认通过（⑤断言未动，验证注记行不受影响）**

Run: `npx vitest run tests/agents/orchestrator.test.ts`
Expected: ①⑤ PASS；④仍 FAIL（子任务行未接线，留给 Task 3）

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/orchestrator.ts tests/agents/orchestrator.test.ts
git commit -m "feat(orchestrator): write round task plan and tick task checkboxes in PROGRESS"
```

---

### Task 3: 角色子任务拆解与逐项打勾

**Files:**
- Modify: `src/lib/agents/orchestrator.ts`（dispatchPm/Architect/Engineer/Expert + negotiateSoftLock）
- Test: `tests/agents/orchestrator.test.ts`（①④ 补子任务断言）、`tests/agents/colab.test.ts`（仅确认软锁 ⏸ 断言仍绿，不预期改动）

**Interfaces:**
- Consumes: Task 1 的 `addTaskSubtasks`/`markFileLine`/`filePlanLine`/`fileDoneLine`/`fileFailedLine`/`filePausedLine`/`fileResumedLine`/`fileSkippedLine`；Task 2 的 `TaskContext.plan`；`ARCHITECT_DOC_PATHS`（architect.ts 既有导出，8 项）；`PRD_PATH`（pm.ts）；`EXPERT_REPORT_PATHS`（experts.ts）
- Produces: 无新接口（行为完备）

- [ ] **Step 1: 补失败断言（先红）**

用例①追加（成功链全打勾）：
```ts
// 子任务拆解：PM/架构师/工程师的交付物逐项打勾
expect(progress.content).toMatch(/^  - \[x\] docs\/prd\.md$/m);
expect((progress.content.match(/^  - \[x\] docs\//gm) ?? []).length).toBeGreaterThanOrEqual(8); // 架构师 8 交付物
expect(progress.content).toMatch(/^  - \[x\] app\/backend\/api\.js（v\d+）$/m);
```
用例④追加（单文件失败保持未勾 + ❌ 注记）：
```ts
expect(progress.content).toMatch(/^- \[ \] app\/frontend\/index\.html：❌ /m);
```
（④现有 `toContain('❌')`、`toContain('app/frontend/index.html')` 保留。）

- [ ] **Step 2: 跑①④确认失败**

Run: `npx vitest run tests/agents/orchestrator.test.ts`
Expected: ①④ FAIL（子任务行尚不存在）

- [ ] **Step 3: 实现四个 dispatch 的子任务接线**

1. import 增补：`addTaskSubtasks, fileDoneLine, fileFailedLine, filePausedLine, fileResumedLine, fileSkippedLine, markFileLine`（progress）与 `ARCHITECT_DOC_PATHS`（architect）
2. `dispatchPm`：`agent_start` emit 后：
```ts
await addTaskSubtasks(storage, projectId, c.plan, task.taskKey, [PRD_PATH]);
```
`file_end` 后（row 已取）：
```ts
await markFileLine(storage, projectId, c.plan, PRD_PATH, fileDoneLine(PRD_PATH, row?.version ?? 1));
```
3. `dispatchArchitect`：`agent_start` emit 后：
```ts
// 交付物清单事前可知（8 个 docs 文件）——预写子任务复选框，产出后逐项打勾
await addTaskSubtasks(storage, projectId, c.plan, task.taskKey, ARCHITECT_DOC_PATHS);
```
`result.files` 循环内（row 已取）：
```ts
await markFileLine(storage, projectId, c.plan, path, fileDoneLine(path, row?.version ?? 1));
```
4. `dispatchEngineer`：
   - 把循环内两个 `continue` 条件上提为先过滤工作集，再登记子任务：
```ts
// 工作集 = file_tree 去掉 docs 交付物与本轮上游产物（原循环内 continue 条件上提）
const workNodes = tree.filter(
  (node) => node.path !== 'docs' && !node.path.startsWith('docs/') && !round.producedThisRound.has(node.path),
);
await addTaskSubtasks(storage, projectId, c.plan, task.taskKey, workNodes.map((node) => node.path));
for (const node of workNodes) {
```
   （循环体删除对应两行 `continue` 判断，其余不动）
   - ok 分支：`await appendProgressLine(storage, projectId, fileDoneLine(result.path, result.version))` → `await markFileLine(storage, projectId, c.plan, result.path, fileDoneLine(result.path, result.version))`
   - fail 分支：`await appendProgressLine(storage, projectId, fileFailedLine(...))` → `await markFileLine(storage, projectId, c.plan, result.path, fileFailedLine(result.path, result.errors ?? []))`
5. `negotiateSoftLock`（有 `c: TaskContext`，即有 `c.plan`）三处替换：
   - `await appendProgressLine(storage, projectId, filePausedLine(path))` → `await markFileLine(storage, projectId, c.plan, path, filePausedLine(path))`
   - `fileSkippedLine` / `fileResumedLine` 同理
6. `dispatchExpert`：`agent_start` 后 `addTaskSubtasks(storage, projectId, c.plan, task.taskKey, [path])`；`file_end` 后（row 已取）`markFileLine(..., fileDoneLine(path, row?.version ?? 1))`

- [ ] **Step 4: 跑全量 agent 测试确认通过**

Run: `npx vitest run tests/agents/`
Expected: 全 PASS（含 colab 软锁 ⏸ 断言——`filePausedLine` 仍含路径与 ⏸）

- [ ] **Step 5: Commit**

```bash
git add src/lib/agents/orchestrator.ts tests/agents/orchestrator.test.ts
git commit -m "feat(orchestrator): decompose tasks into per-deliverable subtask checkboxes"
```

---

### Task 4: 文件头模板与文档同步

**Files:**
- Modify: `src/lib/agents/roles/closer.ts`（仅 `PROGRESS_HEADER` 文案）
- Modify: `docs/DESIGN.md`（§3.3 标记进度口径、§1 产出结构注释如涉及）
- Modify: `docs/DEMO-SCRIPT.md`（验收项措辞）

**Interfaces:**
- Consumes: 无
- Produces: 文档口径与实现一致（后续读者以此为准）

- [ ] **Step 1: 改 PROGRESS_HEADER 文案**

```ts
export const PROGRESS_HEADER = [
  '# 项目进度（PROGRESS）',
  '',
  '> 每轮生成写入一节「任务计划」：大任务拆成小任务复选框，由编排器逐项打勾（[x]=已完成，❌/⏸=失败或挂起）；',
  '> 串行执行保证后续任务在前置全部打勾后才派发。⚠ 为注记行；收尾时团队领导追加「领导汇报」段。',
].join('\n');
```

- [ ] **Step 2: DESIGN.md §3.3 同步**

「标记进度=编排器（代码：步骤边界更新 agent_runs + 模板化追加 PROGRESS.md）」改为：
「标记进度=编排器（代码：步骤边界更新 agent_runs + 维护 PROGRESS.md 任务计划清单——轮次开始预写任务复选框，大任务按确定性交付物拆子任务复选框，边界处逐项打勾；人工改坏格式时降级为注记行）」。§1 产出结构处如有格式描述一并同步。

- [ ] **Step 3: DEMO-SCRIPT.md 验收项措辞**

「`PROGRESS.md` 随任务推进追加」→「`PROGRESS.md` 为任务计划清单：大任务拆小任务复选框，随推进逐项打勾（[x]）」

- [ ] **Step 4: 回归 + Commit**

Run: `npx vitest run tests/agents/experts.test.ts`（PROGRESS_HEADER 相关 closer 用例）
Expected: PASS（无断言绑定旧文案）

```bash
git add src/lib/agents/roles/closer.ts docs/DESIGN.md docs/DEMO-SCRIPT.md
git commit -m "docs: describe PROGRESS checklist contract in header, DESIGN and demo script"
```

---

### Task 5: 全量验证与收尾

**Files:**
- 无新改动（验证任务；如验证暴露问题，修复后重跑）

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 可宣称「完成」的验证证据

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
Expected: 全 PASS（0 fail）

- [ ] **Step 2: 构建**

Run: `npm run build`
Expected: 成功退出（exit 0）

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 无新增报错

- [ ] **Step 4: mock 全链路抽查（CLAUDE.md 验证 ② 的等价证据）**

Run: `npx vitest run tests/agents/orchestrator.test.ts tests/e2e/mock-chain.test.ts`
Expected: PASS——覆盖 建项目→流式→文件树→收尾 全链路与 PROGRESS 生成；异常路径（停止/单文件失败/干预/软锁）由 ②③④ 及 colab 用例覆盖

- [ ] **Step 5: 人工核对生成形态（读测试产物即可）**

在 orchestrator 测试临时加一次性断言或用 vitest 打印：确认 PROGRESS 内容匹配「目标文档形态」小节（计划节 + 缩进子任务 + `[x]` 打勾 + 收尾段在后）。核对后移除临时代码。

- [ ] **Step 6: 最终提交（如有修补）并汇总**

```bash
git status   # 确认无遗漏文件
git log --oneline -5
```

## Self-Review 结论

- **Spec 覆盖**：「拆解成小任务」→ 子任务复选框（Task 1/3）；「逐个完成后打勾」→ markTaskLine/markFileLine 原地打勾（Task 2/3）；「确认开始后续步骤」→ 串行 DAG 前置 settle 才派发 + 计划节顺序呈现（架构保证，Task 4 文档化）✓
- **占位符扫描**：无 TBD/TODO；全部代码块可直接落地（appendProgressBlock 无收尾段分支在 Task 1 Step 3 注明定稿时与现有 appendProgressLine 同构简化）✓
- **类型一致性**：`RoundPlanRef` 各任务签名一致；`TaskContext.plan` 字段 Task 2 定义、Task 3 消费；行构造器名称与现有导出一致（仅输出变化）✓
