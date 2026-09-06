/**
 * 编排器测试（Task 15，DESIGN §3.3 串行 DAG / §3.5 干预与停止 / §3.6 SSE 协议 / §3.10 检查点）。
 *
 * brief Step 1 用例（mock 全链路）：
 * ① 建项目→startGeneration→事件序列 agent_start(pm)…file_start…delta…file_end…done；
 *    files 最终含 docs/* + app/*；PROGRESS.md 为任务计划清单（任务级 [x] 打勾且在收尾段之前）
 * ② stopProject 中途 → 事件含 stopped、status=paused
 * ③ 注入 pending intervention → 事件 intervention_injected、deliveredAt 已打、PM 上下文含指令
 * ④ 单文件 hard×2 → 该文件 ok=false（errors 非空）、error 事件、后续文件继续、done 仍发出
 * ⑤ 环依赖 DAG → 不断环死锁，警告入 run summary 与 PROGRESS，其余任务照常
 * ⑥ 并发 startGeneration 同项目串行化（队列互斥）
 * ⑦ closer 汇报成为 assistant message
 * 补充：事件总线单元（seq 单调 / 环形缓冲重放 / liveBuffer 生命周期 / 容量上限 / 订阅者隔离）。
 *
 * 失败注入用透明模块桩（默认全透传，个别用例置标志位），其余走 mock provider 真链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectEventBus, projectEventBus, type StreamEvent } from '@/lib/agents/events';
import { orchestratorStatus, startGeneration, stopProject } from '@/lib/agents/orchestrator';
import { CLOSING_SECTION_HEADING, MEMORY_PATH, PROGRESS_PATH, renderRoundOutcomeSection } from '@/lib/agents/roles/closer';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';
import type { TaskAssignment } from '@/lib/agents/roles/leader';

/* ------------------------------------------------------------------ */
/* 透明模块桩（失败注入）                                                */
/* ------------------------------------------------------------------ */

/** 捕获 runPm 收到的 requirement（干预注入断言用） */
const pmRequirements: string[] = [];
/** 这些路径的 runEngineerFile 直接返回 ok=false 结果（模拟 hard×2 重试耗尽） */
const engineerFailPaths = new Set<string>();
/** 这些路径的 runEngineerFile 直接抛错且不建 run 行（T33 B：前置失败=任务级 catch 看到的形状） */
const engineerThrowPaths = new Set<string>();
/** 记录写后自审被调用的文件路径（接线断言用） */
const reviewPaths: string[] = [];
/** 这些路径的写后自审直接抛错（自审失败不阻断的断言用） */
const reviewFailPaths = new Set<string>();
/** 非空则 routeLeader 返回这份 DAG（环依赖注入用） */
let cycleTasks: TaskAssignment[] | null = null;
/** 置位则 runArchitect 返回空 fileTree / 空 files（fast 模式「架构师树空回退」模板入口，T34） */
let architectEmptyTree = false;
/** 非空则在 PM 任务执行中途调用（模拟「任务跑着的时候用户发来干预」，T31 Commit C） */
let midRoundEnqueue: ((ctx: { storage: StorageProvider; projectId: number }) => Promise<void>) | null = null;
/** 捕获每次 runCloser 收到的入参（T33 C：编排器是否把本轮结果传给收尾上下文） */
const closerInputs: import('@/lib/agents/roles/closer').RunCloserInput[] = [];

vi.mock('@/lib/agents/roles/pm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/roles/pm')>();
  return {
    ...actual,
    runPm: async (ctx: import('@/lib/agents/roles/pm').PmContext) => {
      pmRequirements.push(ctx.requirement);
      if (midRoundEnqueue !== null) await midRoundEnqueue({ storage: ctx.storage, projectId: ctx.projectId });
      return actual.runPm(ctx);
    },
  };
});

vi.mock('@/lib/agents/roles/engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/roles/engineer')>();
  return {
    ...actual,
    runEngineerFile: (ctx: import('@/lib/agents/roles/engineer').EngineerFileContext) => {
      if (engineerFailPaths.has(ctx.target.path)) {
        return Promise.resolve({
          runId: 0,
          path: ctx.target.path,
          version: 1,
          ok: false,
          softWarnings: [],
          errors: [`${ctx.target.path}：硬性违规 dangerous_api——出现 eval 用法`],
        });
      }
      if (engineerThrowPaths.has(ctx.target.path)) {
        return Promise.reject(new Error('单文件任务执行失败：provider 连续两次不可用。文件未写入'));
      }
      return actual.runEngineerFile(ctx);
    },
    runEngineerReview: (ctx: import('@/lib/agents/roles/engineer').EngineerReviewContext) => {
      reviewPaths.push(ctx.path);
      if (reviewFailPaths.has(ctx.path)) return Promise.reject(new Error('自审 provider 炸了'));
      return actual.runEngineerReview(ctx);
    },
  };
});

vi.mock('@/lib/agents/roles/leader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/roles/leader')>();
  return {
    ...actual,
    routeLeader: (input: import('@/lib/agents/roles/leader').RouteLeaderInput) =>
      cycleTasks === null ? actual.routeLeader(input) : Promise.resolve({ kind: 'tasks' as const, tasks: cycleTasks }),
  };
});

vi.mock('@/lib/agents/roles/architect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/roles/architect')>();
  return {
    ...actual,
    runArchitect: (ctx: import('@/lib/agents/roles/architect').ArchitectContext) =>
      architectEmptyTree ? Promise.resolve({ runId: 0, files: [], fileTree: [] }) : actual.runArchitect(ctx),
  };
});

vi.mock('@/lib/agents/roles/closer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/roles/closer')>();
  return {
    ...actual,
    runCloser: (ctx: import('@/lib/agents/roles/closer').RunCloserInput) => {
      closerInputs.push(ctx);
      return actual.runCloser(ctx);
    },
  };
});

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

const REQUIREMENT = '做一个待办清单应用';

/** 独立内存库 + 新项目 */
async function newProject(mode: 'fast' | 'full' = 'full'): Promise<{ storage: StorageProvider; projectId: number }> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's', title: '待办应用', requirement: REQUIREMENT, mode });
  return { storage, projectId: project.id };
}

/** 订阅项目事件总线，收集全部事件；返回收集器与退订函数 */
function collectEvents(projectId: number): { events: StreamEvent[]; stop: () => void } {
  const events: StreamEvent[] = [];
  const stop = projectEventBus.subscribe(projectId, (event) => events.push(event));
  return { events, stop };
}

