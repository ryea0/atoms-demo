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
import {
  appendProgressLine,
  fileDoneLine,
  fileFailedLine,
  filePausedLine,
  taskDoneLine,
  taskFailedLine,
  taskSkippedLine,
  taskStartLine,
} from '@/lib/agents/progress';
import { isAbortError } from '@/lib/agents/roles/run-support';
import { routeLeader, type TaskAssignment } from '@/lib/agents/roles/leader';
import { PRD_PATH, runPm } from '@/lib/agents/roles/pm';
import { FILE_TREE_PATH, parseFileTree, runArchitect } from '@/lib/agents/roles/architect';
import { buildFastFileTree, runEngineerFile, runEngineerReview, type FileTree } from '@/lib/agents/roles/engineer';
import { EXPERT_REPORT_PATHS, runExpert, type ExpertRole } from '@/lib/agents/roles/experts';
import { runCloser } from '@/lib/agents/roles/closer';
import { AgentAbortError } from '@/lib/agents/types';
import type { AgentRole, Message, Project, StorageProvider } from '@/lib/db/provider/types';

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

/** PM 的需求文本：项目需求为底，本轮消息不同则补充（PM 不走 assembleContext，需求需显式传） */
function pmRequirementText(project: Project, userMessage: string): string {
  const base = project.requirement.trim() === '' ? userMessage.trim() : project.requirement.trim();
  return base === userMessage.trim() ? base : `${base}\n（本轮补充：${userMessage.trim()}）`;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

/**
 * 任务前基线打点（DESIGN §3.10）。检查点在任务开跑**前**打——此刻该任务的 run 行
 * 尚不存在，因此用 afterRunId=当前最大 run id 捕获回滚边界：restore 后
 * id > afterRunId 的任务（= 打点之后发生的全部工作）标 rolled_back。
 */
async function checkpointBefore(storage: StorageProvider, projectId: number, label: string): Promise<void> {
  await storage.createCheckpoint(projectId, label, null, await storage.latestRunId(projectId));
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
    });

    // 咨询问答：不派任务、不跑收尾，直接回答并收口
    if (decision.kind === 'reply') {
      await storage.addMessage({ projectId, role: 'assistant', content: decision.reply });
      emit({ runId: null, event: 'message', agent: 'leader', content: decision.reply, meta: { role: 'assistant' } });
      await storage.updateProjectStatus(projectId, 'done');
      emit({ runId: null, event: 'done' });
      return;
    }
    if (decision.reply !== undefined) {
      await storage.addMessage({ projectId, role: 'assistant', content: decision.reply });
      emit({ runId: null, event: 'message', agent: 'leader', content: decision.reply, meta: { role: 'assistant' } });
    }

    const topo = topoSortTasks(decision.tasks);
    for (const warning of topo.warnings) await note(`- ⚠ ${warning.message}`);
    const taskByKey = new Map(decision.tasks.map((task) => [task.taskKey, task]));
    const taskOutcome = new Map<string, 'done' | 'failed' | 'skipped'>();
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

      // 检查点：任务前基线（DESIGN §3.10；短事务在 repo 层保证）
      await checkpointBefore(storage, projectId, `任务前:${taskKey}`);

      // 干预队列：步骤边界取待注入消息（DESIGN §3.5）→ 事件 → 打戳 → 拼进任务文本
      const interventions = await storage.takePendingInterventions(projectId);
      for (const item of interventions) {
        emit({ runId: null, event: 'intervention_injected', content: item.content, meta: { messageId: item.id, targetTask: taskKey } });
      }
      if (interventions.length > 0) await storage.markDelivered(interventions.map((item) => item.id), projectId);
      c.interventions = interventions;

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
      } catch (error) {
        if (isAbortError(error)) throw error; // 停止语义交给顶层统一收口
        const message = errorMessage(error);
        taskOutcome.set(taskKey, 'failed');
        emit({ runId: null, event: 'error', agent: task.agent, error: message, meta: { taskKey } });
        await note(taskFailedLine(task.agent, taskKey, message));
        // 失败不中断无依赖任务：继续下一个
      }
    }

    // 收尾：领导汇报（一次 LLM 调用）→ assistant message → done
    await checkpointBefore(storage, projectId, '任务前:leader-closing');
    emit({ runId: null, event: 'agent_start', agent: 'leader', meta: { taskKey: 'leader-closing' } });
    const closer = await runCloser({ storage, projectId, signal });
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

  const result = await runArchitect({ storage, projectId, signal: c.signal });
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
 * 完整模式全无 → null（该任务失败，其余任务照常，控制器裁决 7）。
 */
