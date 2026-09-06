/**
 * 确定性编排器（Task 15，DESIGN §3.3 串行 DAG / §3.5 干预与停止 / §3.10 检查点）。
 *
 * 双层架构（CLAUDE.md 规则 1）：LLM 只做决策（领导路由、角色产出、收尾汇报）；
 * 本模块是纯确定性执行——拓扑排序、检查点、干预注入、软锁检查、SSE 事件、PROGRESS 行。
 *
 * 执行模型（V1 纯串行）：同项目互斥队列（Map<id,Promise>）；任务按拓扑序逐个执行，
 * 无并发写路径。任务失败只中断「依赖它的任务」，其余照常（工程师单文件失败继续下一文件）。
 *
 * 停止：stopProject 同步 abort 项目级 AbortController（含排队中的轮次）→ 各角色
 * runAgent 抛 AbortError → 顶层 catch 统一收口（stopped 事件 + status=paused）。
 * 异常兜底：任何未预期抛错 → error 事件 + status=failed，绝不悬在 running。
 *
 * 服务端专用（读 env 的角色在下游），不得进入客户端 bundle。
 */
import { projectEventBus, type StreamEvent } from '@/lib/agents/events';
import { roleRegistry } from '@/lib/agents/registry';
import {
  appendProgressLine,
  fileDoneLine,
  fileFailedLine,
  filePausedLine,
  fileResumedLine,
  fileSkippedLine,
  taskDoneLine,
  taskFailedLine,
  taskSkippedLine,
  taskStartLine,
} from '@/lib/agents/progress';
import { isAbortError } from '@/lib/agents/roles/run-support';
import { normalizePreferences } from '@/lib/settings/types';
import { routeLeader, type TaskAssignment } from '@/lib/agents/roles/leader';
import { PRD_PATH, runPm } from '@/lib/agents/roles/pm';
import { FILE_TREE_PATH, parseFileTree, runArchitect } from '@/lib/agents/roles/architect';
import { buildFastFileTree, runEngineerFile, runEngineerReview, type FileTree } from '@/lib/agents/roles/engineer';
import { EXPERT_REPORT_PATHS, runExpert, type ExpertRole } from '@/lib/agents/roles/experts';
import { runCloser, type CloserRoundOutcome } from '@/lib/agents/roles/closer';
import { AgentAbortError } from '@/lib/agents/types';
import type { AgentRole, Message, MessageMeta, Project, StorageProvider } from '@/lib/db/provider/types';

/** startGeneration 入参（brief 契约） */
export interface StartGenerationInput {
  storage: StorageProvider;
  projectId: number;
  userMessage: string;
  mode: 'fast' | 'full';
  /** @ 指定成员（非空则领导直派，DESIGN §3.1） */
  mentions: AgentRole[];
  /** 外部停止信号（HTTP 断开等）；与 stopProject 共同作用于同一 AbortController */
  signal: AbortSignal;
}

/** 单个任务的派发结果（角色自建 agent_runs；编排器只做任务级簿记） */
interface TaskDispatchResult {
  runId: number | null;
  /** 展示用摘要（agent_runs.summary 口径；工程师为聚合摘要） */
  summary: string;
  files: string[];
}

/** 一轮生成的跨任务状态（架构师树 / 本轮上游产物） */
interface RoundState {
  /** 本轮 PM/架构师/专家已产出文件（工程师不重复实现上游交付物） */
  producedThisRound: Set<string>;
  /** 本轮架构师文件树（含空数组 = 架构师跑了但树空，走降级） */
  tree: FileTree | null;
  architectRan: boolean;
}

/** 单任务派发上下文（串行执行，字段只读） */
interface TaskContext {
  storage: StorageProvider;
  projectId: number;
  project: Project;
  mode: 'fast' | 'full';
  userMessage: string;
  signal: AbortSignal;
  task: TaskAssignment;
  interventions: Message[];
  emit: (e: Omit<StreamEvent, 'seq' | 'projectId'>) => StreamEvent;
}

/* ------------------------------------------------------------------ */
/* 项目级注册表：互斥队列 + AbortController                              */
/* ------------------------------------------------------------------ */

/** 每 project 一个 AbortController（同项目排队中的多轮共用；停止=全部取消） */
const activeControllers = new Map<number, AbortController>();
/** 每 project 排队/执行中的轮数（归零时清理 controller 与队列） */
const pendingJobs = new Map<number, number>();
/** 每 project 互斥队列尾（串行化的全部秘密：上一轮 settle 后才开下一轮） */
const queues = new Map<number, Promise<unknown>>();

function controllerFor(projectId: number): AbortController {
  let controller = activeControllers.get(projectId);
  if (controller === undefined) {
    controller = new AbortController();
    activeControllers.set(projectId, controller);
  }
  return controller;
}

function incrementPending(projectId: number): void {
  pendingJobs.set(projectId, (pendingJobs.get(projectId) ?? 0) + 1);
}

function decrementPending(projectId: number): void {
  const remaining = (pendingJobs.get(projectId) ?? 0) - 1;
  if (remaining <= 0) {
    pendingJobs.delete(projectId);
    activeControllers.delete(projectId);
    queues.delete(projectId);
  } else {
    pendingJobs.set(projectId, remaining);
  }
}