/** 收集器内按断言取值（缺失显式失败，规避 noUncheckedIndexedAccess 的可空访问） */
function mustFind(events: StreamEvent[], predicate: (event: StreamEvent) => boolean): StreamEvent {
  const found = events.find(predicate);
  if (found === undefined) throw new Error('预期存在匹配事件，实际未发出');
  return found;
}

async function progressRow(storage: StorageProvider, projectId: number): Promise<{ content: string }> {
  const row = await storage.getFile(projectId, PROGRESS_PATH);
  if (row === null) throw new Error(`${PROGRESS_PATH} 未生成`);
  return { content: row.content };
}

beforeEach(() => {
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0'); // 离线快速：mock 流式延迟置 0
  pmRequirements.length = 0;
  engineerFailPaths.clear();
  engineerThrowPaths.clear();
  reviewPaths.length = 0;
  reviewFailPaths.clear();
  cycleTasks = null;
  architectEmptyTree = false;
  midRoundEnqueue = null;
  closerInputs.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* 事件总线单元                                                          */
/* ------------------------------------------------------------------ */

describe('ProjectEventBus', () => {
  it('seq 按 project 单调递增，多项目互不影响', () => {
    const bus = new ProjectEventBus();
    const a1 = bus.emit(1, { runId: null, event: 'message', content: 'a1' });
    const b1 = bus.emit(2, { runId: null, event: 'message', content: 'b1' });
    const a2 = bus.emit(1, { runId: null, event: 'message', content: 'a2' });
    expect(a1.seq).toBe(1);
    expect(b1.seq).toBe(1);
    expect(a2.seq).toBe(2);
    expect(a2.projectId).toBe(1);
  });

  it('snapshotBuffer(afterSeq) 只返回之后的事件；subscribe(afterSeq) 先重放再实时', () => {
    const bus = new ProjectEventBus();
    bus.emit(1, { runId: null, event: 'message', content: '1' });
    bus.emit(1, { runId: null, event: 'message', content: '2' });
    bus.emit(1, { runId: null, event: 'message', content: '3' });

    expect(bus.snapshotBuffer(1, 1).map((e) => e.content)).toEqual(['2', '3']);
    expect(bus.snapshotBuffer(1, 3)).toEqual([]);

    const seen: string[] = [];
    const stop = bus.subscribe(1, (e) => seen.push(e.content ?? ''), 1);
    expect(seen).toEqual(['2', '3']); // 先重放
    bus.emit(1, { runId: null, event: 'message', content: '4' });
    expect(seen).toEqual(['2', '3', '4']); // 再实时
    stop();
    bus.emit(1, { runId: null, event: 'message', content: '5' });
    expect(seen).toEqual(['2', '3', '4']); // 退订后不再收到
  });

  it('liveBuffer：delta 累积、file_end 清除', () => {
    const bus = new ProjectEventBus();
    bus.emit(1, { runId: null, event: 'file_start', path: 'app/a.js' });
    bus.emit(1, { runId: null, event: 'delta', path: 'app/a.js', content: 'abc' });
    bus.emit(1, { runId: null, event: 'delta', path: 'app/a.js', content: 'def' });
    expect(bus.liveBuffer(1, 'app/a.js')).toBe('abcdef');
    expect(bus.liveBuffer(1, 'other.js')).toBe('');
    bus.emit(1, { runId: null, event: 'file_end', path: 'app/a.js' });
    expect(bus.liveBuffer(1, 'app/a.js')).toBe('');
  });

  it('环形缓冲容量上限 500（超限丢最旧）', () => {
    const bus = new ProjectEventBus();
    for (let i = 0; i < 505; i += 1) bus.emit(1, { runId: null, event: 'message', content: String(i) });
    const all = bus.snapshotBuffer(1, 0);
    expect(all.length).toBe(500);
    expect(all[0]?.seq).toBe(6);
    expect(all.at(-1)?.seq).toBe(505);
  });

  it('订阅者抛错不影响 emit 与其他订阅者', () => {
    const bus = new ProjectEventBus();
    const good: number[] = [];
    bus.subscribe(1, () => {
      throw new Error('坏订阅者');
    });
    bus.subscribe(1, (e) => good.push(e.seq));
    expect(() => bus.emit(1, { runId: null, event: 'message', content: 'x' })).not.toThrow();
    expect(good).toEqual([1]);
  });

  it('重放路径同样隔离订阅者异常（不炸 SSE 路由的注册流程）', () => {
    const bus = new ProjectEventBus();
    bus.emit(1, { runId: null, event: 'message', content: 'a' });
    bus.emit(1, { runId: null, event: 'message', content: 'b' });
    const seen: string[] = [];
    expect(() =>
      bus.subscribe(
        1,
        (e) => {
          if (e.content === 'a') throw new Error('坏订阅者');
          seen.push(e.content ?? '');
        },
        0,
      ),
    ).not.toThrow();
    expect(seen).toEqual(['b']);
  });

  it('reasoning 事件是 ephemeral（T31）：订阅者实时收到、但不进环形缓冲与 liveBuffer；seq 照常占号', () => {
    const bus = new ProjectEventBus();
    const seen: string[] = [];
    bus.subscribe(1, (e) => seen.push(`${e.event}:${e.content ?? ''}`));

    bus.emit(1, { runId: null, event: 'agent_start', agent: 'pm', meta: { taskKey: 'pm-prd' } });
    const reasoning = bus.emit(1, { runId: null, event: 'reasoning', agent: 'pm', content: '先想清楚需求' });
    bus.emit(1, { runId: null, event: 'file_start', agent: 'pm', path: 'docs/prd.md' });
    bus.emit(1, { runId: null, event: 'delta', agent: 'pm', path: 'docs/prd.md', content: '# PRD' });

    // 实时推送照常到达
    expect(seen).toContain('reasoning:先想清楚需求');
    expect(reasoning.seq).toBe(2); // seq 单调分配（占号）
    // 但不进重放窗口、不进在流缓冲：快照里没有 reasoning，后续事件 seq 跳号（2 被思考流占用）
    expect(bus.snapshotBuffer(1, 0).map((e) => e.event)).toEqual(['agent_start', 'file_start', 'delta']);
    expect(bus.snapshotBuffer(1, 0).map((e) => e.seq)).toEqual([1, 3, 4]);
    expect(bus.liveBuffer(1, 'docs/prd.md')).toBe('# PRD');
  });

  it('error 事件清除该路径的 liveBuffer，其他路径不受影响', () => {
    const bus = new ProjectEventBus();
    bus.emit(1, { runId: null, event: 'file_start', path: 'a.js' });
    bus.emit(1, { runId: null, event: 'delta', path: 'a.js', content: 'x' });
    bus.emit(1, { runId: null, event: 'file_start', path: 'b.js' });
    bus.emit(1, { runId: null, event: 'delta', path: 'b.js', content: 'y' });
    bus.emit(1, { runId: null, event: 'error', agent: 'engineer', path: 'a.js', error: '校验失败' });
    expect(bus.liveBuffer(1, 'a.js')).toBe('');
    expect(bus.liveBuffer(1, 'b.js')).toBe('y');
  });

  it('release 显式清空缓冲/订阅者/在流文本；done 等正常收口不清', () => {
    const bus = new ProjectEventBus();
    const seen: number[] = [];
    bus.subscribe(1, (e) => seen.push(e.seq));
    bus.emit(1, { runId: null, event: 'file_start', path: 'a.js' });
    bus.emit(1, { runId: null, event: 'delta', path: 'a.js', content: 'x' });
    bus.emit(1, { runId: null, event: 'done' });
    // 正常收口不清：重放窗口与在流文本保持原样
    expect(bus.snapshotBuffer(1, 0).length).toBe(3);

    bus.release(1);
    expect(bus.snapshotBuffer(1, 0)).toEqual([]);
    expect(bus.liveBuffer(1, 'a.js')).toBe('');
    // release 后再使用 = 新桶（seq 从 1 重计），旧订阅者不再收到
    bus.emit(1, { runId: null, event: 'message', content: 'after' });
    expect(bus.snapshotBuffer(1, 0).length).toBe(1);
    expect(seen).toEqual([1, 2, 3]);
  });
});

/* ------------------------------------------------------------------ */
/* mock 全链路（brief Step 1）                                           */
/* ------------------------------------------------------------------ */

describe('startGeneration（mock 全链路）', () => {
  it('① 完整链路：事件序列 agent_start(pm)→file_start/delta/file_end→done；docs+app 落库；PROGRESS 为任务计划清单（任务级 [x] 在收尾段之前）', async () => {
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);
    // 首个事件到达时应处于 running（编排器注册态）
    const statusOnFirstEvent = new Promise<'idle' | 'running'>((resolve) => {
      const unsub = projectEventBus.subscribe(projectId, () => {
        unsub();
        resolve(orchestratorStatus(projectId));
      });
    });

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    // 状态机：运行中 running，结束后 idle
    expect(await statusOnFirstEvent).toBe('running');
    expect(orchestratorStatus(projectId)).toBe('idle');

    // seq 严格单调递增
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]?.seq).toBeGreaterThan(events[i - 1]?.seq ?? 0);
    }

    // 事件序列：首个 agent_start 是 pm；PRD 打字机流（file_start/delta/file_end）；工程师逐文件
    expect(mustFind(events, (e) => e.event === 'agent_start').agent).toBe('pm');
    expect(mustFind(events, (e) => e.event === 'file_start' && e.path === 'docs/prd.md').agent).toBe('pm');
    expect(mustFind(events, (e) => e.event === 'delta' && e.path === 'docs/prd.md').content?.length).toBeGreaterThan(0);
    expect(mustFind(events, (e) => e.event === 'file_end' && e.path === 'docs/prd.md').agent).toBe('pm');
    expect(mustFind(events, (e) => e.event === 'file_start' && e.path === 'app/backend/api.js').agent).toBe('engineer');
    expect(mustFind(events, (e) => e.event === 'delta' && e.path === 'app/backend/api.js').content?.length).toBeGreaterThan(0);
    // 工程师文件打字机来自 write_file 参数流：delta 拼接必须与落库内容一致（正文废话不混入文件）
    const apiDeltas = events.filter((e) => e.event === 'delta' && e.path === 'app/backend/api.js');
    const apiRow = (await storage.readAllFiles(projectId)).find((row) => row.path === 'app/backend/api.js');
    expect(apiDeltas.map((e) => e.content ?? '').join('')).toBe(apiRow?.content ?? '');
    expect(mustFind(events, (e) => e.event === 'file_end' && e.path === 'app/frontend/index.html').agent).toBe('engineer');
    // 架构师产物按 files 清单补发 file_start/file_end（无逐段 delta，T14 现状）
    expect(mustFind(events, (e) => e.event === 'file_end' && e.path === 'docs/system_design.md').agent).toBe('architect');
    // 收尾：done 是最后一条事件
    expect(events.at(-1)?.event).toBe('done');

    // files：docs/* + app/* + 进度/记忆文件
    const rows = await storage.readAllFiles(projectId);
    const paths = rows.map((row) => row.path);
    for (const path of [
      'docs/prd.md',
      'docs/system_design.md',
      'docs/architecture.mmd',
      'docs/file_tree.json',
      'app/backend/api.js',
      'app/frontend/index.html',
      'app/start_app.sh',
      PROGRESS_PATH,
      MEMORY_PATH,
    ]) {
      expect(paths).toContain(path);
    }
    // docs/ 归 PM/架构师所有：工程师不按树里重复出现的 docs 节点覆写 PRD
    const prd = await storage.getFile(projectId, 'docs/prd.md');
    expect(prd?.lastEditor).toBe('pm');

    // PROGRESS.md：任务计划清单——节标题 + 任务级打勾 + 勾选项在收尾段之前（2026-09-06 验收口径）
    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('## 任务计划（');
    expect(progress.content).toMatch(/^- \[x\] pm-prd（产品经理）/m);
    expect(progress.content).toMatch(/^- \[x\] architect-design（架构师）/m); // mock 链任务键（ARCHITECT_TASK_KEY 口径）
    expect(progress.content).toMatch(/^- \[x\] engineer-app（工程师）/m);
    expect(progress.content.indexOf('- [x]')).toBeLessThan(progress.content.indexOf(CLOSING_SECTION_HEADING));
    expect(progress.content).not.toMatch(/—— 🔄/m); // 全部完成，无进行中残留
    // 子任务拆解（大任务→小任务复选框）：PM/架构师/工程师的确定性交付物逐项打勾
    expect(progress.content).toMatch(/^  - \[x\] docs\/prd\.md（v\d+）$/m);
    expect((progress.content.match(/^  - \[x\] docs\//gm) ?? []).length).toBeGreaterThanOrEqual(8); // 架构师 8 交付物
    expect(progress.content).toMatch(/^  - \[x\] app\/backend\/api\.js（v\d+）$/m);

    // 项目收口：done；每任务前有检查点
    expect((await storage.getProject(projectId))?.status).toBe('done');
    const checkpoints = await storage.listCheckpoints(projectId);
    expect(checkpoints.some((cp) => cp.label === '任务前:pm-prd')).toBe(true);

    // ⑦ closer 汇报成为 assistant message + message 事件
    const messages = await storage.listMessages(projectId);
    expect(messages.some((m) => m.role === 'assistant' && m.content.includes('领导汇报'))).toBe(true);
    expect(mustFind(events, (e) => e.event === 'message' && (e.content ?? '').includes('领导汇报')).agent).toBe('leader');
  }, 30000);

  it('② 停止：stopProject 中途 → stopped 事件、status=paused、进行中任务标 stopped', async () => {
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);
    // PM 的 PRD file_end 一到就停（同步 abort，抢在架构师 provider 调用前生效）
    const unsub = projectEventBus.subscribe(projectId, (event) => {
      if (event.event === 'file_end' && event.path === 'docs/prd.md') {
        void stopProject(storage, projectId);
      }
    });

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    unsub();
    stop();

    expect(mustFind(events, (e) => e.event === 'stopped').event).toBe('stopped');
    expect(events.some((e) => e.event === 'done')).toBe(false);
    expect((await storage.getProject(projectId))?.status).toBe('paused');
    // 架构师任务开跑即中止 → agent_runs 标 stopped（停止语义，非失败）
    const runs = await storage.listAgentRuns(projectId);
    expect(runs.some((run) => run.agent === 'architect' && run.status === 'stopped')).toBe(true);
    // 已完成的 PRD 保留（停止不回滚）
    expect(await storage.getFile(projectId, 'docs/prd.md')).not.toBeNull();
  });

  it('③ 干预注入：intervention_injected 事件、deliveredAt 打戳、指令拼进 PM 上下文', async () => {
    const { storage, projectId } = await newProject('fast');
    await storage.addMessage({ projectId, role: 'intervention', content: '验收标准必须覆盖空列表场景' });
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'fast',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    expect(mustFind(events, (e) => e.event === 'intervention_injected' && (e.content ?? '').includes('空列表')).event).toBe(
      'intervention_injected',
    );
    // 队列语义：注入后 delivered_at 打戳（messages 断言）
    const messages = await storage.listMessages(projectId);
    const intervention = messages.find((m) => m.role === 'intervention');
    expect(intervention?.deliveredAt).not.toBeNull();
    // PM 收到的 requirement 含干预指令（角色无 interventions 参数 → 编排器拼进任务文本）
    expect(pmRequirements[0] ?? '').toContain('空列表');
    expect((await storage.getProject(projectId))?.status).toBe('done');
  });

  it('④ 单文件 hard×2：该文件 error 事件 + ❌ 进度行，后续文件继续，done 仍发出', async () => {
    engineerFailPaths.add('app/frontend/index.html');
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    const failed = mustFind(events, (e) => e.event === 'error' && e.path === 'app/frontend/index.html');
    expect(failed.agent).toBe('engineer');
    expect(failed.error ?? '').toContain('硬性违规');
    // 该文件 file_end 带 ok=false，但流程继续：下一文件照常、done 仍发出
    expect(mustFind(events, (e) => e.event === 'file_end' && e.path === 'app/frontend/index.html').meta?.ok).toBe(false);
    expect(mustFind(events, (e) => e.event === 'file_end' && e.path === 'app/start_app.sh').agent).toBe('engineer');
    expect(events.at(-1)?.event).toBe('done');
    expect((await storage.getProject(projectId))?.status).toBe('done');

    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('❌');
    expect(progress.content).toContain('app/frontend/index.html');
    // 失败子任务保持未勾选 + ❌ 注记（勾上 = 完成的语义边界）；成功文件照常打勾
    expect(progress.content).toMatch(/^  - \[ \] app\/frontend\/index\.html：❌ /m);
    expect(progress.content).toMatch(/^  - \[x\] app\/backend\/api\.js（v\d+）$/m);
  }, 30000);

  it('⑤ 环依赖 DAG：断环不死锁、警告入 run summary 与 PROGRESS、其余任务照常', async () => {
    cycleTasks = [
      { taskKey: 't1-prd', agent: 'pm', instruction: '产出 PRD', writesPaths: ['docs/'], dependsOn: ['t2-seo'] },
      { taskKey: 't2-seo', agent: 'seo', instruction: '产出 SEO 报告', writesPaths: ['docs/'], dependsOn: ['t1-prd'] },
      { taskKey: 't3-ads', agent: 'ads', instruction: '产出广告投放报告', writesPaths: ['docs/'], dependsOn: [] },
    ];
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    // 三个任务全部执行（不死锁）
    const rows = await storage.readAllFiles(projectId);
    const paths = rows.map((row) => row.path);
    expect(paths).toContain('docs/prd.md');
    expect(paths).toContain('docs/seo_report.md');
    expect(paths).toContain('docs/ads_report.md');
    expect(events.at(-1)?.event).toBe('done');

    // 警告留痕：run summary + PROGRESS
    const runs = await storage.listAgentRuns(projectId);
    expect(runs.some((run) => (run.summary ?? '').includes('环'))).toBe(true);
    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('环');
  });

  it('⑥ 并发 startGeneration 同项目：队列互斥串行（第二轮事件全部在第一轮 done 之后）', async () => {
    const { storage, projectId } = await newProject('fast');
    const { events, stop } = collectEvents(projectId);

    const first = startGeneration({
      storage,
      projectId,
      userMessage: '做一次 SEO 分析',
      mode: 'fast',
      mentions: ['seo'],
      signal: new AbortController().signal,
    });
    const second = startGeneration({
      storage,
      projectId,
      userMessage: '再出一份广告投放方案',
      mode: 'fast',
      mentions: ['ads'],
      signal: new AbortController().signal,
    });
    await Promise.all([first, second]);
    stop();

    const seqOf = (e: StreamEvent): number => e.seq;
    const seoSeqs = events.filter((e) => e.agent === 'seo').map(seqOf);
    const adsSeqs = events.filter((e) => e.agent === 'ads').map(seqOf);
    const firstDone = events.find((e) => e.event === 'done');
    if (firstDone === undefined) throw new Error('第一轮未发出 done');

    expect(Math.max(...seoSeqs)).toBeLessThan(firstDone.seq);
    expect(firstDone.seq).toBeLessThan(Math.min(...adsSeqs));
    // 两轮都各自收尾：两条 assistant 汇报、两个 done。@ 直派任务各补一条成员自身汇报
    // （T32 b 方案：seo 轮 + ads 轮各 1 条 agent-report）+ 1 条领导收尾 = 每轮 2 条
    expect(events.filter((e) => e.event === 'done').length).toBe(2);
    const messages = await storage.listMessages(projectId);
    expect(messages.filter((m) => m.role === 'assistant').length).toBe(4);
  });

  it('⑦ closer 汇报成为 assistant message（独立 @ 快速轮）', async () => {
    const { storage, projectId } = await newProject('fast');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: '做一次 SEO 分析',
      mode: 'fast',
      mentions: ['seo'],
      signal: new AbortController().signal,
    });
    stop();

    const messages = await storage.listMessages(projectId);
    const report = messages.find((m) => m.role === 'assistant' && m.content.includes('领导汇报'));
    expect(report).toBeDefined();
    expect(mustFind(events, (e) => e.event === 'message' && e.content === report?.content).agent).toBe('leader');
    expect((await storage.getProject(projectId))?.status).toBe('done');
  });

  it('⑧ 写后自审接入：每个成功文件 review 一次（拓扑序）；自审失败不阻断文件与整轮', async () => {
    reviewFailPaths.add('app/backend/api.js');
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    // 三个工程师目标文件（docs 节点跳过）各 review 一次，顺序 = file_tree 拓扑序
    expect(reviewPaths).toEqual(['app/backend/api.js', 'app/frontend/index.html', 'app/start_app.sh']);
    // 自审失败被吞：不发 error 事件、文件照常成功（file_end ok=true）、整轮照常 done
    expect(events.some((e) => e.event === 'error' && (e.error ?? '').includes('自审'))).toBe(false);
    expect(mustFind(events, (e) => e.event === 'file_end' && e.path === 'app/backend/api.js').meta?.ok).toBe(true);
    expect(events.at(-1)?.event).toBe('done');
    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('写后自审失败');
  }, 30000);

  it('⑩ 思考流直播（T31）：角色 LLM 调用发出 reasoning 事件（agent 归属该角色、runId 与同处事件一致）', async () => {
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    // 每个出场角色都有自己的思考流（mock 每次调用吐 2-3 段）
    for (const agent of ['leader', 'pm', 'architect', 'engineer'] as const) {
      const chunks = events.filter((e) => e.event === 'reasoning' && e.agent === agent);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
      for (const chunk of chunks) {
        expect(chunk.content ?? '').not.toBe('');
        expect(chunk.path).toBeUndefined(); // 思考流不带文件路径语义
      }
    }
    // 思考流落在该角色的任务窗口内：agent_start 之后、file_end（定版）之前
    const firstReasoningSeq = Math.min(...events.filter((e) => e.event === 'reasoning' && e.agent === 'pm').map((e) => e.seq));
    const prdStartSeq = mustFind(events, (e) => e.event === 'agent_start' && e.agent === 'pm').seq;
    const prdEndSeq = mustFind(events, (e) => e.event === 'file_end' && e.path === 'docs/prd.md').seq;
    expect(firstReasoningSeq).toBeGreaterThan(prdStartSeq);
    expect(firstReasoningSeq).toBeLessThan(prdEndSeq);
  }, 30000);

  it('⑪ 收尾边界也消费干预（T31）：任务执行期间到达的指令不再滞留队列', async () => {
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);
    // @ 直派 PM：本轮唯一任务 pm-prd 的边界检查先于任务执行——执行期间到达的干预，
    // 在修复前没有任何后续边界去取它（delivered_at 恒 null，用户侧永远「排队中」）
    midRoundEnqueue = async ({ storage: target, projectId: pid }) => {
      await target.addMessage({ projectId: pid, role: 'intervention', content: '汇报里请补一句下一步迭代方向' });
    };

    await startGeneration({
      storage,
      projectId,
      userMessage: '@产品经理 出一份 PRD',
      mode: 'full',
      mentions: ['pm'],
      signal: new AbortController().signal,
    });
    stop();

    // 收尾边界取走并注入：事件带 targetTask=leader-closing，队列打戳清空
    const closing = mustFind(
      events,
      (e) => e.event === 'intervention_injected' && e.meta?.targetTask === 'leader-closing',
    );
    expect((closing.content ?? '')).toContain('下一步迭代方向');
    const messages = await storage.listMessages(projectId);
    const pending = messages.filter((m) => m.role === 'intervention' && m.deliveredAt === null);
    expect(pending).toHaveLength(0);
  }, 30000);

  it('⑫ @直派成员自身名义汇报（T32）：任务级 agent_end 之后补一条 agent-report 消息（agent 归属 + messageId + 主产出路径）', async () => {
    const { storage, projectId } = await newProject('fast');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: '出一份 PRD',
      mode: 'fast',
      mentions: ['pm'],
      signal: new AbortController().signal,
    });
    stop();

    // 聊天事件：agent 字段指向被 @ 的成员（不是 leader）、messageId 回带（前端按正数 id 去重）
    const report = mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'agent-report');
    expect(report.agent).toBe('pm');
    expect(report.meta?.messageId).toBeGreaterThan(0);
    expect(report.meta?.path).toBe('docs/prd.md');
    // 正文形状：✅ + 角色中文名 + 完成语 + 主产出路径
    expect(report.content ?? '').toContain('✅');
    expect(report.content ?? '').toContain('产品经理');
    expect(report.content ?? '').toContain('docs/prd.md');

    // 落库：assistant 行 + meta（kind/agent/path），刷新后徽章与路径仍可还原
    const persisted = (await storage.listMessages(projectId)).find((m) => m.id === report.meta?.messageId);
    expect(persisted?.role).toBe('assistant');
    expect(persisted?.meta?.kind).toBe('agent-report');
    expect(persisted?.meta?.agent).toBe('pm');
    expect(persisted?.meta?.path).toBe('docs/prd.md');

    // 时序：在该任务的 agent_end 之后、领导收尾汇报之前（领导收尾卡仍是最后一条 assistant）
    const agentEndSeq = mustFind(events, (e) => e.event === 'agent_end' && e.agent === 'pm').seq;
    expect(report.seq).toBeGreaterThan(agentEndSeq);
    const closingSeq = mustFind(events, (e) => e.event === 'message' && (e.agent === 'leader' && (e.content ?? '').includes('领导汇报'))).seq;
    expect(report.seq).toBeLessThan(closingSeq);
    // 领导收尾汇报保留不动（多任务轮聚合视角）
    expect(events.some((e) => e.event === 'message' && (e.content ?? '').includes('领导汇报'))).toBe(true);
  }, 30000);

  it('⑬ 非 @直派任务不产生 agent-report 消息（T32：只有 user- 前缀任务键才补自身汇报）', async () => {
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    expect(events.some((e) => e.meta?.kind === 'agent-report')).toBe(false);
    // 领导收尾汇报照旧
    expect(events.some((e) => e.event === 'message' && (e.content ?? '').includes('领导汇报'))).toBe(true);
  }, 30000);

  it('⑭ @工程师直派汇报不虚构产物路径（T32 R1）：多文件交付且跳过 docs/，无主产出时省略路径子句', async () => {
    const { storage, projectId } = await newProject('fast');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: '把应用做出来',
      mode: 'fast',
      mentions: ['engineer'],
      signal: new AbortController().signal,
    });
    stop();

    const report = mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'agent-report');
    expect(report.agent).toBe('engineer');
    expect(report.content ?? '').toContain('✅');
    expect(report.content ?? '').toContain('工程师');
    // 关键：直派任务的 writesPaths 是 ['docs/','app/']，而工程师只写 app/*——
    // 不得拿前缀拼出「产物已写入 docs/」这种事实错误，也没有单一主产出可指
    expect(report.content ?? '').not.toContain('产物已写入');
    expect(report.content ?? '').not.toContain('docs/');
    expect(report.meta?.path).toBeUndefined();

    // 落库行同口径：不带 path
    const persisted = (await storage.listMessages(projectId)).find((m) => m.id === report.meta?.messageId);
    expect(persisted?.meta?.kind).toBe('agent-report');
    expect(persisted?.meta?.agent).toBe('engineer');
    expect(persisted?.meta?.path).toBeUndefined();
    // 正文仍有信息量：聚合摘要（成功 N 个）进了要点
    expect(report.content ?? '').toContain('要点：');
  }, 30000);

  it('⑨ 排队轮的请求断开不越界：只停本轮，在跑轮照常完成到 done', async () => {
    vi.stubEnv('LLM_MOCK_DELAY_MS', '20'); // 放慢在跑轮的流式，保证第二轮处于排队态时打断它
    const { storage, projectId } = await newProject('fast');
    const { events, stop } = collectEvents(projectId);
    const round2Signal = new AbortController();

    const first = startGeneration({
      storage,
      projectId,
      userMessage: '做一次 SEO 分析',
      mode: 'fast',
      mentions: ['seo'],
      signal: new AbortController().signal,
    });
    const second = startGeneration({
      storage,
      projectId,
      userMessage: '再出一份广告投放方案',
      mode: 'fast',
      mentions: ['ads'],
      signal: round2Signal.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 150)); // 第一轮仍在流式（SEO 报告 ~1s）
    round2Signal.abort(); // 第二轮的 HTTP 断开：不得越界打断第一轮
    await Promise.all([first, second]);
    stop();

    const firstDone = events.findIndex((e) => e.event === 'done');
    const stoppedAt = events.findIndex((e) => e.event === 'stopped');
    expect(firstDone).toBeGreaterThanOrEqual(0); // 在跑轮完整走完
    expect(stoppedAt).toBeGreaterThan(firstDone); // 停止只发生在第二轮开跑时
    expect(events.some((e) => e.agent === 'seo')).toBe(true); // 第一轮工作完整
    expect(events.some((e) => e.agent === 'ads')).toBe(false); // 第二轮未做任何工作
    expect(await storage.getFile(projectId, 'docs/seo_report.md')).not.toBeNull();
  }, 20000);
});

