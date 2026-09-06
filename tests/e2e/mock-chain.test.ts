/**
 * mock 全链路集成（Task 25 brief Step 1：项目交付前的端到端回归）。
 *
 * 不 mock 任何业务模块：newTestStorage（内存 SQLite）+ mock provider（LLM_PROVIDER=mock）
 * → startGeneration → 断言「事件序列完整、落库齐全、计量在账、预览可装配、
 * 单文件可重试、检查点可回滚」。这条链是发布前的最小验收面。
 *
 * 事件顺序（fast 模式，串行 DAG）：
 *   message(user) → [pm: agent_start → file_start → delta* → file_end → agent_end]
 *   → [architect: …] → [engineer: 每文件 file_start → delta* → file_end] → agent_end(engineer)
 *   → agent_start(leader 收尾) → agent_end(leader) → message(assistant 汇报) → done
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectEventBus, type StreamEvent } from '@/lib/agents/events';
import { startGeneration } from '@/lib/agents/orchestrator';
import { MEMORY_PATH, PROGRESS_PATH } from '@/lib/agents/roles/closer';
import { regenerateFile, restoreCheckpointAndNotify } from '@/lib/projects/service';
import { assemblePreview } from '@/lib/preview/assemble';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

const REQUIREMENT = '做一个待办清单';
const PROJECT_TITLE = '待办清单（e2e）';

/** 事件收集器（订阅总线实时事件） */
function collectEvents(projectId: number): { events: StreamEvent[]; stop: () => void } {
  const events: StreamEvent[] = [];
  const stop = projectEventBus.subscribe(projectId, (event) => events.push(event));
  return { events, stop };
}

/** 取第一个匹配事件的下标（缺失显式失败，避免 -1 伪装成顺序正确） */
function indexOfEvent(events: readonly StreamEvent[], predicate: (event: StreamEvent) => boolean): number {
  const index = events.findIndex(predicate);
  if (index < 0) throw new Error('预期存在匹配事件，实际未发出');
  return index;
}

let projectId = -1;
let storage: StorageProvider;

beforeEach(() => {
  vi.stubEnv('LLM_PROVIDER', 'mock');
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
  storage = newTestStorage();
});

afterEach(async () => {
  if (projectId > 0) projectEventBus.release(projectId);
  projectId = -1;
  vi.unstubAllEnvs();
});

