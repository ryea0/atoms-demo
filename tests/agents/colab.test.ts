/**
 * 人机共编编排接线测试（Task 23，DESIGN §3.9 软锁裁决 / §3.5 两级干预边界 / SSE message messageId 契约）。
 *
 * 覆盖：
 * ① 工程师目标文件被人工软锁 → 该文件任务挂起 + 聊天区裁决消息（agent=leader、meta.kind=softlock、
 *    落库 assistant 行并回带 meta.messageId）；回复「稍后」→ 本轮跳过该文件且轮次照常收口
 * ② 回复「跳过」→ 该文件任务的 run 标 rolled_back（时间线可见，DESIGN §3.10）
 * ③ 回复「覆盖」→ 释放软锁并重跑该单文件任务（D1：单文件重试=重跑该单文件任务）
 * ④ 文件边界干预注入（§3.5 两级边界的文件级）：只进下一个文件任务的上下文，delivered_at 打戳，
 *    且 markDelivered 带项目作用域（CLAUDE.md 规则 9）
 * ⑤ message 事件 messageId 三处补齐（前端按正数 messageId 去重防重放重复）：
 *    领导中途回复（reply 分支 / tasks+reply 分支）+ 检查点回滚通知
 *
 * 失败/决策注入用透明模块桩（默认全透传），其余走 mock provider 真链路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectEventBus, type StreamEvent } from '@/lib/agents/events';
import { startGeneration, stopProject } from '@/lib/agents/orchestrator';
import { PROGRESS_PATH } from '@/lib/agents/roles/closer';
import type { LeaderDecision } from '@/lib/agents/roles/leader';
import { restoreCheckpointAndNotify } from '@/lib/projects/service';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

/* ------------------------------------------------------------------ */
/* 透明模块桩                                                            */
/* ------------------------------------------------------------------ */

/** 记录每个单文件任务收到的交接摘要（文件级干预注入断言用） */
const engineerSummaries: { path: string; designSummary: string }[] = [];
/** 非空则 routeLeader 直接返回该决策（中途回复注入用） */
let forcedDecision: LeaderDecision | null = null;

vi.mock('@/lib/agents/roles/engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/roles/engineer')>();
  return {
    ...actual,
    runEngineerFile: (ctx: import('@/lib/agents/roles/engineer').EngineerFileContext) => {
      engineerSummaries.push({ path: ctx.target.path, designSummary: ctx.designSummary });
      return actual.runEngineerFile(ctx);
    },
  };
});

vi.mock('@/lib/agents/roles/leader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/agents/roles/leader')>();
  return {
    ...actual,
    routeLeader: (input: import('@/lib/agents/roles/leader').RouteLeaderInput) =>
      forcedDecision === null ? actual.routeLeader(input) : Promise.resolve(forcedDecision),
  };
});

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

const REQUIREMENT = '做一个待办清单应用';
const LOCKED_PATH = 'app/backend/api.js';
const HUMAN_CONTENT = '/* 人工修改版：未保存的本地改动 */';

/** 当前测试的 storage（裁决注入器闭包用；每个用例重建） */
let storageRef: StorageProvider;

/** 独立内存库 + 新项目 + 已被人工持有软锁的目标文件 */
async function newProjectWithLock(mode: 'fast' | 'full' = 'fast'): Promise<{ storage: StorageProvider; projectId: number }> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's', title: '待办应用', requirement: REQUIREMENT, mode });
  const { fileId } = await storage.upsertFile({
    projectId: project.id,
    path: LOCKED_PATH,
    content: HUMAN_CONTENT,
    editor: 'human',
  });
  await storage.setSoftLock(project.id, fileId, true);
  return { storage, projectId: project.id };
}

/** 订阅项目事件总线收集全部事件 */
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

/**
 * 裁决注入器：裁决消息一出现就投递用户回复（模拟用户在聊天区点选项 → POST 干预）。
 * 返回 Promise 在回复落库后 resolve（保证轮询能立刻取到，缩短测试墙钟）。
 */
function replyOnRuling(projectId: number, content: string): () => void {
  const unsubscribe = projectEventBus.subscribe(projectId, (event) => {
    if (event.event === 'message' && event.meta?.kind === 'softlock') {
      void storageRef.addMessage({ projectId, role: 'intervention', content }).catch((error: unknown) => {
        console.error('[colab.test] 裁决回复写入失败：', error);
      });
    }
  });
  return unsubscribe;
}

async function runRound(storage: StorageProvider, projectId: number, userMessage = '把应用升级一下'): Promise<void> {
  await startGeneration({
    storage,
    projectId,
    userMessage,
    mode: 'fast',
    mentions: [],
    signal: new AbortController().signal,
  });
}

