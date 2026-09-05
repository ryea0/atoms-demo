'use client';

/**
 * 客户端工作台 store（Task 17）——自写 useSyncExternalStore 适配，不引入 zustand。
 *
 * 职责：作为 SSE 事件流（.claude/rules/06 协议）与 React 组件之间的唯一状态层。
 * - `applyEvent` 按 event 分流：file_start 建 streaming 占位 / delta 只做累积（打字机渲染
 *   与「当前打开 path」的判断交给组件层）/ file_end 定版并清 streaming / agent_* 推进任务
 *   时间线 / message、intervention_injected 追加聊天 / done、stopped 收尾 / error 记录。
 * - `hydrate` 用 GET /api/projects/[id] 快照整体重建，**幂等**：等价快照二次 hydrate 保持
 *   同一 state 引用（不触发多余渲染）。页面级恢复 = 快照 + 首连 ?lastEventId=<快照 lastSeq>
 *   重放增量（事件 seq > lastSeq，不在快照内）；断线重连走浏览器原生 Last-Event-ID 头——
 *   两条重放路径各自只覆盖快照之后的事件，不会 delta 双份累积。
 *
 * store 为 per-project 单例（Map 缓存）；所有更新都生成新对象/新 Map（不可变更新），
 * 保证 getSnapshot 引用稳定。合成节点用负数 id，绝不与库里的自增 id 冲突。
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { StreamEvent } from '@/lib/agents/events';
import { roleRegistry } from '@/lib/agents/registry';
import type {
  AgentRole,
  AgentRun,
  Checkpoint,
  FileEditor,
  LlmUsageRow,
  Message,
  MessageMeta,
  Project,
} from '@/lib/db/provider/types';
// type-only import：编译期完全擦除，不把服务端模块带进客户端 bundle
import type { ProjectSnapshot } from '@/lib/projects/service';
import { fetchWorkspaceSnapshot } from '@/lib/client/session';

/** 单个文件的客户端态（快照行 / 在流占位共用） */
export interface WorkspaceFile {
  content: string;
  version: number;
  lastEditor: FileEditor;
  /** true = 正在流式生成（file_end / error / stopped 前都是未定版内容） */
  streaming: boolean;
}

/**
 * GET /api/projects/[id] 快照——直接采用服务层 ProjectSnapshot 契约
 * （含 lastSeq / streamingFiles / softLockedFiles；type-only import 防漂移）。
 */
export type WorkspaceSnapshot = ProjectSnapshot;

/** 工作台聚合状态（组件层通过 useWorkspace 订阅） */
export interface WorkspaceState {
  projectId: number | null;
  project: Project | null;
  files: ReadonlyMap<string, WorkspaceFile>;
  messages: readonly Message[];
  runs: readonly AgentRun[];
  checkpoints: readonly Checkpoint[];
  usage: readonly LlmUsageRow[];
  /** 仍被人工持有的软锁路径（DESIGN §3.9） */
  softLocked: readonly string[];
  /** SSE 连接状态（onopen 置真 / onerror 与卸载置假） */
  connected: boolean;
  /** 正在流式生成的路径（文件树「生长中」标记用） */
  livePaths: readonly string[];
  /** done/stopped 之后为真（error 不算收尾，运行可能继续） */
  finished: boolean;
  /** 最近一次错误（流事件或快照加载失败），中文用户可读 */
  error: string | null;
}

