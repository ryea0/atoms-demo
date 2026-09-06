/**
 * 项目服务层（Task 16，.claude/rules/02：handler 不写业务，逻辑落 src/lib/）。
 *
 * - buildProjectSnapshot：现场恢复快照（DESIGN §3.6：files 全文 + 正在流式文件的
 *   内存缓冲全文 + agent_runs/检查点/usage/软锁），供 GET /api/projects/[id] 与
 *   SSE 重连对齐用（客户端先快照对齐、再 Last-Event-ID 重放）。
 * - startRoundInBackground：fire-and-forget 起一轮生成（POST /api/projects 与
 *   POST messages 空闲分支复用）。
 * - restoreCheckpointAndNotify：项目级回滚（DESIGN §3.10）= 恢复 files +
 *   相关 agent_runs 标 rolled_back + SSE message 通知。
 * - regenerateFile：单文件重试（D1：重跑该单文件任务），事件契约与编排器
 *   dispatchEngineer 对齐（agent_start/file_start/delta/file_end/agent_end）。
 *
 * 服务端专用（orchestrator/roles 在下游），不得进入客户端 bundle。
 */
import { projectEventBus } from '@/lib/agents/events';
import { orchestratorStatus, startGeneration } from '@/lib/agents/orchestrator';
import { FILE_TREE_PATH, parseFileTree } from '@/lib/agents/roles/architect';
import { buildFastFileTree, runEngineerFile, type EngineerFileResult, type FileTree } from '@/lib/agents/roles/engineer';
import type { FileTreeNode } from '@/lib/agents/roles/file-tree';
import type {
  AgentRole,
  AgentRun,
  Checkpoint,
  FileRow,
  LlmUsageRow,
  Message,
  Project,
  StorageProvider,
} from '@/lib/db/provider/types';

/* ------------------------------------------------------------------ */
/* 现场恢复快照                                                         */
/* ------------------------------------------------------------------ */

/** 快照内的文件行（全文；file_tree UI 用不上 content，但恢复必须全量） */
export interface SnapshotFile {
  id: number;
  path: string;
  content: string;
  version: number;
  lastEditor: FileRow['lastEditor'];
  updatedAt: number;
}

/** 正在流式生成的文件（bus.liveBuffer 非空者；刷新后打字机续读的来源） */
export interface StreamingFile {
  path: string;
  content: string;
}

/** 软锁文件（人机共编裁决提示用，DESIGN §3.9） */
export interface SoftLockedFile {
  fileId: number;
  path: string;
  editingBy: string | null;
  editingExpiresAt: number | null;
}

/** GET /api/projects/[id] 响应体（T17+ 前端恢复契约） */
export interface ProjectSnapshot {
  project: Project;
  /** 总线当前最新 seq：客户端据此设置 Last-Event-ID，重放快照之后的事件 */
  lastSeq: number;
  messages: Message[];
  files: SnapshotFile[];
  agentRuns: AgentRun[];
  checkpoints: Checkpoint[];
  usage: LlmUsageRow[];
  streamingFiles: StreamingFile[];
  softLockedFiles: SoftLockedFile[];
}

/**
 * 组装现场恢复快照。streamingFiles 的候选路径 = 环形缓冲里出现过的 file_start
 * 路径 ∪ 已落库路径；liveBuffer 非空即「在流」（总线在 file_end/error/stopped 时清除）。
 * 项目不存在返回 null（调用方回 404）。
 */