/* ------------------------------------------------------------------ */
/* T33 A：工程师树降级兜底                                                */
/* ------------------------------------------------------------------ */

/** 只派工程师、不派架构师的轮次（真模型 @直派单发语境跳过 docs/file_tree.json 的确定性复现） */
function engineerOnlyTasks(): TaskAssignment[] {
  return [
    { taskKey: 'eng-implement', agent: 'engineer', instruction: '开始实施', writesPaths: ['docs/', 'app/'], dependsOn: [] },
  ];
}

/** 内置降级模板树的全部路径（buildFastFileTree 的固定 4 节点） */
const FALLBACK_PATHS = ['app/backend/api.js', 'app/frontend/index.html', 'app/README.md', 'start_app.sh'];

describe('T33 A：工程师树降级（full 模式无 file_tree 不再整轮失败）', () => {
  it('无树 + 空项目：按内置模板树降级逐文件派发，PROGRESS ⚠ 留痕', async () => {
    cycleTasks = engineerOnlyTasks();
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    // 模板树 4 个文件全部照常生成（不再抛「工程师任务没有可用 file_tree」）
    for (const path of FALLBACK_PATHS) {
      expect(await storage.getFile(projectId, path)).not.toBeNull();
    }
    expect(mustFind(events, (e) => e.event === 'file_end' && e.path === 'app/backend/api.js').agent).toBe('engineer');
    expect(events.some((e) => e.event === 'error')).toBe(false);
    expect(events.at(-1)?.event).toBe('done');
    expect((await storage.getProject(projectId))?.status).toBe('done');

    // 降级语义显式留痕：PROGRESS ⚠ 行（新写 N 个文件）
    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('架构师未产出 file_tree');
    expect(progress.content).toContain('按内置模板树降级（新写 4 个文件）');
  }, 30000);

  it('无树 + app 文件已存在（迭代轮）：不覆盖既有文件，只补缺', async () => {
    cycleTasks = engineerOnlyTasks();
    const { storage, projectId } = await newProject('full');
    // 已生成的应用文件（迭代轮防模板覆盖：直接 upsert 会毁掉既有应用）
    await storage.upsertFile({ projectId, path: 'app/backend/api.js', content: '// 已生成的应用后端，勿动', editor: 'engineer' });
    await storage.upsertFile({ projectId, path: 'start_app.sh', content: '#!/bin/sh\necho 已有脚本', editor: 'engineer' });
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    // 既有文件原样保留（版本不涨 = 未被覆写）
    const api = await storage.getFile(projectId, 'app/backend/api.js');
    expect(api?.content).toBe('// 已生成的应用后端，勿动');
    expect(api?.version).toBe(1);
    const script = await storage.getFile(projectId, 'start_app.sh');
    expect(script?.content).toBe('#!/bin/sh\necho 已有脚本');
    expect(script?.version).toBe(1);
    // 缺的补上
    expect(await storage.getFile(projectId, 'app/frontend/index.html')).not.toBeNull();
    expect(await storage.getFile(projectId, 'app/README.md')).not.toBeNull();

    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('按内置模板树降级（新写 2 个文件）');
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);

  it('无树 + 模板文件全部已存在：幂等完成，不写任何文件', async () => {
    cycleTasks = engineerOnlyTasks();
    const { storage, projectId } = await newProject('full');
    for (const path of FALLBACK_PATHS) {
      await storage.upsertFile({ projectId, path, content: `// ${path} 已存在`, editor: 'engineer' });
    }
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    // 过滤后为空：任务正常完成（幂等语义），无单文件派发、无写入
    expect(events.some((e) => e.event === 'file_start' && e.agent === 'engineer')).toBe(false);
    for (const path of FALLBACK_PATHS) {
      const row = await storage.getFile(projectId, path);
      expect(row?.version).toBe(1);
      expect(row?.content).toBe(`// ${path} 已存在`);
    }
    expect(mustFind(events, (e) => e.event === 'agent_end' && e.agent === 'engineer').summary ?? '').toContain(
      '目标文件均已存在，无需新写',
    );
    expect(events.at(-1)?.event).toBe('done');
    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('目标文件均已存在，无需新写');
  }, 30000);
});

/* ------------------------------------------------------------------ */
/* T33 B/C：任务失败可见化 + closer 反谎报                                 */
/* ------------------------------------------------------------------ */

describe('T33 B/C：任务失败可见化（run 行 + ❌ 通报）与 closer 反谎报上下文', () => {
  it('@直派工程师前置失败：补插 failed run 行 + ❌ agent-report 通报 + closer 上下文带失败项', async () => {
    engineerThrowPaths.add('app/backend/api.js'); // 单文件任务开跑即抛、不建 run 行（前置失败形状）
    const { storage, projectId } = await newProject('fast');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: '把应用做出来',
      mode: 'fast',
      mentions: ['engineer'],
      signal: new AbortController().signal,
    });
    stop();

    // ① failed run 行：此前该路径无任何 run 行（时间线/快照无痕，用户看不到失败）
    const failedRun = (await storage.listAgentRuns(projectId)).find(
      (run) => run.taskKey === 'user-engineer-0' && run.agent === 'engineer',
    );
    expect(failedRun?.status).toBe('failed');
    expect(failedRun?.error ?? '').toContain('单文件任务执行失败');

    // ② ❌ 失败通报（T32 成功通报的失败变体）：agent 归属 + messageId 回带 + 失败标记
    const report = mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'agent-report');
    expect(report.agent).toBe('engineer');
    expect(report.meta?.messageId).toBeGreaterThan(0);
    expect(report.meta?.status).toBe('failed');
    expect(report.content ?? '').toContain('❌ 工程师：代码实现未完成——');
    expect(report.content ?? '').toContain('单文件任务执行失败');
    // 落库行同口径：assistant + kind/status，刷新后仍可还原
    const persisted = (await storage.listMessages(projectId)).find((m) => m.id === report.meta?.messageId);
    expect(persisted?.role).toBe('assistant');
    expect(persisted?.meta?.kind).toBe('agent-report');
    expect(persisted?.meta?.status).toBe('failed');

    // ③ 整轮仍收口 done（失败不中断），closer 上下文带结构化本轮结果
    expect(events.at(-1)?.event).toBe('done');
    const closerInput = closerInputs.at(-1);
    expect(closerInput?.roundOutcome).toBeDefined();
    expect(closerInput?.roundOutcome?.succeeded).toBe(0);
    expect(closerInput?.roundOutcome?.failed).toHaveLength(1);
    expect(closerInput?.roundOutcome?.failed[0]?.taskKey).toBe('user-engineer-0');
    expect(closerInput?.roundOutcome?.failed[0]?.reason).toContain('单文件任务执行失败');
  }, 30000);
});

