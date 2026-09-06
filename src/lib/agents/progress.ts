/**
 * PROGRESS.md 任务计划清单维护（Task 15 起，2026-09-06 验收反馈改为清单形态）。
 *
 * 形态契约（DESIGN §3.3「标记进度=编排器」）：
 * - 每轮生成写入一节「## 任务计划（时间戳）」：每个任务一行复选框（`- [ ] taskKey（角色）：…`）；
 * - 大任务拆小任务：子任务复选框（`  - [ ] path`）插在任务行下方，来源是**确定性交付物**
 *   （PM/专家固定路径、架构师 ARCHITECT_DOC_PATHS、工程师 file_tree）——不靠 LLM 报数；
 * - 边界处原地打勾：任务/子任务完成 `[ ]`→`[x]`（失败保持 `[ ]` 加 ❌ 注记，挂起 ⏸）；
 *   「完成确认后才开始后续」由串行 DAG 保证（前置 settle 才派发下一个），打勾是该确认的留痕；
 * - 匹配失败（人工改坏格式）降级为追加注记行——记录不丢、不崩；
 * - 注记行（⚠/⏸/❌ 轮级事件）仍走 appendProgressLine，插在收尾段之前；
 * - 收尾段（CLOSING_SECTION_HEADING 起）由 closer 整段覆盖到文末——一切插入与改写
 *   必须发生在该标题**之前**（越界会让重跑收尾吞掉历史进度）。
 *
 * 服务端专用（写 files 表），不得进入客户端 bundle。
 */
import { CLOSING_SECTION_HEADING, PROGRESS_HEADER, PROGRESS_PATH } from '@/lib/agents/roles/closer';
import { roleRegistry } from '@/lib/agents/registry';
import type { AgentRole } from '@/lib/db/provider/types';
import type { StorageProvider } from '@/lib/db/provider/types';

/** 单行摘要截断（进度行可读即可，全文在 agent_runs.summary / 事件里） */
const SNIPPET_MAX = 120;

/** 摘要片段：压成单行并截断 */
function snippet(text: string, max = SNIPPET_MAX): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max)}…`;
}

/** 正则元字符转义（taskKey/path 都是自由文本，拼进匹配模式前必须转义） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 节标题时间戳（本地时区，分钟粒度） */
function roundStamp(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** 本轮任务计划的作用域锚点：编排器轮内持有，子任务登记与打勾都限定在本节内 */
export interface RoundPlanRef {
  /** 节标题整行（含时间戳；同分钟重跑追加 #N 序号保证全文唯一） */
  heading: string;
}

/** [start, end) 行区间：锚点标题行之后到收尾段标题（无收尾段则文末） */
function regionOf(lines: readonly string[], ref: RoundPlanRef): { start: number; end: number } {
  const headingIdx = lines.findIndex((item) => item === ref.heading);
  const closingIdx = lines.findIndex((item) => item.trim() === CLOSING_SECTION_HEADING);
  const end = closingIdx < 0 ? lines.length : closingIdx;
  return { start: headingIdx < 0 ? 0 : headingIdx + 1, end };
}

/** 区间内最后一个匹配行的下标（无匹配返回 -1）。从后往前找：同键多行时改最新一处 */
function lastMatchIn(lines: readonly string[], region: { start: number; end: number }, pattern: RegExp): number {
  for (let i = region.end - 1; i >= region.start; i -= 1) {
    if (pattern.test(lines[i] ?? '')) return i;
  }
  return -1;
}

/** 读-改-写一体写回（串行编排下无并发写；editor=leader 与 closer 一致） */
async function writeLines(storage: StorageProvider, projectId: number, lines: readonly string[]): Promise<void> {
  await storage.upsertFile({ projectId, path: PROGRESS_PATH, content: lines.join('\n'), editor: 'leader' });
}

/**
 * 在收尾段之前插入一个多行块（文件缺失则带头部创建）。
 * 插入纪律与旧版追加行完全一致：无收尾段追加文末；有收尾段插到段标题之前（保留空行分隔）。
 */
async function appendProgressBlock(storage: StorageProvider, projectId: number, block: string): Promise<void> {
  const existing = await storage.getFile(projectId, PROGRESS_PATH);
  if (existing === null) {
    await storage.upsertFile({ projectId, path: PROGRESS_PATH, content: `${PROGRESS_HEADER}\n\n${block}\n`, editor: 'leader' });
    return;
  }

  const lines = existing.content.split('\n');
  const headingIndex = lines.findIndex((item) => item.trim() === CLOSING_SECTION_HEADING);
  if (headingIndex < 0) {
    // 尚无收尾段：直接追加在文末
    const prefix = existing.content.trimEnd();
    const content = prefix === '' ? `${block}\n` : `${prefix}\n${block}\n`;
    await storage.upsertFile({ projectId, path: PROGRESS_PATH, content, editor: 'leader' });
    return;
  }

  // 有收尾段：插到段标题之前，保持标题前空行分隔
  const prefix = lines.slice(0, headingIndex).join('\n').trimEnd();
  const suffix = lines.slice(headingIndex).join('\n');
  const content = prefix === '' ? `${block}\n\n${suffix}\n` : `${prefix}\n${block}\n\n${suffix}\n`;
  await storage.upsertFile({ projectId, path: PROGRESS_PATH, content, editor: 'leader' });
}

/**
 * 在收尾段之前插入一行注记（旧接口，行为不变）。
 * 串行编排下无并发写；editor=leader（进度文件归领导名下，与 closer 一致）。
 */
export async function appendProgressLine(storage: StorageProvider, projectId: number, line: string): Promise<void> {
  await appendProgressBlock(storage, projectId, line);
}

/**
 * 写入本轮任务计划节：每任务一行未勾选复选框（顺序即拓扑执行序）。
 * 同分钟重跑/测试快速连跑时标题追加 #N 序号——锚点行必须全文唯一，打勾才不会跨轮误改。
 */
export async function startRoundPlan(
  storage: StorageProvider,
  projectId: number,
  tasks: ReadonlyArray<{ taskKey: string; agent: AgentRole; instruction: string }>,
): Promise<RoundPlanRef> {
  const base = `## 任务计划（${roundStamp()}）`;
  const existing = await storage.getFile(projectId, PROGRESS_PATH);
  let heading = base;
  let seq = 2;
  while (existing !== null && existing.content.split('\n').some((line) => line === heading)) {
    heading = `${base} #${seq}`;
    seq += 1;
  }
  const planLines = tasks.map((task) => `- [ ] ${task.taskKey}（${roleRegistry[task.agent].name}）：${snippet(task.instruction, 60)}`);
  await appendProgressBlock(storage, projectId, [heading, '', ...planLines].join('\n'));
  return { heading };
}