function initialState(): WorkspaceState {
  return {
    projectId: null,
    project: null,
    files: new Map<string, WorkspaceFile>(),
    messages: [],
    runs: [],
    checkpoints: [],
    usage: [],
    softLocked: [],
    connected: false,
    livePaths: [],
    finished: false,
    error: null,
  };
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                             */
/* ------------------------------------------------------------------ */

/** 简单深比较（字段全为扁平 JSON 结构，足够用；不等价只多渲染一次，无正确性风险） */
function recordEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function filesEquals(a: ReadonlyMap<string, WorkspaceFile>, b: ReadonlyMap<string, WorkspaceFile>): boolean {
  if (a.size !== b.size) return false;
  for (const [path, fa] of a) {
    const fb = b.get(path);
    if (fb === undefined) return false;
    if (fa.content !== fb.content || fa.version !== fb.version) return false;
    if (fa.lastEditor !== fb.lastEditor || fa.streaming !== fb.streaming) return false;
  }
  return true;
}

/** hydrate 是否等价（只比较快照能决定的字段；connected 属运行时，不参与） */
function sameState(a: WorkspaceState, b: WorkspaceState): boolean {
  if (a.projectId !== b.projectId || a.finished !== b.finished || a.error !== b.error) return false;
  if (!recordEquals(a.project, b.project)) return false;
  if (a.livePaths.join('\n') !== b.livePaths.join('\n')) return false;
  if (a.softLocked.join('\n') !== b.softLocked.join('\n')) return false;
  if (!filesEquals(a.files, b.files)) return false;
  const listEquals = (x: readonly unknown[], y: readonly unknown[]): boolean =>
    x.length === y.length && x.every((item, i) => recordEquals(item, y[i]));
  return (
    listEquals(a.messages, b.messages) &&
    listEquals(a.runs, b.runs) &&
    listEquals(a.checkpoints, b.checkpoints) &&
    listEquals(a.usage, b.usage)
  );
}

/** 逆序查找（不依赖 ES2023 Array.prototype.findLastIndex，兼容更低版本浏览器） */
function lastIndexOf<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === 'string' && value in roleRegistry;
}

/**
 * 消息 meta 组装（T19 卡片还原的数据源）：mentions 之外保留卡片语义——
 * - kind=softlock/restore、path=关联文件（领导裁决/回滚通知卡）
 * - intervention_injected 的 targetTask（T23 保证指向真实运行的任务，格式 `engineer:{path}`）
 *   折算成 path，聊天区「已注入 {文件}」卡片据此显示注入边界对应的文件
 * 事件里没有这些语义时返回 null（不写空 meta）。
 */
function messageMetaOf(event: StreamEvent, mentions: AgentRole[]): MessageMeta | null {
  const meta: MessageMeta = {};
  if (typeof event.meta?.kind === 'string' && event.meta.kind !== '') meta.kind = event.meta.kind;
  if (typeof event.meta?.path === 'string' && event.meta.path !== '') {
    meta.path = event.meta.path;
  } else if (event.event === 'intervention_injected') {
    const target = event.meta?.targetTask;
    if (typeof target === 'string') {
      const separator = target.indexOf(':');
      const candidate = separator > 0 ? target.slice(separator + 1) : '';
      if (candidate !== '') meta.path = candidate;
    }
  }
  if (mentions.length > 0) meta.mentions = mentions;
  return Object.keys(meta).length === 0 ? null : meta;
}

/** 在流路径列表（files Map 插入序 = 展示序） */
function livePathsOf(files: ReadonlyMap<string, WorkspaceFile>): string[] {
  const paths: string[] = [];
  for (const [path, file] of files) if (file.streaming) paths.push(path);
  return paths;
}

/** 收尾（stopped/done）时清掉全部在流标记 */
function withStreamingCleared(files: ReadonlyMap<string, WorkspaceFile>): Map<string, WorkspaceFile> {
  const next = new Map<string, WorkspaceFile>();
  for (const [path, file] of files) next.set(path, file.streaming ? { ...file, streaming: false } : file);
  return next;
}