export async function buildProjectSnapshot(storage: StorageProvider, projectId: number): Promise<ProjectSnapshot | null> {
  const project = await storage.getProject(projectId);
  if (project === null) return null;

  const [messages, fileRows, agentRuns, checkpoints, usage, lockedRows] = await Promise.all([
    storage.listMessages(projectId),
    storage.readAllFiles(projectId),
    storage.listAgentRuns(projectId),
    storage.listCheckpoints(projectId),
    storage.usageByProject(projectId),
    storage.getSoftLockedFiles(projectId),
  ]);

  const ring = projectEventBus.snapshotBuffer(projectId, 0);
  const lastSeq = ring.at(-1)?.seq ?? 0;

  const candidates = new Set<string>(fileRows.map((row) => row.path));
  for (const event of ring) {
    if (event.event === 'file_start' && event.path !== undefined) candidates.add(event.path);
  }
  const streamingFiles: StreamingFile[] = [];
  for (const path of candidates) {
    const content = projectEventBus.liveBuffer(projectId, path);
    if (content !== '') streamingFiles.push({ path, content });
  }

  return {
    project,
    lastSeq,
    messages,
    files: fileRows.map((row) => ({
      id: row.id,
      path: row.path,
      content: row.content,
      version: row.version,
      lastEditor: row.lastEditor,
      updatedAt: row.updatedAt,
    })),
    agentRuns,
    checkpoints,
    usage,
    streamingFiles,
    softLockedFiles: lockedRows.map((row) => ({
      fileId: row.id,
      path: row.path,
      editingBy: row.editingBy,
      editingExpiresAt: row.editingExpiresAt,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 后台起跑一轮生成                                                     */
/* ------------------------------------------------------------------ */

/**
 * fire-and-forget 起一轮生成：HTTP 响应先回，生成在后台推进（状态变化全走 SSE）。
 * startGeneration 内部已兜底（轮次异常 → error 事件 + status=failed，绝不悬空 reject），
 * 这里的 .catch 只是防御层。
 * 已知限制：依赖 Next 常驻进程模型；若部署到按请求伸缩的 serverless（每请求新进程），
 * 后台轮会随请求结束被掐断——demo 为单机常驻 node server，不适用该场景。
 */
export function startRoundInBackground(
  storage: StorageProvider,
  project: Project,
  userMessage: string,
  mentions: AgentRole[],
): void {
  void startGeneration({
    storage,
    projectId: project.id,
    userMessage,
    mode: project.mode,
    mentions,
    signal: new AbortController().signal,
  }).catch((error: unknown) => {
    console.error(`[api] 后台生成异常（projectId=${project.id}）：`, error);
  });
}

/* ------------------------------------------------------------------ */
/* 检查点回滚                                                           */
/* ------------------------------------------------------------------ */

/** 检查点不存在或归属不符（路由层转 404） */
export class CheckpointNotFoundError extends Error {
  constructor(cpId: number) {
    super(`检查点不存在：id=${cpId}`);
    this.name = 'CheckpointNotFoundError';
  }
}

/**
 * 项目级回滚（DESIGN §3.10）：恢复 files（repo 层短事务，回滚可撤销）→
 * 检查点**之后**的 agent_runs 标 rolled_back（id > checkpoint.afterRunId——生产检查点
 * 全部由编排器在任务前打点，afterRunId 即打点时刻的最大 run id；打点之前的工作
 * 仍然成立，不动）→ 回滚通知落库为 assistant 消息并发 SSE message（回带 messageId，
 * 前端按正数 id 去重，快照与重放叠加不重复）。返回受影响 fileId 列表（按快照路径升序，repo 契约）。
 */
export async function restoreCheckpointAndNotify(storage: StorageProvider, projectId: number, cpId: number): Promise<number[]> {
  const checkpoints = await storage.listCheckpoints(projectId);
  const checkpoint = checkpoints.find((item) => item.id === cpId);
  if (checkpoint === undefined) throw new CheckpointNotFoundError(cpId);

  const affected = await storage.restoreCheckpoint(projectId, cpId);
  await storage.markRunsRolledBack(projectId, checkpoint.afterRunId);

  const content = `已回滚到检查点「${checkpoint.label}」：恢复 ${affected.length} 个文件（回滚前内容已入版本历史，可再撤销）。`;
  const row = await storage.addMessage({
    projectId,
    role: 'assistant',
    content,
    meta: { kind: 'restore' },
  });
  projectEventBus.emit(projectId, {
    runId: null,
    event: 'message',
    agent: 'leader',
    content,
    meta: { role: 'assistant', kind: 'restore', checkpointId: cpId, files: affected.length, messageId: row.id },
  });
  return affected;
}

/* ------------------------------------------------------------------ */
/* 单文件重试（regenerate）                                             */
/* ------------------------------------------------------------------ */

/** 重试目标解析：file_tree 有节点用其 desc/depends，否则合成最小节点 */
function resolveTargetNode(tree: FileTree, path: string): FileTreeNode {
  const found = tree.find((node) => node.path === path);
  if (found !== undefined) return found;
  return { path, desc: `重新生成文件 ${path}（file_tree 中无该节点的按人工补充文件处理）`, depends: [] };
}

/** 重试上下文：树优先取库里 docs/file_tree.json，缺失/无效回退快速模式内置树 */
async function resolveTree(storage: StorageProvider, projectId: number, requirement: string): Promise<FileTree> {
  const row = await storage.getFile(projectId, FILE_TREE_PATH);
  if (row !== null) {
    const parsed = parseFileTree(row.content);
    if (parsed.ok && parsed.tree.length > 0) return parsed.tree;
  }
  return buildFastFileTree(requirement);
}

/** 交接摘要：最近一次架构师 run.summary（规则 7：summary 是唯一交接物）；无则空串 */
async function latestArchitectSummary(storage: StorageProvider, projectId: number): Promise<string> {
  const runs = await storage.listAgentRuns(projectId);
  const found = [...runs].reverse().find((run) => run.agent === 'architect' && run.summary !== null && run.summary !== '');
  return found?.summary ?? '';
}

/**
 * 单文件重试 = 重跑该单文件任务（CLAUDE.md 规则 3）。
 * 事件契约与编排器 dispatchEngineer 一致（时间线/打字机无需感知发起方差异）；
 * meta.regenerate=true 标记来源。调用方须先确认项目空闲（串行写模型）。
 */
export async function regenerateFile(
  storage: StorageProvider,
  projectId: number,
  file: FileRow,
  signal: AbortSignal,
): Promise<EngineerFileResult> {
  const project = await storage.getProject(projectId);
  if (project === null) throw new Error(`项目不存在：projectId=${projectId}`);
  if (orchestratorStatus(projectId) === 'running') {
    throw new Error('生成进行中，不能重试单文件（调用方应先做串行检查）');
  }

  const emit = projectEventBus.emit.bind(projectEventBus, projectId);
  const tree = await resolveTree(storage, projectId, project.requirement);
  const target = resolveTargetNode(tree, file.path);
  const designSummary = await latestArchitectSummary(storage, projectId);

  emit({ runId: null, event: 'agent_start', agent: 'engineer', meta: { taskKey: `engineer:${file.path}`, regenerate: true } });
  emit({ runId: null, event: 'file_start', agent: 'engineer', path: file.path });

  const result = await runEngineerFile({
    storage,
    projectId,
    requirement: project.requirement,
    target,
    fileTree: tree,
    designSummary,
    signal,
    callbacks: {
      onDelta: (text) => emit({ runId: null, event: 'delta', agent: 'engineer', path: file.path, content: text }),
      // 思考流与轮次行为一致（T32 M3）：重试同样透传 reasoning（ephemeral，不进环形缓冲）
      onReasoning: (text) => emit({ runId: null, event: 'reasoning', agent: 'engineer', content: text }),
    },
  });

  const summary = `${result.path} v${result.version} 重新生成${result.ok ? '完成' : '（校验未过，文件保留落库）'}`;
  emit({ runId: result.runId, event: 'file_end', agent: 'engineer', path: result.path, meta: { version: result.version, ok: result.ok, regenerate: true } });
  emit({ runId: result.runId, event: 'agent_end', agent: 'engineer', summary });
  return result;
}