async function resolveEngineerTree(c: TaskContext, round: RoundState): Promise<FileTree | null> {
  if (round.architectRan) {
    if (round.tree !== null && round.tree.length > 0) return round.tree;
    return c.mode === 'fast' ? buildFastFileTree(c.project.requirement) : null;
  }
  const row = await c.storage.getFile(c.projectId, FILE_TREE_PATH);
  if (row !== null) {
    const parsed = parseFileTree(row.content);
    if (parsed.ok && parsed.tree.length > 0) return parsed.tree;
  }
  return c.mode === 'fast' ? buildFastFileTree(c.project.requirement) : null;
}

/**
 * 工程师（D1 混合模式）：按 file_tree 拓扑序逐文件派发单文件任务，成功后接写后自审
 * （runEngineerReview，一次即止，失败不阻断）。docs/ 是 PM/架构师交付物（file_tree 里的
 * docs 节点是依赖上下文，不是工程师工作项）；人工软锁文件跳过 + 聊天区请求裁决
 * （裁决 UI 是 Task 23）；单文件失败发 error 后继续下一文件。
 */
async function dispatchEngineer(c: TaskContext, round: RoundState): Promise<TaskDispatchResult> {
  const { storage, projectId, task } = c;
  c.emit({ runId: null, event: 'agent_start', agent: 'engineer', meta: { taskKey: task.taskKey } });

  const tree = await resolveEngineerTree(c, round);
  if (tree === null) {
    throw new Error('工程师任务没有可用 file_tree（架构师未产出且非快速模式），无法逐文件派发');
  }

  // 软锁检查在工程师任务边界做（DESIGN §3.9 预防层；仓库不拦截写入）
  const lockedPaths = new Set((await storage.getSoftLockedFiles(projectId)).map((row) => row.path));
  // 交接摘要：PM/架构师 run.summary + 干预指令（规则 7：summary 是唯一交接物）
  const designSummary = appendInterventions(await latestSummaries(storage, projectId, ['pm', 'architect']), c.interventions);

  let okCount = 0;
  let lastRunId: number | null = null;
  const failedFiles: string[] = [];

  for (const node of tree) {
    if (node.path === 'docs' || node.path.startsWith('docs/')) continue;
    if (round.producedThisRound.has(node.path)) continue;

    if (lockedPaths.has(node.path)) {
      c.emit({
        runId: null,
        event: 'message',
        agent: 'engineer',
        content: `文件 ${node.path} 正在被人工编辑（软锁生效），本轮已跳过该文件。请在聊天区裁决：保留人工修改并基于它迭代 / 覆盖生成 / 稍后再试。`,
        meta: { kind: 'softlock', path: node.path },
      });
      await appendProgressLine(storage, projectId, filePausedLine(node.path));
      continue;
    }

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
  });
  const row = await storage.getFile(projectId, path);
  c.emit({ runId: result.runId, event: 'file_end', agent: role, path, meta: { version: row?.version } });

  round.producedThisRound.add(path);
  const summary = await runSummaryOf(storage, projectId, result.runId);
  c.emit({ runId: result.runId, event: 'agent_end', agent: role, summary: summary ?? undefined });
  return { runId: result.runId, summary: summary ?? '', files: [result.file] };
}