function withStatus(project: Project | null, status: Project['status']): Project | null {
  if (project === null || project.status === status) return project;
  return { ...project, status };
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

export class WorkspaceStore {
  private state: WorkspaceState = initialState();

  private readonly listeners = new Set<() => void>();

  /** 合成节点 id（负向递减，不与库里自增 id 冲突） */
  private syntheticId = 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getState = (): WorkspaceState => this.state;

  /** 不可变更新 + 通知（未提供补丁时不产生新引用、不通知） */
  private patch(patch: Partial<WorkspaceState>): void {
    if (Object.keys(patch).length === 0) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private upsertFile(path: string, build: (prev: WorkspaceFile | undefined) => WorkspaceFile): Partial<WorkspaceState> {
    const files = new Map(this.state.files);
    files.set(path, build(files.get(path)));
    return { files, livePaths: livePathsOf(files) };
  }

  /** SSE 连接状态（onopen/onerror/卸载；值不变时不通知，避免渲染抖动） */
  setConnected(connected: boolean): void {
    if (this.state.connected === connected) return;
    this.patch({ connected });
  }

  /** 快照加载失败等非流错误也走 error 通道（用户可见，不静默吞） */
  patchError(message: string): void {
    this.patch({ error: message });
  }

  /** 事件分流入口；非本项目事件直接丢弃（防串台） */
  applyEvent(event: StreamEvent): void {
    if (this.state.projectId !== null && event.projectId !== this.state.projectId) return;
    switch (event.event) {
      case 'file_start':
        this.applyFileUpsert(event, () => '');
        break;
      case 'delta':
        this.applyFileUpsert(event, (prev) => (prev?.content ?? '') + (event.content ?? ''));
        break;
      case 'file_end':
        this.applyFileEnd(event);
        break;
      case 'agent_start':
        this.patch(this.runsPatchForStart(event));
        break;
      case 'agent_end':
        this.patch(this.runsPatchForEnd(event));
        break;
      case 'message':
        this.patch(this.messagesPatchFor(event, this.messageRoleOf(event)));
        break;
      case 'intervention_injected':
        this.patch(this.messagesPatchFor(event, 'intervention'));
        break;
      case 'done':
        this.patch({
          files: withStreamingCleared(this.state.files),
          livePaths: [],
          finished: true,
          project: withStatus(this.state.project, 'done'),
        });
        break;
      case 'stopped':
        this.patch({
          files: withStreamingCleared(this.state.files),
          livePaths: [],
          finished: true,
          project: withStatus(this.state.project, 'paused'),
        });
        break;
      case 'error':
        this.patch(this.errorPatchFor(event));
        break;
      default:
        break;
    }
  }

  /** file_start：重开占位（内容清空，等 delta 重填）；file_end：以累积内容定版 */
  private applyFileUpsert(event: StreamEvent, contentOf: (prev: WorkspaceFile | undefined) => string): void {
    const path = event.path;
    if (path === undefined) return;
    this.patch(
      this.upsertFile(path, (prev) => ({
        content: contentOf(prev),
        version: prev?.version ?? 0,
        lastEditor: event.agent ?? prev?.lastEditor ?? 'engineer',
        streaming: true,
      })),
    );
  }

  private applyFileEnd(event: StreamEvent): void {
    const path = event.path;
    if (path === undefined) return;
    const metaVersion = event.meta?.version;
    this.patch(
      this.upsertFile(path, (prev) => ({
        content: prev?.content ?? '',
        // 服务端在 file_end 带 meta.version（落库后的真实版本）；缺失则本地 +1 兜底
        version: typeof metaVersion === 'number' ? metaVersion : (prev?.version ?? 0) + 1,
        lastEditor: event.agent ?? prev?.lastEditor ?? 'engineer',
        streaming: false,
      })),
    );
  }

  private errorPatchFor(event: StreamEvent): Partial<WorkspaceState> {
    const path = event.path;
    const patch: Partial<WorkspaceState> = { error: event.error ?? '生成过程出现错误' };
    if (path !== undefined && this.state.files.get(path)?.streaming === true) {
      // 文件级失败：清该路径在流标记（服务端同时清 liveBuffer）
      return {
        ...patch,
        ...this.upsertFile(path, (prev) => ({
          content: prev?.content ?? '',
          version: prev?.version ?? 0,
          lastEditor: prev?.lastEditor ?? 'engineer',
          streaming: false,
        })),
      };
    }
    // 无 path 且无 agent 的 error 是编排器的顶层失败（运行终止）：置 failed 并收尾，
    // 避免前端把项目永远停留在「生成中」；任务级/文件级失败（带 agent 或 path）不算收尾
    if (path === undefined && event.agent === undefined) {
      return { ...patch, finished: true, project: withStatus(this.state.project, 'failed') };
    }
    return patch;
  }

  /** agent_start：runId 能对上库里的 run 就置 running；否则补一个运行中的合成节点（同任务去重） */
  private runsPatchForStart(event: StreamEvent): Partial<WorkspaceState> {
    const runs = [...this.state.runs];
    const metaTaskKey = event.meta?.taskKey;
    const taskKey = typeof metaTaskKey === 'string' ? metaTaskKey : '';
    const agent = event.agent ?? 'leader';

    if (event.runId !== null) {
      const index = runs.findIndex((run) => run.id === event.runId);
      const run = index >= 0 ? runs[index] : undefined;
      if (run !== undefined && index >= 0) {
        runs[index] = { ...run, status: 'running', taskKey: taskKey || run.taskKey };
        return { runs };
      }
    }
    const duplicateIndex = runs.findIndex(
      (run) => run.agent === agent && run.status === 'running' && (taskKey === '' || run.taskKey === taskKey),
    );
    if (duplicateIndex >= 0) return {}; // 同一任务重复 start：不加节点

    this.syntheticId -= 1;
    runs.push({
      id: this.syntheticId,
      projectId: event.projectId,
      taskKey,
      agent,
      task: '',
      status: 'running',
      summary: null,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
    });
    return { runs };
  }

  /** agent_end：优先按 runId 收尾，否则收尾该角色最近的运行中节点；都找不到则补已完成节点 */
  private runsPatchForEnd(event: StreamEvent): Partial<WorkspaceState> {
    const runs = [...this.state.runs];
    const summary = event.summary ?? null;
    const endedAt = Date.now();
    const finishAt = (index: number, run: AgentRun): Partial<WorkspaceState> => {
      runs[index] = { ...run, status: 'done', summary: summary ?? run.summary, endedAt };
      return { runs };
    };

    if (event.runId !== null) {
      const index = runs.findIndex((run) => run.id === event.runId);
      const run = index >= 0 ? runs[index] : undefined;
      if (run !== undefined && index >= 0) return finishAt(index, run);
    }
    const agent = event.agent;
    const index = lastIndexOf(runs, (run) => (agent === undefined || run.agent === agent) && run.status === 'running');
    const run = index >= 0 ? runs[index] : undefined;
    if (run !== undefined && index >= 0) return finishAt(index, run);

    this.syntheticId -= 1;
    runs.push({
      id: this.syntheticId,
      projectId: event.projectId,
      taskKey: typeof event.meta?.taskKey === 'string' ? event.meta.taskKey : '',
      agent: agent ?? 'leader',
      task: '',
      status: 'done',
      summary,
      startedAt: null,
      endedAt,
      error: event.error ?? null,
    });
    return { runs };
  }

  /** 消息角色：事件 meta.role 限定 user/assistant，其余按 assistant 处理 */
  private messageRoleOf(event: StreamEvent): Message['role'] {
    const role = event.meta?.role;
    return role === 'user' ? 'user' : 'assistant';
  }

  /** message / intervention_injected：按正数 messageId 去重（快照与重放叠加时不重复） */
  private messagesPatchFor(event: StreamEvent, role: Message['role']): Partial<WorkspaceState> {
    const meta: Record<string, unknown> = event.meta ?? {};
    const rawId = meta.messageId;
    const id = typeof rawId === 'number' ? rawId : (this.syntheticId -= 1);

    const existingIndex = id > 0 ? this.state.messages.findIndex((message) => message.id === id) : -1;
    if (existingIndex >= 0) {
      const existing = this.state.messages[existingIndex];
      if (existing === undefined) return {};
      // 唯一例外：本地补登的待注入干预（appendPendingIntervention）等到注入事件——
      // 翻转为已注入（打戳 + 带上 targetTask 折算的 path），而不是被去重吞掉留在「排队中」
      if (event.event !== 'intervention_injected' || existing.deliveredAt !== null) return {};
      const messages = [...this.state.messages];
      messages[existingIndex] = {
        ...existing,
        deliveredAt: Date.now(),
        meta: messageMetaOf(event, existing.meta?.mentions ?? []),
      };
      return { messages };
    }

    const rawMentions: unknown[] = Array.isArray(meta.mentions) ? meta.mentions : [];
    const mentions = rawMentions.filter(isAgentRole);
    const now = Date.now();
    const message: Message = {
      id,
      projectId: event.projectId,
      role,
      content: event.content ?? '',
      meta: messageMetaOf(event, mentions),
      deliveredAt: now,
      createdAt: now,
    };
    return { messages: [...this.state.messages, message] };
  }

  /**
   * 本地补登「运行中干预」（T19 R1）：POST /messages 的入队分支只落库不发 SSE，
   * 用响应里的 messageId 补一条 deliveredAt=null 的待注入消息，「📥 排队中」卡片即时出现，
   * 不必等注入事件或刷新。之后同 messageId 的注入事件会把它翻转为已注入（见 messagesPatchFor）。
   */
  appendPendingIntervention(input: {
    projectId: number;
    messageId: number;
    content: string;
    mentions: readonly AgentRole[];
  }): void {
    // 防串台 / 非法 id / 与既有消息（快照、重放）重复
    if (this.state.projectId !== null && this.state.projectId !== input.projectId) return;
    if (input.messageId <= 0) return;
    if (this.state.messages.some((message) => message.id === input.messageId)) return;
    const message: Message = {
      id: input.messageId,
      projectId: input.projectId,
      role: 'intervention',
      content: input.content,
      meta: input.mentions.length > 0 ? { mentions: [...input.mentions] } : null,
      deliveredAt: null,
      createdAt: Date.now(),
    };
    this.patch({ messages: [...this.state.messages, message] });
  }

  /**
   * 快照整体重建（幂等）：等价快照保持原 state 引用。
   * streamingFiles 转在流占位，让「刷新页面时正在生成的文件」直接可读可续写；
   * softLockedFiles 只取 path 列表（UI 提示用），其余字段留在快照层。
   */
  hydrate(snapshot: WorkspaceSnapshot): void {
    const files = new Map<string, WorkspaceFile>();
    for (const row of snapshot.files) {
      files.set(row.path, {
        content: row.content,
        version: row.version,
        lastEditor: row.lastEditor,
        streaming: false,
      });
    }
    const livePaths: string[] = [];
    for (const item of snapshot.streamingFiles) {
      const existing = files.get(item.path);
      files.set(item.path, {
        content: item.content,
        version: existing?.version ?? 0,
        lastEditor: existing?.lastEditor ?? 'engineer',
        streaming: true,
      });
      livePaths.push(item.path);
    }

    const status = snapshot.project.status;
    const next: WorkspaceState = {
      projectId: snapshot.project.id,
      project: snapshot.project,
      files,
      livePaths,
      messages: [...snapshot.messages],
      runs: [...snapshot.agentRuns],
      checkpoints: [...snapshot.checkpoints],
      usage: [...snapshot.usage],
      softLocked: [...new Set(snapshot.softLockedFiles.map((file) => file.path))],
      connected: this.state.connected,
      finished: status === 'done' || status === 'failed',
      error: null,
    };
    if (sameState(this.state, next)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

/* ------------------------------------------------------------------ */
/* per-project 单例 + hook                                              */
/* ------------------------------------------------------------------ */

const stores = new Map<number, WorkspaceStore>();

/**
 * 取工作台 store：带 projectId 时返回该项目的单例（Map 缓存，切项目互不串扰）；
 * 缺省返回游离实例（组件外使用/测试隔离）。
 */
export function createWorkspaceStore(projectId?: number): WorkspaceStore {
  if (projectId === undefined) return new WorkspaceStore();
  let store = stores.get(projectId);
  if (store === undefined) {
    store = new WorkspaceStore();
    stores.set(projectId, store);
  }
  return store;
}

/** 清空单例缓存（项目删除 / 测试隔离用；组件持有的旧实例会在下次取值时被替换） */
export function clearWorkspaceStores(): void {
  stores.clear();
}

/**
 * 工作台订阅 hook：快照 hydrate → EventSource 订阅 → 事件入 store。
 * 连接/快照是外部系统同步，全部收在 effect 里；卸载时 abort + close()，不留悬挂连接。
 */
export function useWorkspace(projectId: number): WorkspaceState {
  const store = createWorkspaceStore(projectId);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    const controller = new AbortController();
    let source: EventSource | null = null;
    let cancelled = false;

    const connect = (lastSeq: number): void => {
      // 首连重放入口：快照 lastSeq 进 query（原生 EventSource 首连带不了自定义头，DESIGN §3.6
      // 「先快照对齐、再从快照 seq 重放增量」靠它闭合）；断线重连由浏览器原生 Last-Event-ID
      // 头接管（route 侧头优先于 query，重连不受 URL 里的旧值影响）
      source = new EventSource(`/api/projects/${projectId}/stream?lastEventId=${lastSeq}`);
      source.onopen = () => store.setConnected(true);
      source.onmessage = (messageEvent: MessageEvent<string>) => {
        try {
          store.applyEvent(JSON.parse(messageEvent.data) as StreamEvent);
        } catch (error) {
          console.error('[workspace] SSE 事件解析失败：', error);
        }
      };
      // onerror 只更新指示灯；EventSource 浏览器原生自动重连并携带 Last-Event-ID
      source.onerror = () => store.setConnected(false);
    };

    void fetchWorkspaceSnapshot(projectId, controller.signal)
      .then((snapshot) => {
        if (cancelled) return;
        store.hydrate(snapshot);
        connect(snapshot.lastSeq);
      })
      .catch((error: unknown) => {
        if (cancelled || controller.signal.aborted) return;
        console.error('[workspace] 快照加载失败：', error);
        store.patchError(error instanceof Error ? `快照加载失败：${error.message}` : '快照加载失败，请刷新重试');
      });

    return () => {
      cancelled = true;
      controller.abort();
      source?.close();
      store.setConnected(false);
    };
  }, [projectId, store]);

  return state;
}

/** 文件尚不存在时的共享空占位（引用恒定，避免 getSnapshot 每次返回新对象） */
const MISSING_FILE: WorkspaceFile = { content: '', version: 0, lastEditor: 'engineer', streaming: false };

/**
 * 单文件订阅（细粒度选择器，T19 打字机/查看器消费）：只在该 path 的内容变化时才重渲染。
 * 实现：复用 store 级 subscribe（store 变化都会通知 React），但 getSnapshot 只取本 path 的
 * WorkspaceFile 引用——引用不变（Object.is 相等）时 useSyncExternalStore 跳过重渲染，
 * 因此其他路径的 delta 在打字机期间不会拖累整个文件树重渲染。
 */
export function useWorkspaceFile(projectId: number, path: string): WorkspaceFile {
  const store = createWorkspaceStore(projectId);
  const getFile = (): WorkspaceFile => store.getState().files.get(path) ?? MISSING_FILE;
  return useSyncExternalStore(store.subscribe, getFile, getFile);
}