describe('mock 全链路（fast）', () => {
  it('生成 → 事件序列完整 → 落库/计量/预览/重试/回滚 全部成立', async () => {
    /* ---------------- ① 建项目 + 起一轮生成 ---------------- */
    const project = await storage.createProject({
      sessionId: 'e2e',
      title: PROJECT_TITLE,
      requirement: REQUIREMENT,
      mode: 'fast',
    });
    projectId = project.id;
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

    /* ---------------- ② 事件序列：顺序 + 关键字段 ---------------- */
    // 首事件 = 用户消息（落库行 id 回带，前端按正数 id 去重）
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.event).toBe('message');
    expect(events[0]?.meta?.role).toBe('user');
    expect(events[0]?.meta?.messageId).toBeGreaterThan(0);
    expect(events.at(-1)?.event).toBe('done');

    // seq 单调递增且全部归属本项目（防串台）
    for (const [index, event] of events.entries()) {
      expect(event.projectId, `events[${index}] 项目归属`).toBe(projectId);
      if (index > 0) expect(event.seq, `events[${index}] seq 单调`).toBeGreaterThan(events[index - 1]?.seq ?? 0);
    }

    // 每个执行角色：agent_start → file_start(+delta) → file_end → agent_end。
    // 架构师是单发产出（无逐段 delta，T14 契约），因此 delta 只对 PM/工程师断言。
    const firstIndexOf = (predicate: (event: StreamEvent) => boolean): number => indexOfEvent(events, predicate);
    const rolesNeedingDelta: readonly ('pm' | 'engineer')[] = ['pm', 'engineer'];
    for (const role of ['pm', 'architect', 'engineer'] as const) {
      const start = firstIndexOf((e) => e.event === 'agent_start' && e.agent === role);
      const fileStart = firstIndexOf((e) => e.event === 'file_start' && e.agent === role);
      const fileEnd = firstIndexOf((e) => e.event === 'file_end' && e.agent === role);
      const end = firstIndexOf((e) => e.event === 'agent_end' && e.agent === role);
      expect(start, `${role} start 在 file_start 前`).toBeLessThan(fileStart);
      expect(fileEnd, `${role} file_end 在 agent_end 前`).toBeLessThan(end);
      if (!rolesNeedingDelta.includes(role as 'pm' | 'engineer')) continue;
      const delta = firstIndexOf((e) => e.event === 'delta' && e.agent === role);
      expect(fileStart, `${role} file_start 在 delta 前`).toBeLessThan(delta);
      expect(delta, `${role} delta 在 file_end 前`).toBeLessThan(fileEnd);
    }
    // 收尾段：leader 收尾 run → 汇报消息 → done
    const leaderStart = firstIndexOf((e) => e.event === 'agent_start' && e.agent === 'leader');
    const leaderEnd = firstIndexOf((e) => e.event === 'agent_end' && e.agent === 'leader');
    const closingReport = firstIndexOf((e) => e.event === 'message' && e.meta?.role === 'assistant');
    expect(leaderStart).toBeLessThan(leaderEnd);
    expect(leaderEnd).toBeLessThan(closingReport);
    expect(closingReport).toBeLessThan(events.length - 1); // done 收尾

    // 关键字段：start 带任务键、end 带交接摘要、file_end 带落库版本号、delta 带增量文本
    const pmStart = events.find((e) => e.event === 'agent_start' && e.agent === 'pm');
    expect(pmStart?.meta?.taskKey).toBeTruthy();
    const pmEnd = events.find((e) => e.event === 'agent_end' && e.agent === 'pm');
    expect(typeof pmEnd?.summary).toBe('string');
    expect((pmEnd?.summary ?? '').length).toBeGreaterThan(0);
    const fileEnds = events.filter((e) => e.event === 'file_end');
    expect(fileEnds.length).toBeGreaterThan(0);
    for (const event of fileEnds) {
      expect(typeof event.path).toBe('string');
      expect(event.meta?.version ?? 0).toBeGreaterThan(0);
    }
    const deltas = events.filter((e) => e.event === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    for (const event of deltas) expect(event.path).toBeDefined();

    /* ---------------- ③ 落库：文件树 / 进度与记忆 / 汇报消息 ---------------- */
    const paths = (await storage.listFiles(projectId)).map((row) => row.path);
    expect(paths).toContain('docs/prd.md');
    expect(paths).toContain('docs/system_design.md');
    expect(paths).toContain('app/frontend/index.html');
    expect(paths).toContain('app/backend/api.js');

    expect(await storage.getFile(projectId, PROGRESS_PATH)).not.toBeNull();
    const memory = await storage.getFile(projectId, MEMORY_PATH);
    expect(memory?.content ?? '').toContain('MEMORY');

    const messages = await storage.listMessages(projectId);
    expect(messages.some((m) => m.role === 'user' && m.content === REQUIREMENT)).toBe(true);
    expect(messages.some((m) => m.role === 'assistant')).toBe(true);

    /* ---------------- ④ 计量：llm_calls 有记录（聚合行 calls>0） ---------------- */
    const usage = await storage.usageByProject(projectId);
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.reduce((acc, row) => acc + row.calls, 0)).toBeGreaterThan(0);
    expect(usage.reduce((acc, row) => acc + row.tokens, 0)).toBeGreaterThan(0);

    /* ---------------- ⑤ 预览：装配含垫片（api.js 内联 + fetch 拦截） ---------------- */
    const assembly = await assemblePreview(storage, projectId);
    expect(assembly.ok).toBe(true);
    if (assembly.ok) {
      expect(assembly.html).toContain('__ATOMS_BACKEND__');
      expect(assembly.html).toContain('window.fetch');
    }

    /* ---------------- ⑥ 单文件重试（D1：重跑该单文件任务） ---------------- */
    const before = await storage.getFile(projectId, 'app/frontend/index.html');
    if (before === null) throw new Error('index.html 未生成');
    const beforeVersion = before.version;
    const { events: regenEvents, stop: stopRegen } = collectEvents(projectId);
    const regenResult = await regenerateFile(storage, projectId, before, new AbortController().signal);
    stopRegen();

    expect(regenResult.path).toBe('app/frontend/index.html');
    expect(regenResult.ok).toBe(true);
    expect(regenResult.version).toBeGreaterThan(beforeVersion);
    // 事件契约与编排器一致：agent_start → file_start → delta → file_end → agent_end
    const regenStart = indexOfEvent(regenEvents, (e) => e.event === 'agent_start' && e.agent === 'engineer');
    const regenFileStart = indexOfEvent(regenEvents, (e) => e.event === 'file_start' && e.path === 'app/frontend/index.html');
    const regenDelta = indexOfEvent(regenEvents, (e) => e.event === 'delta' && e.path === 'app/frontend/index.html');
    const regenFileEnd = indexOfEvent(regenEvents, (e) => e.event === 'file_end' && e.path === 'app/frontend/index.html');
    const regenEnd = indexOfEvent(regenEvents, (e) => e.event === 'agent_end' && e.agent === 'engineer');
    expect(regenStart).toBeLessThan(regenFileStart);
    expect(regenFileStart).toBeLessThan(regenDelta);
    expect(regenDelta).toBeLessThan(regenFileEnd);
    expect(regenFileEnd).toBeLessThan(regenEnd);
    expect(regenEvents[regenFileEnd]?.meta?.version).toBe(regenResult.version);
    // 思考流与轮次行为一致（T32 M3）：重试也透传 reasoning（agent=engineer、落在任务窗口内）
    const reasoningIndexes = regenEvents
      .map((event, index) => (event.event === 'reasoning' && event.agent === 'engineer' ? index : -1))
      .filter((index) => index >= 0);
    expect(reasoningIndexes.length).toBeGreaterThanOrEqual(1);
    expect(reasoningIndexes[0]).toBeGreaterThan(regenStart);
    expect(reasoningIndexes.at(-1)).toBeLessThan(regenEnd);

    /* ---------------- ⑦ 检查点回滚：内容恢复 + 任务标 rolled_back ---------------- */
    // docs/prd.md 在 pm 任务后定版且不再被改写：取工程师任务前的检查点即可校验内容恢复
    const prdBefore = await storage.getFile(projectId, 'docs/prd.md');
    if (prdBefore === null) throw new Error('docs/prd.md 未生成');
    const prdContent = prdBefore.content;

    const checkpoints = await storage.listCheckpoints(projectId);
    expect(checkpoints.length).toBeGreaterThan(0);
    const target = checkpoints.find((cp) => cp.afterRunId > 0);
    if (target === undefined) throw new Error('没有 afterRunId>0 的检查点（任务前打点缺失）');

    // 模拟检查点之后的人工/agent 改动 → 回滚 → 内容恢复、版本推进
    await storage.upsertFile({ projectId, path: 'docs/prd.md', content: '回滚前被改坏的内容', editor: 'human' });
    const { events: restoreEvents, stop: stopRestore } = collectEvents(projectId);
    const affected = await restoreCheckpointAndNotify(storage, projectId, target.id);
    stopRestore(); // emit 同步完成，返回时事件已全部入收集器

    expect(affected.length).toBeGreaterThan(0);
    const prdRestored = await storage.getFile(projectId, 'docs/prd.md');
    expect(prdRestored?.content).toBe(prdContent);
    expect(prdRestored?.version).toBeGreaterThan(1); // 覆盖写入照常归档 +1
    // 检查点之后的任务全部标 rolled_back（含工程师/收尾），时间线可见
    const runs = await storage.listAgentRuns(projectId);
    expect(runs.some((run) => run.status === 'rolled_back' && run.id > target.afterRunId)).toBe(true);
    // 回滚通知落库 + SSE message（meta.kind=restore，前端渲染回滚通知卡）
    const restoreMessage = restoreEvents.find((e) => e.event === 'message' && e.meta?.kind === 'restore');
    expect(restoreMessage?.meta?.messageId).toBeGreaterThan(0);
    const persisted = (await storage.listMessages(projectId)).find((m) => m.id === restoreMessage?.meta?.messageId);
    expect(persisted?.role).toBe('assistant');
    expect(persisted?.content).toContain('已回滚到检查点');
  }, 60000);
});
