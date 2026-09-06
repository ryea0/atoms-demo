/**
 * 编排器测试（Task 15，DESIGN §3.3 串行 DAG / §3.5 干预与停止 / §3.6 SSE 协议 / §3.10 检查点）。
 *
 * brief Step 1 用例（mock 全链路）：
 * ① 建项目→startGeneration→事件序列 agent_start(pm)…file_start…delta…file_end…done；
 *    files 最终含 docs/* + app/*；PROGRESS.md 含 ✅ 且在收尾段之前
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
import { CLOSING_SECTION_HEADING, MEMORY_PATH, PROGRESS_PATH } from '@/lib/agents/roles/closer';
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
/** 记录写后自审被调用的文件路径（接线断言用） */
const reviewPaths: string[] = [];
/** 这些路径的写后自审直接抛错（自审失败不阻断的断言用） */
const reviewFailPaths = new Set<string>();
/** 非空则 routeLeader 返回这份 DAG（环依赖注入用） */
let cycleTasks: TaskAssignment[] | null = null;
/** 非空则在 PM 任务执行中途调用（模拟「任务跑着的时候用户发来干预」，T31 Commit C） */
let midRoundEnqueue: ((ctx: { storage: StorageProvider; projectId: number }) => Promise<void>) | null = null;

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
  reviewPaths.length = 0;
  reviewFailPaths.clear();
  cycleTasks = null;
  midRoundEnqueue = null;
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
  it('① 完整链路：事件序列 agent_start(pm)→file_start/delta/file_end→done；docs+app 落库；PROGRESS ✅ 在收尾段之前', async () => {
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

    // PROGRESS.md：存在、含 ✅、进度行在领导汇报段之前
    const progress = await progressRow(storage, projectId);
    expect(progress.content).toContain('✅');
    expect(progress.content.indexOf('✅')).toBeLessThan(progress.content.indexOf(CLOSING_SECTION_HEADING));

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
    // 两轮都各自收尾：两条 assistant 汇报、两个 done
    expect(events.filter((e) => e.event === 'done').length).toBe(2);
    const messages = await storage.listMessages(projectId);
    expect(messages.filter((m) => m.role === 'assistant').length).toBe(2);
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