/* ------------------------------------------------------------------ */
/* T34 A：fast 模板入口同一防覆写纪律                                     */
/* ------------------------------------------------------------------ */

describe('T34 A：fast 两条模板入口与 T33 full 降级同一防覆写过滤', () => {
  /**
   * fast 默认链（pm-lite → eng-code）的确定性替身：fast 模式没有架构师任务、
   * 库里因此没有持久化 file_tree——这正是「无持久化树」模板入口的真实形态。
   * 不用桩则 mock 领导 LLM 会分派整链（含架构师落 docs/file_tree.json），走的是持久化树分支。
   */
  function fastPipelineTasks(): TaskAssignment[] {
    return [
      { taskKey: 'pm-lite', agent: 'pm', instruction: '精简 PRD', writesPaths: ['docs/'], dependsOn: [] },
      { taskKey: 'eng-code', agent: 'engineer', instruction: '按内置模板实现', writesPaths: ['app/'], dependsOn: ['pm-lite'] },
    ];
  }

  it('fast 第二轮 @工程师：既有 4 文件不覆写（version 不涨、无单文件派发），幂等完成', async () => {
    const { storage, projectId } = await newProject('fast');
    // 第一轮：fast 默认链产出模板 4 文件（无架构师 → 库里无持久化树）
    cycleTasks = fastPipelineTasks();
    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'fast',
      mentions: [],
      signal: new AbortController().signal,
    });
    cycleTasks = null;
    const baseline = new Map<string, { version: number; content: string }>();
    for (const path of FALLBACK_PATHS) {
      const row = await storage.getFile(projectId, path);
      if (row === null) throw new Error(`第一轮未产出 ${path}`);
      baseline.set(path, { version: row.version, content: row.content });
    }

    // 第二轮：@工程师直派（迭代）——模板 4 文件全部命中既有文件，不得重新派发覆写
    const { events, stop } = collectEvents(projectId);
    await startGeneration({
      storage,
      projectId,
      userMessage: '再迭代一轮',
      mode: 'fast',
      mentions: ['engineer'],
      signal: new AbortController().signal,
    });
    stop();

    // 无任何工程师单文件派发（过滤后为空 → 幂等完成），既有产出原样保留
    expect(events.some((e) => e.event === 'file_start' && e.agent === 'engineer')).toBe(false);
    for (const path of FALLBACK_PATHS) {
      const row = await storage.getFile(projectId, path);
      const before = baseline.get(path);
      expect(row?.version).toBe(before?.version);
      expect(row?.content).toBe(before?.content);
    }
    expect(mustFind(events, (e) => e.event === 'agent_end' && e.agent === 'engineer').summary ?? '').toContain(
      '目标文件均已存在，无需新写',
    );
    expect(events.at(-1)?.event).toBe('done');
    expect((await progressRow(storage, projectId)).content).toContain('目标文件均已存在，无需新写');
  }, 30000);

  it('fast 无持久化树 + 部分模板文件已存在：只补缺，既有文件不覆写', async () => {
    cycleTasks = fastPipelineTasks();
    const { storage, projectId } = await newProject('fast');
    await storage.upsertFile({ projectId, path: 'app/README.md', content: '// 已生成的应用说明', editor: 'engineer' });
    await storage.upsertFile({ projectId, path: 'start_app.sh', content: '#!/bin/sh\necho 已有脚本', editor: 'engineer' });
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'fast',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    const readme = await storage.getFile(projectId, 'app/README.md');
    expect(readme?.content).toBe('// 已生成的应用说明');
    expect(readme?.version).toBe(1);
    const script = await storage.getFile(projectId, 'start_app.sh');
    expect(script?.content).toBe('#!/bin/sh\necho 已有脚本');
    expect(script?.version).toBe(1);
    // 缺的补上
    expect(await storage.getFile(projectId, 'app/backend/api.js')).not.toBeNull();
    expect(await storage.getFile(projectId, 'app/frontend/index.html')).not.toBeNull();
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);

  it('fast 本轮架构师树空回退 + 模板全部已存在：过滤后为空，幂等完成', async () => {
    architectEmptyTree = true;
    cycleTasks = [
      { taskKey: 'arch-design', agent: 'architect', instruction: '产出设计', writesPaths: ['docs/'], dependsOn: [] },
      { taskKey: 'eng-code', agent: 'engineer', instruction: '实现应用', writesPaths: ['app/'], dependsOn: ['arch-design'] },
    ];
    const { storage, projectId } = await newProject('fast');
    for (const path of FALLBACK_PATHS) {
      await storage.upsertFile({ projectId, path, content: `// ${path} 已存在`, editor: 'engineer' });
    }
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'fast',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    expect(events.some((e) => e.event === 'file_start' && e.agent === 'engineer')).toBe(false);
    for (const path of FALLBACK_PATHS) {
      const row = await storage.getFile(projectId, path);
      expect(row?.version).toBe(1);
      expect(row?.content).toBe(`// ${path} 已存在`);
    }
    expect(mustFind(events, (e) => e.event === 'agent_end' && e.agent === 'engineer').summary ?? '').toContain(
      '目标文件均已存在，无需新写',
    );
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);
});