beforeEach(() => {
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
  vi.stubEnv('SOFT_LOCK_POLL_MS', '5'); // 裁决轮询加速（默认 250ms，生产语义不变）
  engineerSummaries.length = 0;
  forcedDecision = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* 软锁裁决（DESIGN §3.9 预防层）                                          */
/* ------------------------------------------------------------------ */

describe('软锁裁决', () => {
  it('① 软锁 → 挂起 + leader 裁决消息（落库并回带 messageId）；「稍后」→ 本轮跳过且轮次照常收口', async () => {
    const { storage, projectId } = await newProjectWithLock();
    storageRef = storage;
    const { events, stop } = collectEvents(projectId);
    const off = replyOnRuling(projectId, '稍后');

    await runRound(storage, projectId);
    off();
    stop();

    // 裁决消息：agent=leader、文案含三个选项、meta 带 kind/path/messageId
    const ruling = mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'softlock');
    expect(ruling.agent).toBe('leader');
    expect(ruling.content).toBe(`检测到你正在编辑 ${LOCKED_PATH}：保留你的修改并跳过 / 覆盖生成 / 完成编辑后继续`);
    expect(ruling.path).toBe(LOCKED_PATH);
    const messageId = ruling.meta?.messageId;
    expect(typeof messageId).toBe('number');
    expect(messageId).toBeGreaterThan(0);

    // 裁决消息落库为 assistant 行（刷新后聊天区仍在），meta.kind 一并持久化
    const messages = await storage.listMessages(projectId);
    const persisted = messages.find((m) => m.id === messageId);
    expect(persisted?.role).toBe('assistant');
    expect(persisted?.meta?.kind).toBe('softlock');
    expect(persisted?.meta?.path).toBe(LOCKED_PATH);

    // 「稍后」= 不动：人工内容保留、该文件任务未执行、轮次照常收口
    const row = await storage.getFile(projectId, LOCKED_PATH);
    expect(row?.content).toBe(HUMAN_CONTENT);
    expect(row?.lastEditor).toBe('human');
    const runs = await storage.listAgentRuns(projectId);
    expect(runs.some((r) => r.taskKey === `engineer:${LOCKED_PATH}`)).toBe(false);
    expect(events.at(-1)?.event).toBe('done');
    expect((await storage.getProject(projectId))?.status).toBe('done');

    // 挂起留痕 PROGRESS（⏸）
    const progress = await storage.getFile(projectId, PROGRESS_PATH);
    expect(progress?.content).toContain(LOCKED_PATH);

    // 裁决回复按干预语义打戳（队列清空）
    const reply = messages.find((m) => m.role === 'intervention' && m.content === '稍后');
    expect(reply?.deliveredAt).not.toBeNull();
  }, 30000);

  it('② 「跳过」→ 该文件任务的 run 标 rolled_back（时间线可见），人工内容保留', async () => {
    const { storage, projectId } = await newProjectWithLock();
    storageRef = storage;
    const { events, stop } = collectEvents(projectId);
    const off = replyOnRuling(projectId, '跳过');

    await runRound(storage, projectId);
    off();
    stop();

    expect(mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'softlock').event).toBe('message');
    const runs = await storage.listAgentRuns(projectId);
    const skipped = runs.find((r) => r.taskKey === `engineer:${LOCKED_PATH}`);
    expect(skipped?.status).toBe('rolled_back');
    expect((await storage.getFile(projectId, LOCKED_PATH))?.content).toBe(HUMAN_CONTENT);
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);

  it('③ 「覆盖」→ 释放软锁并重跑该单文件任务（agent 覆写，软锁清单清空）', async () => {
    const { storage, projectId } = await newProjectWithLock();
    storageRef = storage;
    const { events, stop } = collectEvents(projectId);
    const off = replyOnRuling(projectId, '覆盖');

    await runRound(storage, projectId);
    off();
    stop();

    // 重跑该单文件任务：裁决消息之后才出现该路径的 file_start
    const rulingSeq = mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'softlock').seq;
    const rerun = mustFind(events, (e) => e.event === 'file_start' && e.path === LOCKED_PATH && e.seq > rulingSeq);
    expect(rerun.agent).toBe('engineer');

    // agent 覆写落库，软锁解除
    const row = await storage.getFile(projectId, LOCKED_PATH);
    expect(row?.content).not.toBe(HUMAN_CONTENT);
    expect(row?.lastEditor).toBe('engineer');
    expect((await storage.getSoftLockedFiles(projectId)).some((f) => f.path === LOCKED_PATH)).toBe(false);
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);

  it('④ 无回复且锁仍在 → 等待期间不写该文件；停止可收口（stopped + paused）', async () => {
    const { storage, projectId } = await newProjectWithLock();
    storageRef = storage;
    const { events } = collectEvents(projectId);

    const round = runRound(storage, projectId);
    await new Promise((resolve) => setTimeout(resolve, 60)); // 已进入裁决等待
    await stopProject(storage, projectId);
    await round;

    expect(mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'softlock').event).toBe('message');
    expect(mustFind(events, (e) => e.event === 'stopped').event).toBe('stopped');
    expect(events.some((e) => e.event === 'done')).toBe(false);
    expect((await storage.getProject(projectId))?.status).toBe('paused');
    expect((await storage.getFile(projectId, LOCKED_PATH))?.content).toBe(HUMAN_CONTENT);
  }, 30000);

  it('⑤ 编辑能力开关关闭 → 持锁文件照常生成（agent 永不遇软锁，DESIGN §3.9）', async () => {
    const { storage, projectId } = await newProjectWithLock();
    storageRef = storage;
    await storage.setPreference('session', 's', { editing_enabled: false, default_mode: 'fast' });
    const { events, stop } = collectEvents(projectId);

    await runRound(storage, projectId);
    stop();

    expect(events.some((e) => e.event === 'message' && e.meta?.kind === 'softlock')).toBe(false);
    expect((await storage.getFile(projectId, LOCKED_PATH))?.lastEditor).toBe('engineer');
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);

  it('⑥ 锁定文件裁决为「稍后」时，已排队的干预不被吞：下一文件边界照常注入（T23 R1 回归）', async () => {
    const { storage, projectId } = await newProjectWithLock();
    storageRef = storage;
    const { events, stop } = collectEvents(projectId);

    // 工程师任务开跑（任务边界已收口完毕）才排队干预 → 只会到达文件边界
    const offIntake = projectEventBus.subscribe(projectId, (event) => {
      if (event.event === 'agent_start' && event.agent === 'engineer') {
        void storageRef.addMessage({ projectId, role: 'intervention', content: '下一个文件必须包含空态提示' });
      }
    });

    // 裁决消息发出的瞬间读库：该时刻干预必须仍是待注入（delivered_at IS NULL）——
    // 若边界顺序反了（先取干预后查软锁），此刻它已被打戳「注入」进从未运行的锁定文件任务
    let resolvePending: (value: boolean) => void = () => undefined;
    const pendingCheck = new Promise<boolean>((resolve) => {
      resolvePending = resolve;
    });
    const offProbe = projectEventBus.subscribe(projectId, (event) => {
      if (event.event === 'message' && event.meta?.kind === 'softlock') {
        void storageRef.listMessages(projectId).then((rows) => {
          const row = rows.find((m) => m.role === 'intervention' && m.content.includes('空态提示'));
          resolvePending(row?.deliveredAt === null);
        });
      }
    });

    const offRuling = replyOnRuling(projectId, '稍后');
    await runRound(storage, projectId);
    offRuling();
    offIntake();
    offProbe();
    stop();

    expect(await pendingCheck).toBe(true); // 未在锁定文件边界被吞
    expect(events.some((e) => e.event === 'intervention_injected' && e.meta?.targetTask === `engineer:${LOCKED_PATH}`)).toBe(false);

    // 下一文件边界正常注入：事件指向 index.html、指令进入其任务上下文
    const injected = mustFind(events, (e) => e.event === 'intervention_injected' && (e.content ?? '').includes('空态提示'));
    expect(injected.meta?.targetTask).toBe('engineer:app/frontend/index.html');
    const htmlCall = engineerSummaries.find((item) => item.path === 'app/frontend/index.html');
    expect(htmlCall?.designSummary ?? '').toContain('空态提示');

    // 锁定文件本身仍按「稍后」处置：人工内容保留
    expect((await storage.getFile(projectId, LOCKED_PATH))?.content).toBe(HUMAN_CONTENT);
    // 干预最终在 index.html 边界被消费（打戳），没有滞留队列也没有消失
    const messages = await storage.listMessages(projectId);
    expect(messages.find((m) => m.role === 'intervention' && m.content.includes('空态提示'))?.deliveredAt).not.toBeNull();
    expect(events.at(-1)?.event).toBe('done');
  }, 30000);
});

/* ------------------------------------------------------------------ */
/* 文件级干预注入（DESIGN §3.5 两级边界）                                  */
/* ------------------------------------------------------------------ */

describe('文件级干预注入', () => {
  it('⑤ 文件完成间到达的干预只进下一个文件任务的上下文，打戳且 markDelivered 带项目作用域', async () => {
    const { storage, projectId } = await newProjectWithLock();
    storageRef = storage;
    // 先解除软锁：本用例只关心干预注入路径
    const locked = await storage.getFile(projectId, LOCKED_PATH);
    if (locked !== null) await storage.setSoftLock(projectId, locked.id, false);

    const markDelivered = vi.spyOn(storage, 'markDelivered');
    const { events, stop } = collectEvents(projectId);
    const off = projectEventBus.subscribe(projectId, (event) => {
      if (event.event === 'file_end' && event.path === LOCKED_PATH) {
        void storageRef.addMessage({ projectId, role: 'intervention', content: '下一个文件必须包含空态提示' });
      }
    });

    await runRound(storage, projectId);
    off();
    stop();

    // 只注入到下一个文件（index.html）任务的上下文，前一个文件（api.js）不受影响
    const apiCall = engineerSummaries.find((item) => item.path === LOCKED_PATH);
    const htmlCall = engineerSummaries.find((item) => item.path === 'app/frontend/index.html');
    expect(apiCall?.designSummary ?? '').not.toContain('空态提示');
    expect(htmlCall?.designSummary ?? '').toContain('空态提示');

    // 事件带目标任务与 messageId；干预打戳；作用域参数为 projectId（规则 9）
    const injected = mustFind(
      events,
      (e) => e.event === 'intervention_injected' && (e.content ?? '').includes('空态提示'),
    );
    expect(injected.meta?.targetTask).toBe('engineer:app/frontend/index.html');
    expect(injected.meta?.messageId).toBeGreaterThan(0);
    expect(markDelivered).toHaveBeenCalled();
    const lastCall = markDelivered.mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(projectId);

    const messages = await storage.listMessages(projectId);
    const intervention = messages.find((m) => m.role === 'intervention');
    expect(intervention?.deliveredAt).not.toBeNull();
  }, 30000);
});

/* ------------------------------------------------------------------ */
/* message 事件 messageId 契约（前端按正数 messageId 去重）                */
/* ------------------------------------------------------------------ */

describe('message 事件 messageId', () => {
  it('⑥ 领导中途回复（reply 分支）落库并回带 meta.messageId', async () => {
    const storage = newTestStorage();
    const project = await storage.createProject({
      sessionId: 's',
      title: '待办应用',
      requirement: REQUIREMENT,
      mode: 'fast',
    });
    storageRef = storage;
    forcedDecision = { kind: 'reply', reply: '不需要产出文件：直接回答你的问题。' };
    const { events, stop } = collectEvents(project.id);

    await runRound(storage, project.id, '什么是 REST？');
    stop();

    const reply = mustFind(events, (e) => e.event === 'message' && (e.content ?? '').includes('直接回答你的问题'));
    expect(reply.agent).toBe('leader');
    const id = reply.meta?.messageId;
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    const persisted = (await storage.listMessages(project.id)).find((m) => m.id === id);
    expect(persisted?.role).toBe('assistant');
    expect(persisted?.content).toBe(reply.content);
  }, 30000);

  it('⑦ 分派附带的领导说明（tasks+reply 分支）同样回带 meta.messageId', async () => {
    const storage = newTestStorage();
    const project = await storage.createProject({
      sessionId: 's',
      title: '待办应用',
      requirement: REQUIREMENT,
      mode: 'fast',
    });
    storageRef = storage;
    forcedDecision = {
      kind: 'tasks',
      tasks: [
        {
          taskKey: 't1-seo',
          agent: 'seo',
          instruction: '产出 SEO 报告',
          writesPaths: ['docs/'],
          dependsOn: [],
        },
      ],
      reply: '先给你一句话说明，再派 SEO 分析。',
    };
    const { events, stop } = collectEvents(project.id);

    await runRound(storage, project.id, '做一次 SEO 分析');
    stop();

    const note = mustFind(events, (e) => e.event === 'message' && (e.content ?? '').includes('先给你一句话说明'));
    const id = note.meta?.messageId;
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    const persisted = (await storage.listMessages(project.id)).find((m) => m.id === id);
    expect(persisted?.role).toBe('assistant');

    // 分派分支仍照常收口
    expect(events.at(-1)?.event).toBe('done');
    expect((await storage.getFile(project.id, 'docs/seo_report.md'))).not.toBeNull();
  }, 30000);

  it('⑧ 检查点回滚通知（service 层）落库并回带 meta.messageId', async () => {
    const storage = newTestStorage();
    const project = await storage.createProject({
      sessionId: 's',
      title: '待办应用',
      requirement: REQUIREMENT,
      mode: 'fast',
    });
    const cpId = await storage.createCheckpoint(project.id, '任务前:pm-prd', null, 0);
    const { events, stop } = collectEvents(project.id);

    await restoreCheckpointAndNotify(storage, project.id, cpId);
    stop();

    const notice = mustFind(events, (e) => e.event === 'message' && e.meta?.kind === 'restore');
    expect(notice.agent).toBe('leader');
    const id = notice.meta?.messageId;
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
    const persisted = (await storage.listMessages(project.id)).find((m) => m.id === id);
    expect(persisted?.role).toBe('assistant');
    expect(persisted?.content).toBe(notice.content);
  }, 30000);
});