/** 入队并返回本轮的完成 Promise（队列尾吞掉异常，避免某轮失败卡死后续轮次） */
function enqueue(projectId: number, job: () => Promise<void>): Promise<void> {
  const previous = queues.get(projectId) ?? Promise.resolve();
  const next = previous.then(job, job);
  queues.set(
    projectId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                             */
/* ------------------------------------------------------------------ */

/** 编排器状态：running=该项目有在执行或排队的生成轮 */
export function orchestratorStatus(projectId: number): 'idle' | 'running' {
  return activeControllers.has(projectId) ? 'running' : 'idle';
}

/** 启动一轮生成：入项目互斥队列（并发调用同项目自动串行化），完成时 resolve */
export async function startGeneration(input: StartGenerationInput): Promise<void> {
  const projectController = controllerFor(input.projectId);
  incrementPending(input.projectId);
  const job = (): Promise<void> =>
    executeRound(input, projectController).finally(() => {
      decrementPending(input.projectId);
    });
  await enqueue(input.projectId, job);
}

/** 单轮控制器：外部信号（HTTP 断开）或项目级停止任一触发即中止 */
interface RoundController {
  signal: AbortSignal;
  /** 解绑两侧监听（轮次结束时调用，防监听泄漏） */
  dispose: () => void;
}

/**
 * 每轮一个子控制器（作用域修复）：外部 input.signal 只中止**本轮**——
 * 排队轮的请求断开不能越界打断在跑轮；stopProject 只中止项目级控制器，
 * 在跑轮与排队轮（开跑时检测已中止）都会停，但互不牵连。
 */
function createRoundController(external: AbortSignal, projectController: AbortController): RoundController {
  const round = new AbortController();
  const forward = (): void => round.abort();
  external.addEventListener('abort', forward, { once: true });
  projectController.signal.addEventListener('abort', forward, { once: true });
  if (external.aborted || projectController.signal.aborted) round.abort();
  return {
    signal: round.signal,
    dispose: () => {
      external.removeEventListener('abort', forward);
      projectController.signal.removeEventListener('abort', forward);
    },
  };
}

/** 一轮的执行包装：建子控制器 → 跑主流程 → 无论成败解绑监听 */
async function executeRound(input: StartGenerationInput, projectController: AbortController): Promise<void> {
  const round = createRoundController(input.signal, projectController);
  try {
    await executeGeneration(input, round.signal);
  } finally {
    round.dispose();
  }
}

/**
 * 停止项目：同步 abort 项目级 controller（立即生效，抢在下一个 provider 调用前）。
 * 停止语义的收口（stopped 事件 + status=paused）由运行中轮次的 catch 统一负责；
 * 无在跑轮次时为幂等 no-op。storage 形参保留 brief 签名，供调用方语义对齐。
 */
export async function stopProject(storage: StorageProvider, projectId: number): Promise<void> {
  void storage;
  activeControllers.get(projectId)?.abort();
}

/* ------------------------------------------------------------------ */
/* 拓扑排序（含断环防御，T11 carry）                                     */
/* ------------------------------------------------------------------ */

export interface TopoWarning {
  taskKey: string;
  message: string;
}

export interface TopoResult {
  /** 拓扑执行序（确定性：同层级按注册顺序） */
  order: string[];
  warnings: TopoWarning[];
}

/**
 * 拓扑排序：每轮取「依赖已全部 settle」的注册序最前任务。无可取任务 = 有环
 * （跨轮前向引用可构成 a→b→a）——按注册序取第一个未 settle 任务，丢弃其未满足
 * 依赖（断环）并记警告，保证必然终止、绝不死锁。悬空依赖（未知 task_key）视为已满足。
 */
export function topoSortTasks(tasks: TaskAssignment[]): TopoResult {
  const unique: TaskAssignment[] = [];
  const known = new Set<string>();
  for (const task of tasks) {
    if (known.has(task.taskKey)) continue; // 防御去重（领导已在收集侧拒绝重复）
    known.add(task.taskKey);
    unique.push(task);
  }

  const settled = new Set<string>();
  const order: string[] = [];
  const warnings: TopoWarning[] = [];

  while (order.length < unique.length) {
    const ready = unique.find(
      (task) => !settled.has(task.taskKey) && task.dependsOn.every((dep) => settled.has(dep) || !known.has(dep)),
    );
    if (ready !== undefined) {
      order.push(ready.taskKey);
      settled.add(ready.taskKey);
      continue;
    }
    const stuck = unique.find((task) => !settled.has(task.taskKey));
    if (stuck === undefined) break; // 不可达（while 条件保证存在未 settle 任务）
    const dropped = stuck.dependsOn.filter((dep) => !settled.has(dep) && known.has(dep));
    const message = `任务 ${stuck.taskKey} 的依赖 ${dropped.join('、')} 构成环，已断开环边并按注册顺序执行`;
    console.warn(`[orchestrator] ${message}`);
    warnings.push({ taskKey: stuck.taskKey, message });
    order.push(stuck.taskKey); // 断环后强制放行
    settled.add(stuck.taskKey);
  }
  return { order, warnings };
}

/* ------------------------------------------------------------------ */
/* 内部小工具                                                           */
/* ------------------------------------------------------------------ */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 取某条 agent_run 的 summary（agent_runs 是子任务间唯一交接物，规则 7） */
async function runSummaryOf(storage: StorageProvider, projectId: number, runId: number): Promise<string | null> {
  const runs = await storage.listAgentRuns(projectId);
  return runs.find((run) => run.id === runId)?.summary ?? null;
}

/** 各角色最近一次 done 的 summary（工程师交接摘要来源；规则 7 零历史共享） */
async function latestSummaries(storage: StorageProvider, projectId: number, agents: readonly AgentRole[]): Promise<string> {
  const runs = await storage.listAgentRuns(projectId);
  const parts: string[] = [];
  for (const agent of agents) {
    const found = [...runs].reverse().find((run) => run.agent === agent && run.status === 'done' && run.summary !== null);
    if (found?.summary != null) parts.push(found.summary);
  }
  return parts.join('\n');
}

/** 干预指令拼接块（角色无 interventions 参数 → 编排器拼进任务文本，T14 注） */
function interventionBlock(interventions: readonly Message[]): string {
  if (interventions.length === 0) return '';
  const lines = interventions.map((item) => `- ${item.content}`).join('\n');
  return `\n\n【用户追加指令（运行中干预，优先级高于原任务）】\n${lines}`;
}

function appendInterventions(base: string, interventions: readonly Message[]): string {
  return `${base}${interventionBlock(interventions)}`;
}

/** 文件级任务键（`engineer:{path}`）折算出的展示路径；任务级键（如 pm-prd）无 path */
function injectedPathOf(targetTaskKey: string): string | undefined {
  const prefix = 'engineer:';
  return targetTaskKey.startsWith(prefix) ? targetTaskKey.slice(prefix.length) || undefined : undefined;
}

/** 打戳落库的 meta：原 meta（mentions）+ 注入边界（targetTask）+ 文件级注入的展示 path（T25） */
function injectedMetaOf(item: Message, targetTaskKey: string): MessageMeta {
  const path = injectedPathOf(targetTaskKey);
  return { ...item.meta, targetTask: targetTaskKey, ...(path === undefined ? {} : { path }) };
}

/**
 * 思考流接线（T31）：角色 LLM 调用的 reasoning 增量 → SSE reasoning 事件。
 * runId 恒为 null（与该角色同处的 agent_start/file_start/delta 一致——run 行由角色层自建，
 * 编排器派发时还拿不到 id）；reasoning 事件是 ephemeral（不进环形缓冲，见 events.ts 协议备注）。
 */
function reasoningEmitOf(
  emit: (e: Omit<StreamEvent, 'seq' | 'projectId'>) => StreamEvent,
  agent: AgentRole,
): (text: string) => void {
  return (text) => emit({ runId: null, event: 'reasoning', agent, content: text });
}

/**
 * 步骤边界取走待注入干预（DESIGN §3.5 两级边界共用的确定性通道）：
 * 先事件留痕再打戳（带项目作用域，CLAUDE.md 规则 9）；空列表不打戳不发作。
 * 任务边界（必检级）与工程师文件边界（每文件完成间）都走这里。
 * 打戳同时把 targetTask 写回消息 meta（T25）：前端刷新后从快照读 meta 仍能还原
 * 「已注入 {文件}」，不再降级成无边界信息的「已注入下一步骤」。
 */
async function takeInterventions(
  storage: StorageProvider,
  projectId: number,
  targetTaskKey: string,
  emit: (e: Omit<StreamEvent, 'seq' | 'projectId'>) => StreamEvent,
): Promise<Message[]> {
  const items = await storage.takePendingInterventions(projectId);
  if (items.length === 0) return [];
  for (const item of items) {
    emit({
      runId: null,
      event: 'intervention_injected',
      content: item.content,
      meta: { messageId: item.id, targetTask: targetTaskKey },
    });
    // 逐条打戳（每条 meta 各自带原 mentions，合并而非覆盖）
    await storage.markDelivered([item.id], projectId, injectedMetaOf(item, targetTaskKey));
  }
  return items;
}

/* ------------------------------------------------------------------ */
/* 软锁裁决（DESIGN §3.9 预防层：文件任务挂起 + 聊天区请求裁决）            */
/* ------------------------------------------------------------------ */

/** 用户对软锁裁决的三选一：覆盖生成 / 跳过保留修改 / 稍后再说 */
type SoftLockRuling = 'override' | 'skip' | 'later';

/** 裁决等待轮询间隔默认值（ms）——裁决靠用户回复驱动，轮询只负责察觉 */
const DEFAULT_SOFT_LOCK_POLL_MS = 250;

/** 轮询间隔（env 可调；测试置小值加速，默认值即生产语义） */
function softLockPollMs(): number {
  const raw = process.env['SOFT_LOCK_POLL_MS'];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SOFT_LOCK_POLL_MS;
}

/** 可中止睡眠：停止信号一到立即返回（循环内再查 aborted 走停止语义） */
function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 干预回复 → 裁决选项；匹配不到返回 null（普通运行中指令不由裁决消费，留给下一个文件边界注入） */
function rulingOf(content: string): SoftLockRuling | null {
  if (content.includes('覆盖')) return 'override';
  if (content.includes('跳过') || content.includes('保留')) return 'skip';
  if (content.includes('稍后') || content.includes('继续')) return 'later';
  return null;
}

/**
 * 编辑能力开关（session 级偏好，DESIGN §3.9）：关 = 纯只读查看器，agent 永不遇软锁。
 * 缺失/脏数据回默认值「开」（normalize 集中收窄，与设置页同一口径）。
 */
async function editingEnabledFor(c: TaskContext): Promise<boolean> {
  return normalizePreferences(await c.storage.getPreference('session', c.project.sessionId)).editing_enabled;
}

/**
 * 挂起等待裁决：轮询干预队列（用户回复=三选一）与软锁状态。
 * - 用户回复三选一 → 消费该条干预：发 intervention_injected 事件（队列卡实时翻转为已消费，
 *   T25——此前该路径只打戳不发事件，聊天区卡片要等刷新才变）+ 打戳带项目作用域与 targetTask
 * - 软锁消失（人退出编辑 / TTL 到期）→ 按「稍后」处理：不代用户做「覆盖」决定，
 *   人工未保存的本地改动仍以库中最新版为准，本轮先跳过
 * - 停止信号 → 抛 AgentAbortError（顶层统一收口 stopped/paused）
 */
async function awaitSoftLockRuling(c: TaskContext, path: string): Promise<SoftLockRuling> {
  const targetTask = `engineer:${path}`;
  while (!c.signal.aborted) {
    const pending = await c.storage.takePendingInterventions(c.projectId);
    const hit = pending.find((item) => rulingOf(item.content) !== null);
    if (hit !== undefined) {
      const ruling = rulingOf(hit.content);
      if (ruling === null) break; // 不可达（find 谓词已收窄）
      c.emit({
        runId: null,
        event: 'intervention_injected',
        content: hit.content,
        meta: { messageId: hit.id, targetTask, ruling },
      });
      await c.storage.markDelivered([hit.id], c.projectId, injectedMetaOf(hit, targetTask));
      return ruling;
    }
    const stillLocked = (await c.storage.getSoftLockedFiles(c.projectId)).some((row) => row.path === path);
    if (!stillLocked) return 'later';
    await abortableSleep(c.signal, softLockPollMs());
  }
  throw new AgentAbortError(`生成在等待 ${path} 的软锁裁决期间被停止`);
}

/**
 * 软锁裁决入口：发裁决消息（落库 assistant 行 → SSE 回带 messageId，刷新后卡片仍在）
 * → 挂起等待裁决。返回该文件本轮是否照常生成（仅「覆盖」为 true）。
 */
async function negotiateSoftLock(c: TaskContext, path: string): Promise<boolean> {
  const { storage, projectId } = c;
  const question = await storage.addMessage({
    projectId,
    role: 'assistant',
    content: `检测到你正在编辑 ${path}：保留你的修改并跳过 / 覆盖生成 / 完成编辑后继续`,
    meta: { kind: 'softlock', path },
  });
  c.emit({
    runId: null,
    event: 'message',
    agent: 'leader',
    path,
    content: question.content,
    meta: { role: 'assistant', kind: 'softlock', path, messageId: question.id },
  });
  await appendProgressLine(storage, projectId, filePausedLine(path));

  const ruling = await awaitSoftLockRuling(c, path);
  if (ruling === 'later') return false; // 不动：文件任务保持挂起状态收场
  if (ruling === 'skip') {
    // 「跳过」也留时间线痕迹：该单文件任务落一条 rolled_back run（DESIGN §3.10 口径）
    const run = await storage.createAgentRun({
      projectId,
      taskKey: `engineer:${path}`,
      agent: 'engineer',
      task: `实现 ${path}（人工软锁，等待裁决）`,
    });
    await storage.updateAgentRun(
      run.id,
      {
        status: 'rolled_back',
        startedAt: Date.now(),
        endedAt: Date.now(),
        summary: `人工裁决跳过：保留人工修改，本轮未生成 ${path}`,
      },
      projectId,
    );
    await appendProgressLine(storage, projectId, fileSkippedLine(path));
    return false;
  }

  // 「覆盖」：释放软锁后重跑该单文件任务（D1：单文件重试=重跑该单文件任务）。
  // 释放是裁决的一部分——用户已选择放弃未保存修改，锁留着只会让下一文件边界再问一遍。
  const row = await storage.getFile(projectId, path);
  if (row !== null) await storage.setSoftLock(projectId, row.id, false);
  await appendProgressLine(storage, projectId, fileResumedLine(path));
  return true;
}

/** PM 的需求文本：项目需求为底，本轮消息不同则补充（PM 不走 assembleContext，需求需显式传） */
function pmRequirementText(project: Project, userMessage: string): string {
  const base = project.requirement.trim() === '' ? userMessage.trim() : project.requirement.trim();
  return base === userMessage.trim() ? base : `${base}\n（本轮补充：${userMessage.trim()}）`;
}

/**
 * 领导聊天消息统一出口：先落库拿行 id，再发 message 事件回带 meta.messageId
 * （T17 前端按正数 messageId 去重——快照与 Last-Event-ID 重放叠加时不会出现重复气泡）。
 * extraMeta 携带卡片语义（softlock 裁决 / restore 通知），一并落库让刷新后的聊天区可还原。
 */
async function emitLeaderMessage(
  storage: StorageProvider,
  projectId: number,
  emit: (e: Omit<StreamEvent, 'seq' | 'projectId'>) => StreamEvent,
  content: string,
  extraMeta?: MessageMeta,
): Promise<void> {
  const row = await storage.addMessage({ projectId, role: 'assistant', content, meta: extraMeta });
  emit({
    runId: null,
    event: 'message',
    agent: 'leader',
    content,
    meta: { role: 'assistant', messageId: row.id, ...extraMeta },
  });
}

/* ------------------------------------------------------------------ */
/* @直派成员的自身名义汇报（T32 b 方案）                                  */
/* ------------------------------------------------------------------ */

/**
 * @直派任务键前缀（leader.ts 直派分支的 `user-${agent}-${index}`）。
 * 这是「用户 @ 点名的任务」的确定性标记——领导自拟的 task_key 不用该前缀（本项目的分派约定）。
 */
const USER_DISPATCH_PREFIX = 'user-';

/** 各角色承接任务的名词（汇报首句用）。@直派不会派 leader，补全键只为类型完备 */
const AGENT_TASK_NOUN: Record<AgentRole, string> = {
  leader: '任务',
  pm: 'PRD 撰写',
  architect: '架构设计',
  engineer: '代码实现',
  analyst: '数据分析',
  seo: 'SEO 分析',
  ads: '广告投放方案',
};

/** 汇报正文里摘要要点的截断上限（字符）：交接摘要可能多行长句，聊天区只取一句 */
const AGENT_REPORT_SUMMARY_CAP = 100;

/** run.summary → 要点一句（取首个非空行，超长截断）；无可用摘要返回空串 */
function reportSummaryClause(summary: string): string {
  const firstLine = summary
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return '';
  const clipped =
    firstLine.length > AGENT_REPORT_SUMMARY_CAP ? `${firstLine.slice(0, AGENT_REPORT_SUMMARY_CAP)}…` : firstLine;
  return `要点：${clipped}`;
}

/**
 * @直派任务完成 → 承接成员以**自身名义**落一条 assistant 消息并 emit（T32 用户拍板的 b 方案）。
 * 背景：@ PM 出 PRD 时产出走文件（docs/prd.md），聊天里此前只有领导收尾汇报，观感是
 * 「@ 了 PM、出来讲话的却是领导」——这里补一条该成员的完成通报，让 @ 谁谁出声。
 * 领导收尾汇报保留不动（它承担多任务轮的聚合视角）。
 *
 * 主产出路径取值：**只认该 run 实际写的首个文件**（任务结果带回的是落库真路径，如 PM 的
 * docs/prd.md、专家的 docs/seo_report.md、架构师的首个产物）。任务结果不带文件清单时
 * **省略路径子句**、不退回 writesPaths 前缀（T32 R1 评审）：@工程师直派的 writesPaths 是
 * ['docs/','app/']，而工程师明确跳过 docs/ 只写 app/*，退回前缀会说出「产物已写入 docs/」
 * 这种事实错误；且多文件交付本就没有单一「主产出」可指。
 */
async function emitAgentReport(
  storage: StorageProvider,
  projectId: number,
  emit: (e: Omit<StreamEvent, 'seq' | 'projectId'>) => StreamEvent,
  task: TaskAssignment,
  result: TaskDispatchResult,
): Promise<void> {
  const primaryPath = result.files[0];
  const pathClause = primaryPath === undefined ? '' : `产物已写入 ${primaryPath}。`;
  const content = `✅ ${roleRegistry[task.agent].name}：${AGENT_TASK_NOUN[task.agent]}已完成。${pathClause}${reportSummaryClause(result.summary)}`;
  // meta 随消息落库：刷新后徽章（agent）与产物路径（path）仍可还原（kind 区别于领导收尾卡）
  const meta: MessageMeta = {
    kind: 'agent-report',
    agent: task.agent,
    ...(primaryPath === undefined ? {} : { path: primaryPath }),
  };
  const row = await storage.addMessage({ projectId, role: 'assistant', content, meta });
  emit({
    runId: result.runId,
    event: 'message',
    agent: task.agent,
    content,
    meta: { role: 'assistant', messageId: row.id, ...meta },
  });
}

/** 错误信息首句（聊天区失败通报用）：取首个非空行，按句读截到第一句，超长再截断 */
function errorFirstSentence(message: string): string {
  const firstLine = message
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return '原因未知';
  const sentenceEnd = /[。；;！!？?]/.exec(firstLine);
  const sentence = sentenceEnd === null ? firstLine : firstLine.slice(0, sentenceEnd.index + 1);
  return sentence.length > AGENT_REPORT_SUMMARY_CAP ? `${sentence.slice(0, AGENT_REPORT_SUMMARY_CAP)}…` : sentence;
}

/**
 * @直派任务失败 → 承接成员以**自身名义**落一条失败通报并 emit（T33 B2，emitAgentReport 的失败变体）。
 * 背景（实证缺陷链）：前置失败（如工程师无树抛错）发生在角色自建 run 行之前，任务级 catch
 * 只发 error 事件——直播块闪一下即被收尾清场，时间线无 run 行、聊天区无任何失败痕迹，
 * 用户全程看不到失败。这条 ❌ 是失败的第一现场；meta.status=failed 供前端红色调呈现。
 */
async function emitAgentFailureReport(
  storage: StorageProvider,
  projectId: number,
  emit: (e: Omit<StreamEvent, 'seq' | 'projectId'>) => StreamEvent,
  task: TaskAssignment,
  message: string,
  runId: number | null,
): Promise<void> {
  const content = `❌ ${roleRegistry[task.agent].name}：${AGENT_TASK_NOUN[task.agent]}未完成——${errorFirstSentence(message)}`;
  const meta: MessageMeta = { kind: 'agent-report', agent: task.agent, status: 'failed' };
  let row: Message;
  try {
    row = await storage.addMessage({ projectId, role: 'assistant', content, meta });
  } catch (error) {
    // 取舍（T34）：失败通报是任务级失败的**可见化增强**，不是关键路径。此处运行在任务级 catch
    // 内部，落库失败若再向上抛，会被顶层 catch 收成「整轮 failed」——单任务失败被升级成整轮失败。
    // 所以只 console.error 留痕（不静默吞），整轮照常收口；直播侧的失败可见性已由任务级
    // error 事件兜住，也不再补发无 messageId 的 message 事件（前端按正数 id 去重，
    // 缺 id 的消息在断线重放时会重复渲染）。
    console.error(`[orchestrator] 失败通报落库失败（projectId=${projectId}，taskKey=${task.taskKey}）：`, error);
    return;
  }
  emit({
    runId,
    event: 'message',
    agent: task.agent,
    content,
    meta: { role: 'assistant', messageId: row.id, ...meta },
  });
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

/**
 * 任务前基线打点（DESIGN §3.10）。检查点在任务开跑**前**打——此刻该任务的 run 行
 * 尚不存在，因此用 afterRunId=当前最大 run id 捕获回滚边界：restore 后
 * id > afterRunId 的任务（= 打点之后发生的全部工作）标 rolled_back。
 * 返回该基线（T33 B）：任务失败时据此判断「角色是否来得及自建 run 行」。
 */
async function checkpointBefore(storage: StorageProvider, projectId: number, label: string): Promise<number> {
  const afterRunId = await storage.latestRunId(projectId);
  await storage.createCheckpoint(projectId, label, null, afterRunId);
  return afterRunId;
}

async function executeGeneration(input: StartGenerationInput, signal: AbortSignal): Promise<void> {
  const { storage, projectId } = input;
  const emit = (e: Omit<StreamEvent, 'seq' | 'projectId'>): StreamEvent => projectEventBus.emit(projectId, e);
  const note = (line: string): Promise<void> => appendProgressLine(storage, projectId, line);

  const project = await storage.getProject(projectId);
  if (project === null) throw new Error(`项目不存在：projectId=${projectId}，无法启动生成`);

  try {
    await storage.updateProjectStatus(projectId, 'running');
    const userMessage = await storage.addMessage({
      projectId,
      role: 'user',
      content: input.userMessage,
      meta: { mentions: input.mentions },
    });
    emit({ runId: null, event: 'message', content: input.userMessage, meta: { role: 'user', messageId: userMessage.id } });
    if (signal.aborted) throw new AgentAbortError('生成在排队期间已被停止');

    // 领导路由（LLM 决策）：@ 直派 / 意图分派；失败回退默认流水线（三段式在 leader 内）
    const fileRows = await storage.listFiles(projectId);
    const decision = await routeLeader({
      storage,
      projectId,
      userMessage: input.userMessage,
      mode: input.mode,
      mentions: input.mentions,
      hasFiles: fileRows.length > 0,
      signal,
      onReasoning: reasoningEmitOf(emit, 'leader'),
    });

    // 咨询问答：不派任务、不跑收尾，直接回答并收口
    if (decision.kind === 'reply') {
      await emitLeaderMessage(storage, projectId, emit, decision.reply);
      await storage.updateProjectStatus(projectId, 'done');
      emit({ runId: null, event: 'done' });
      return;
    }
    if (decision.reply !== undefined) {
      await emitLeaderMessage(storage, projectId, emit, decision.reply);
    }

    const topo = topoSortTasks(decision.tasks);
    for (const warning of topo.warnings) await note(`- ⚠ ${warning.message}`);
    const taskByKey = new Map(decision.tasks.map((task) => [task.taskKey, task]));
    const taskOutcome = new Map<string, 'done' | 'failed' | 'skipped'>();
    /** 本轮失败任务的原因（taskKey → 错误信息；closer 反谎报上下文的数据源，T33 C） */
    const failedReasons = new Map<string, string>();
    const round: RoundState = { producedThisRound: new Set(), tree: null, architectRan: false };

    for (const taskKey of topo.order) {
      const task = taskByKey.get(taskKey);
      if (task === undefined) continue; // 不可达（order 的 key 全部来自 tasks）
      const c: TaskContext = {
        storage,
        projectId,
        project,
        mode: input.mode,
        userMessage: input.userMessage,
        signal,
        task,
        interventions: [],
        emit,
      };

      // 级联跳过：前置失败/被跳过的任务不再执行（失败只中断依赖它的任务）
      const failedDep = task.dependsOn.find((dep) => taskOutcome.get(dep) === 'failed' || taskOutcome.get(dep) === 'skipped');
      if (failedDep !== undefined) {
        taskOutcome.set(taskKey, 'skipped');
        await note(taskSkippedLine(task.agent, taskKey, failedDep));
        continue;
      }

      // 检查点：任务前基线（DESIGN §3.10；短事务在 repo 层保证）；基线同时是「run 行是否已建」的判据
      const runBaseline = await checkpointBefore(storage, projectId, `任务前:${taskKey}`);

      // 干预队列：任务边界取待注入消息（DESIGN §3.5 必检级）→ 事件 → 打戳 → 拼进任务文本
      c.interventions = await takeInterventions(storage, projectId, taskKey, emit);

      await note(taskStartLine(task.agent, taskKey, task.instruction));
      try {
        const result = await dispatchTask(c, round);
        taskOutcome.set(taskKey, 'done');

        // 断环警告入 run summary（T11 carry：可见可追溯，不静默吞）
        const warning = topo.warnings.find((item) => item.taskKey === taskKey);
        if (warning !== undefined && result.runId !== null) {
          const before = await runSummaryOf(storage, projectId, result.runId);
          await storage.updateAgentRun(
            result.runId,
            { summary: `${before ?? ''}\n⚠ ${warning.message}`.trim() },
            projectId,
          );
        }
        await note(taskDoneLine(task.agent, taskKey, result.summary));

        // @直派成员以自身名义汇报（T32 b 方案）：在任务级 agent_end（dispatchTask 内发出）之后
        // 补一条该成员的完成通报；非 @直派任务不发（领导收尾汇报负责聚合视角）
        if (taskKey.startsWith(USER_DISPATCH_PREFIX)) {
          await emitAgentReport(storage, projectId, emit, task, result);
        }
      } catch (error) {
        if (isAbortError(error)) throw error; // 停止语义交给顶层统一收口
        const message = errorMessage(error);
        taskOutcome.set(taskKey, 'failed');
        failedReasons.set(taskKey, message);

        // 前置失败也有 run 行（T33 B1）：角色抛错发生在自建 run 行之前时，agent_start 事件
        // 撑起的直播块会被收尾清场、时间线无 run 行——用户全程看不到失败。编排器补插一条
        // failed run（agent/task_key/error 摘要），时间线/快照/客户端失败收口全链路可见。
        let failedRunId: number | null = null;
        if ((await storage.latestRunId(projectId)) <= runBaseline) {
          const run = await storage.createAgentRun({
            projectId,
            taskKey,
            agent: task.agent,
            task: task.instruction,
          });
          await storage.updateAgentRun(
            run.id,
            { status: 'failed', startedAt: Date.now(), endedAt: Date.now(), error: message },
            projectId,
          );
          failedRunId = run.id;
        }
        emit({ runId: failedRunId, event: 'error', agent: task.agent, error: message, meta: { taskKey } });
        await note(taskFailedLine(task.agent, taskKey, message));
        // @直派任务失败也要出声（T33 B2）：失败通报是用户在聊天区看到失败的第一现场
        if (taskKey.startsWith(USER_DISPATCH_PREFIX)) {
          await emitAgentFailureReport(storage, projectId, emit, task, message, failedRunId);
        }
        // 失败不中断无依赖任务：继续下一个
      }
    }

    // 收尾：领导汇报（一次 LLM 调用）→ assistant message → done
    await checkpointBefore(storage, projectId, '任务前:leader-closing');

    // 收尾也是任务边界（T31 修复）：任务执行期间排队的干预在此兜底消费。
    // 单任务轮次（如 @直派 PM 出 PRD）之后不再有任何任务边界——缺这一步，干预将永久滞留
    // 队列（delivered_at 恒 null，用户侧永远「排队中」，真机 DB 实证）。T23 R1 的顺序约束
    // （先软锁裁决、后取干预）在此不受影响：收尾没有文件任务、没有软锁裁决可等待，
    // 取到的干预直接进领导收尾上下文（不重跑工程任务；要落地改动仍需用户再发一轮）。
    const closingInterventions = await takeInterventions(storage, projectId, 'leader-closing', emit);

    emit({ runId: null, event: 'agent_start', agent: 'leader', meta: { taskKey: 'leader-closing' } });
    // 本轮结果显式注入收尾上下文（T33 C 反谎报）：closer 只看文件清单时，读到 PROGRESS 的
    // ❌ 行仍会谎报「所有角色任务均执行完毕」——成败统计由编排器给权威口径，M>0 时 prompt
    // 侧要求如实汇报失败项
    const roundOutcome: CloserRoundOutcome = {
      succeeded: [...taskOutcome.values()].filter((status) => status === 'done').length,
      // 跳过=被失败级联波及的任务（T34）：单列口径，closer 侧与根因失败分开陈述
      skipped: [...taskOutcome.values()].filter((status) => status === 'skipped').length,
      failed: [...failedReasons].map(([taskKey, message]) => ({ taskKey, reason: errorFirstSentence(message) })),
    };
    const closer = await runCloser({
      storage,
      projectId,
      signal,
      onReasoning: reasoningEmitOf(emit, 'leader'),
      interventions: closingInterventions.map((item) => item.content),
      roundOutcome,
    });
    emit({ runId: closer.runId, event: 'agent_end', agent: 'leader', summary: (await runSummaryOf(storage, projectId, closer.runId)) ?? undefined });
    const assistant = await storage.addMessage({ projectId, role: 'assistant', content: closer.report });
    emit({ runId: closer.runId, event: 'message', agent: 'leader', content: closer.report, meta: { role: 'assistant', messageId: assistant.id } });
    await storage.updateProjectStatus(projectId, 'done');
    emit({ runId: closer.runId, event: 'done' });
  } catch (error) {
    // 顶层统一收口：停止 → stopped/paused；其余 → error/failed（绝不悬在 running）
    const message = errorMessage(error);
    if (isAbortError(error)) {
      emit({ runId: null, event: 'stopped' });
      await storage.updateProjectStatus(projectId, 'paused');
      await note(`- ⏸ 本轮生成已停止：${message}`);
    } else {
      console.error(`[orchestrator] 生成失败（projectId=${projectId}）：`, error);
      emit({ runId: null, event: 'error', error: message });
      await storage.updateProjectStatus(projectId, 'failed');
      await note(`- ❌ 本轮生成失败：${message}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 任务派发（按角色；角色自建 agent_runs，编排器只发事件 + PROGRESS）      */
/* ------------------------------------------------------------------ */

function dispatchTask(c: TaskContext, round: RoundState): Promise<TaskDispatchResult> {
  switch (c.task.agent) {
    case 'pm':
      return dispatchPm(c, round);
    case 'architect':
      return dispatchArchitect(c, round);
    case 'engineer':
      return dispatchEngineer(c, round);
    case 'analyst':
    case 'seo':
    case 'ads':
      return dispatchExpert(c, round);
    default:
      return Promise.reject(new Error(`不可派发的角色：${c.task.agent}`));
  }
}

/** PM：单文件交付（PRD_PATH 提前可知）→ file_start/live delta/file_end 全程打字机 */
async function dispatchPm(c: TaskContext, round: RoundState): Promise<TaskDispatchResult> {
  const { storage, projectId, task } = c;
  c.emit({ runId: null, event: 'agent_start', agent: 'pm', meta: { taskKey: task.taskKey } });
  const requirement = appendInterventions(pmRequirementText(c.project, c.userMessage), c.interventions);

  c.emit({ runId: null, event: 'file_start', agent: 'pm', path: PRD_PATH });
  const result = await runPm({
    storage,
    projectId,
    requirement,
    fast: c.mode === 'fast',
    signal: c.signal,
    onDelta: (text) => c.emit({ runId: null, event: 'delta', agent: 'pm', path: PRD_PATH, content: text }),
    onReasoning: reasoningEmitOf(c.emit, 'pm'),
  });
  const row = await storage.getFile(projectId, PRD_PATH);
  c.emit({ runId: result.runId, event: 'file_end', agent: 'pm', path: PRD_PATH, meta: { version: row?.version } });

  round.producedThisRound.add(PRD_PATH);
  const summary = await runSummaryOf(storage, projectId, result.runId);
  c.emit({ runId: result.runId, event: 'agent_end', agent: 'pm', summary: summary ?? undefined });
  return { runId: result.runId, summary: summary ?? '', files: result.files };
}

/** 架构师：8 段产物事后按清单补发 file_start/file_end（单发无逐段 delta，T14 现状） */
async function dispatchArchitect(c: TaskContext, round: RoundState): Promise<TaskDispatchResult> {
  const { storage, projectId, task } = c;
  c.emit({ runId: null, event: 'agent_start', agent: 'architect', meta: { taskKey: task.taskKey } });
  // 架构师无文本入参通道（T14 契约）：干预指令无法拼入其 prompt，仅留痕不静默吞
  for (const item of c.interventions) {
    console.warn(`[orchestrator] 架构师任务无文本通道，干预指令未拼入（messageId=${item.id}）：${item.content}`);
  }

  const result = await runArchitect({ storage, projectId, signal: c.signal, onReasoning: reasoningEmitOf(c.emit, 'architect') });
  round.architectRan = true;
  round.tree = result.fileTree;

  for (const path of result.files) {
    c.emit({ runId: result.runId, event: 'file_start', agent: 'architect', path });
    const row = await storage.getFile(projectId, path);
    c.emit({ runId: result.runId, event: 'file_end', agent: 'architect', path, meta: { version: row?.version } });
    round.producedThisRound.add(path);
  }
  const summary = await runSummaryOf(storage, projectId, result.runId);
  c.emit({ runId: result.runId, event: 'agent_end', agent: 'architect', summary: summary ?? undefined });
  return { runId: result.runId, summary: summary ?? '', files: result.files };
}

/**
 * 工程师树解析：本轮架构师树 → 库里持久化树（迭代轮次）→ 快速模式内置模板树；
 * 完整模式全无 → null（由 dispatchEngineer 走降级兜底，T33 A）。
 * 快速模式两条模板入口（①本轮架构师树空回退 ②库里无持久化树）不走裸模板：
 * 与 ③full 降级兜底共用 filteredFastTemplateTree 出口——三条模板入口同一防覆写纪律（T34）。
 */
async function resolveEngineerTree(c: TaskContext, round: RoundState): Promise<FileTree | null> {
  if (round.architectRan) {
    if (round.tree !== null && round.tree.length > 0) return round.tree;
    return c.mode === 'fast' ? filteredFastTemplateTree(c) : null;
  }
  const row = await c.storage.getFile(c.projectId, FILE_TREE_PATH);
  if (row !== null) {
    const parsed = parseFileTree(row.content);
    if (parsed.ok && parsed.tree.length > 0) return parsed.tree;
  }
  return c.mode === 'fast' ? filteredFastTemplateTree(c) : null;
}

/**
 * 快速模式内置模板树的统一出口（三条模板入口同一防覆写纪律，T33 A / T34）：
 * ①fast 本轮架构师树空回退 ②fast 库里无持久化树 ③full 模式架构师全无树的降级兜底。
 *
 * 语义（安全关键）：
 * - 模板树是**通用骨架**，直接 upsert 会把迭代轮里已生成的应用文件整个毁掉——
 *   round.producedThisRound 只做轮内去重、拦不住跨轮，所以只保留「库里还没有的路径」，
 *   files 表已存在的路径一律过滤（幂等，不覆盖既有产出；单文件重试走 regenerateFile，不经此处）；
 * - 过滤后为空 → 调用方按 T33 语义幂等完成（不写任何文件，summary 写「目标文件均已存在」）；
 * - 非空（仅降级兜底入口）→ 正常逐文件派发，PROGRESS 留 ⚠ 行说明降级事实（不静默吞）。
 *
 * 补缺是编排器的确定性兜底（CLAUDE.md 规则 1：执行侧的可靠性代码，不是替模型做设计决策）；
 * 架构师产出 file_tree 的硬保证（输出后校验+带错重试）另行挂账，不在此处。
 */
async function filteredFastTemplateTree(c: TaskContext): Promise<FileTree> {
  const existing = new Set((await c.storage.listFiles(c.projectId)).map((row) => row.path));
  return buildFastFileTree(c.project.requirement).filter((node) => !existing.has(node.path));
}

/**
 * 工程师（D1 混合模式）：按 file_tree 拓扑序逐文件派发单文件任务，成功后接写后自审
 * （runEngineerReview，一次即止，失败不阻断）。docs/ 是 PM/架构师交付物（file_tree 里的
 * docs 节点是依赖上下文，不是工程师工作项）；单文件失败发 error 后继续下一文件。
 *
 * 每个文件边界（DESIGN §3.5 两级边界的文件级）依次做两件确定性检查：
 * ① 干预注入——待注入指令只进下一个文件任务的上下文；
 * ② 人工软锁（DESIGN §3.9 预防层，仓库不拦截写入）——锁中文件挂起并请求裁决，
 *   「覆盖」= 释放锁并重跑该单文件任务，「跳过」= run 标 rolled_back，「稍后」= 不动。
 */
async function dispatchEngineer(c: TaskContext, round: RoundState): Promise<TaskDispatchResult> {
  const { storage, projectId, task } = c;
  c.emit({ runId: null, event: 'agent_start', agent: 'engineer', meta: { taskKey: task.taskKey } });

  let tree = await resolveEngineerTree(c, round);
  if (tree === null) {
    // 降级兜底（T33 A）：full 模式全无树 → 内置模板树补缺（与 fast 模板入口同一过滤出口，T34）
    tree = await filteredFastTemplateTree(c);
    if (tree.length > 0) {
      await appendProgressLine(
        storage,
        projectId,
        `- ⚠ 架构师未产出 file_tree，按内置模板树降级（新写 ${tree.length} 个文件）`,
      );
    }
  }
  if (tree.length === 0) {
    // 三条模板入口过滤后无缺可补：幂等完成，不写任何文件（避免迭代轮被骨架覆盖，T33 A / T34）
    const summary = '目标文件均已存在，无需新写（内置模板树全部命中既有文件）';
    c.emit({ runId: null, event: 'agent_end', agent: 'engineer', summary });
    return { runId: null, summary, files: [] };
  }

  // 交接摘要基线：PM/架构师 run.summary + 任务边界干预指令（规则 7：summary 是唯一交接物）
  const baseSummary = appendInterventions(await latestSummaries(storage, projectId, ['pm', 'architect']), c.interventions);
  // 编辑能力开关（DESIGN §3.9）：关 = 只读查看器，持锁文件也照常生成（开关乎人工侧，不关 agent 写入）
  const editingEnabled = await editingEnabledFor(c);

  let okCount = 0;
  let lastRunId: number | null = null;
  const failedFiles: string[] = [];

  for (const node of tree) {
    if (node.path === 'docs' || node.path.startsWith('docs/')) continue;
    if (round.producedThisRound.has(node.path)) continue;

    // ① 人工软锁：每个文件边界重读（锁可能在轮内被裁决/释放/过期，不能只在任务边界看一次）。
    //    必须先于干预注入：若该文件任务因裁决「跳过/稍后」而不跑，此边界不能消费干预——
    //    否则指令会被打戳「已注入」进一个从未运行的任务，从 agent 上下文静默消失（T23 R1）。
    const isLocked =
      editingEnabled && (await storage.getSoftLockedFiles(projectId)).some((row) => row.path === node.path);
    if (isLocked && !(await negotiateSoftLock(c, node.path))) continue;

    // ② 文件边界干预注入（裁决等待期间到达的指令也在这里收口）
    const fileInterventions = await takeInterventions(storage, projectId, `engineer:${node.path}`, c.emit);
    const designSummary = appendInterventions(baseSummary, fileInterventions);

    c.emit({ runId: null, event: 'file_start', agent: 'engineer', path: node.path });
    const result = await runEngineerFile({
      storage,
      projectId,
      requirement: c.project.requirement,
      target: node,
      fileTree: tree,
      designSummary,
      signal: c.signal,
      callbacks: {
        onDelta: (text) => c.emit({ runId: null, event: 'delta', agent: 'engineer', path: node.path, content: text }),
        onReasoning: reasoningEmitOf(c.emit, 'engineer'),
      },
    });
    // file 事件以结果为准（保底模板路径不触发工具回调，T13 注）
    c.emit({ runId: result.runId, event: 'file_end', agent: 'engineer', path: result.path, meta: { version: result.version, ok: result.ok } });
    lastRunId = result.runId;

    if (result.ok) {
      okCount += 1;
      await appendProgressLine(storage, projectId, fileDoneLine(result.path, result.version));
      // 写后自审（DESIGN §5⑤′，agent 版 lint）：同一单文件上下文再跑一次廉价 review；
      // 失败不阻断该文件（自审是增强项），仅留痕 console + PROGRESS ⚠ 行
      try {
        await runEngineerReview({
          storage,
          projectId,
          requirement: c.project.requirement,
          target: node,
          fileTree: tree,
          designSummary,
          path: result.path,
          signal: c.signal,
        });
      } catch (error) {
        if (isAbortError(error)) throw error; // 停止语义仍要冒泡
        console.warn(`[orchestrator] ${result.path} 写后自审失败（不阻断）：${errorMessage(error)}`);
        await appendProgressLine(storage, projectId, `- ⚠ ${result.path} 写后自审失败：${errorMessage(error)}`);
      }
    } else {
      failedFiles.push(result.path);
      c.emit({ runId: result.runId, event: 'error', agent: 'engineer', path: result.path, error: (result.errors ?? []).join('；') });
      await appendProgressLine(storage, projectId, fileFailedLine(result.path, result.errors ?? []));
    }
  }

  const failedNote = failedFiles.length > 0 ? `，校验未过 ${failedFiles.length} 个（${failedFiles.join('、')}）` : '';
  const summary = `逐文件任务完成：成功 ${okCount} 个${failedNote}`;
  c.emit({ runId: lastRunId, event: 'agent_end', agent: 'engineer', summary });
  return { runId: lastRunId, summary, files: [] };
}

/** 专家：固定单文件交付（EXPERT_REPORT_PATHS 提前可知）→ 打字机全程可见 */
async function dispatchExpert(c: TaskContext, round: RoundState): Promise<TaskDispatchResult> {
  const { storage, projectId, task } = c;
  const role = task.agent as ExpertRole; // dispatchTask 已按枚举收窄
  const path = EXPERT_REPORT_PATHS[role];

  c.emit({ runId: null, event: 'agent_start', agent: role, meta: { taskKey: task.taskKey } });
  const instruction = appendInterventions(task.instruction, c.interventions);
  c.emit({ runId: null, event: 'file_start', agent: role, path });
  const result = await runExpert({
    storage,
    projectId,
    role,
    instruction,
    signal: c.signal,
    onDelta: (text) => c.emit({ runId: null, event: 'delta', agent: role, path, content: text }),
    onReasoning: reasoningEmitOf(c.emit, role),
  });
  const row = await storage.getFile(projectId, path);
  c.emit({ runId: result.runId, event: 'file_end', agent: role, path, meta: { version: row?.version } });

  round.producedThisRound.add(path);
  const summary = await runSummaryOf(storage, projectId, result.runId);
  c.emit({ runId: result.runId, event: 'agent_end', agent: role, summary: summary ?? undefined });
  return { runId: result.runId, summary: summary ?? '', files: [result.file] };
}