/* ------------------------------------------------------------------ */
/* T34 B/C：closer 跳过口径 + 失败通报自兜底                              */
/* ------------------------------------------------------------------ */

describe('T34 B：closer 本轮结果带「跳过 K 项」口径', () => {
  it('渲染：跳过计数入行，级联后果与根因失败分开陈述', () => {
    const section = renderRoundOutcomeSection({
      succeeded: 1,
      skipped: 2,
      failed: [{ taskKey: 'eng-a', reason: '单文件任务执行失败' }],
    });
    expect(section).toContain('成功 1 项、失败 1 项、跳过 2 项');
    expect(section).toContain('失败：eng-a——单文件任务执行失败');
    expect(section).toContain('级联');
    expect(section).toContain('汇报纪律');
  });

  it('渲染：无跳过项时不出现「跳过」子句（零值不噪音）', () => {
    const section = renderRoundOutcomeSection({ succeeded: 2, skipped: 0, failed: [] });
    expect(section).toContain('成功 2 项、失败 0 项');
    expect(section).not.toContain('跳过');
  });

  it('编排器统计：前置失败 → 依赖任务级联跳过，closer 收到 failed=1 / skipped=1', async () => {
    engineerThrowPaths.add('app/backend/api.js');
    cycleTasks = [
      { taskKey: 'eng-a', agent: 'engineer', instruction: '先做后端', writesPaths: ['app/'], dependsOn: [] },
      { taskKey: 'pm-b', agent: 'pm', instruction: '再出文档', writesPaths: ['docs/'], dependsOn: ['eng-a'] },
    ];
    const { storage, projectId } = await newProject('full');
    const { events, stop } = collectEvents(projectId);

    await startGeneration({
      storage,
      projectId,
      userMessage: REQUIREMENT,
      mode: 'full',
      mentions: [],
      signal: new AbortController().signal,
    });
    stop();

    const outcome = closerInputs.at(-1)?.roundOutcome;
    expect(outcome?.failed.map((item) => item.taskKey)).toEqual(['eng-a']);
    expect(outcome?.skipped).toBe(1);
    expect(outcome?.succeeded).toBe(0);
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);
});

describe('T34 C：失败通报自兜底（落库失败不升级为整轮失败）', () => {
  it('@直派失败通报 addMessage 抛错：只 console.error，整轮仍收口 done', async () => {
    engineerThrowPaths.add('app/backend/api.js');
    const fresh = newTestStorage();
    const project = await fresh.createProject({ sessionId: 's', title: '待办应用', requirement: REQUIREMENT, mode: 'fast' });
    // 仅对「❌ 失败通报」抛错的透明存储桩（模拟落库故障）
    const brittleStorage: StorageProvider = new Proxy(fresh, {
      get(target, prop) {
        if (prop === 'addMessage') {
          return async (input: Parameters<StorageProvider['addMessage']>[0]) => {
            if (input.content.startsWith('❌')) throw new Error('模拟落库失败：磁盘 I/O 错误');
            return target.addMessage(input);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { events, stop } = collectEvents(project.id);
    try {
      await startGeneration({
        storage: brittleStorage,
        projectId: project.id,
        userMessage: '把应用做出来',
        mode: 'fast',
        mentions: ['engineer'],
        signal: new AbortController().signal,
      });
    } finally {
      stop();
      errorSpy.mockRestore();
    }

    // 任务级失败照常可见（error 事件 + failed run 行），但不再升级成整轮顶层失败
    expect(events.some((e) => e.event === 'error' && e.agent === 'engineer')).toBe(true);
    const failedRun = (await fresh.listAgentRuns(project.id)).find((run) => run.taskKey === 'user-engineer-0');
    expect(failedRun?.status).toBe('failed');
    expect(events.at(-1)?.event).toBe('done');
    expect((await fresh.getProject(project.id))?.status).toBe('done');
    // 通报落库失败只留日志（不静默吞），聊天区没有半截的失败通报行
    expect((await fresh.listMessages(project.id)).some((m) => m.meta?.status === 'failed')).toBe(false);
  }, 30000);
});