/**
 * 登记子任务复选框（`  - [ ] path`）：插在任务行正下方。
 * 找不到任务行（人工删除等）时垫到节末尾——仍在收尾段之前，记录不丢。
 */
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
  const insertAt = taskIdx >= 0 ? taskIdx + 1 : region.end;
  lines.splice(insertAt, 0, ...paths.map((path) => `  - [ ] ${path}`));
  await writeLines(storage, projectId, lines);
}

/** 原地改写一行；返回是否命中（未命中由调用方降级为注记行） */
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

/** 任务复选框整行改写（打勾/状态注记）。匹配失败降级为追加注记行 */
export async function markTaskLine(
  storage: StorageProvider,
  projectId: number,
  ref: RoundPlanRef,
  taskKey: string,
  line: string,
): Promise<void> {
  const ok = await rewriteRegionLine(storage, projectId, ref, new RegExp(`^- \\[[ x]\\] ${escapeRegExp(taskKey)}（`), line);
  if (!ok) await appendProgressBlock(storage, projectId, line);
}

/** 子任务复选框整行改写（按路径定位）。匹配失败降级为追加注记行 */
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

/** 任务开始（🔄 进行中标记，保持未勾选） */
export function taskStartLine(agent: AgentRole, taskKey: string, instruction: string): string {
  return `- [ ] ${taskKey}（${roleRegistry[agent].name}）：${snippet(instruction, 60)} —— 🔄`;
}

/** 任务成功（[x] 打勾，摘要来自角色 run.summary） */
export function taskDoneLine(agent: AgentRole, taskKey: string, summary: string | null): string {
  return `- [x] ${taskKey}（${roleRegistry[agent].name}）：${snippet(summary ?? '完成')}`;
}

/** 任务失败（保持未勾选 + ❌ 注记：失败不算完成） */
export function taskFailedLine(agent: AgentRole, taskKey: string, error: string): string {
  return `- [ ] ${taskKey}（${roleRegistry[agent].name}）：❌ ${snippet(error)}`;
}

/** 任务跳过（⏸：前置失败，级联跳过） */
export function taskSkippedLine(agent: AgentRole, taskKey: string, failedDep: string): string {
  return `- [ ] ${taskKey}（${roleRegistry[agent].name}）：⏸ 前置任务 ${failedDep} 未成功，已跳过`;
}

/** 子任务登记（交付物路径） */
export function filePlanLine(path: string): string {
  return `  - [ ] ${path}`;
}

/** 工程师单文件成功（[x] 打勾带版本） */
export function fileDoneLine(path: string, version: number): string {
  return `  - [x] ${path}（v${version}）`;
}

/** 工程师单文件校验未过（保持未勾选 + ❌；文件保留落库待修复） */
export function fileFailedLine(path: string, errors: string[]): string {
  return `  - [ ] ${path}：❌ ${snippet(errors.join('；'))}`;
}

/** 工程师单文件挂起（⏸：人工软锁，等待裁决） */
export function filePausedLine(path: string): string {
  return `  - [ ] ${path}：⏸ 人工软锁生效，已挂起并请求裁决`;
}

/** 工程师单文件恢复（▶️：人工裁决「覆盖生成」，软锁已释放并重跑该单文件任务） */
export function fileResumedLine(path: string): string {
  return `  - [ ] ${path}：▶️ 人工选择覆盖生成，已释放软锁并重跑`;
}

/** 工程师单文件跳过（⏭：人工裁决「保留修改」，本轮不生成，run 标 rolled_back） */
export function fileSkippedLine(path: string): string {
  return `  - [ ] ${path}：⏭ 人工选择保留修改并跳过，本轮不生成`;
}
