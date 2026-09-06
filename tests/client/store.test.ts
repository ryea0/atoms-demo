/**
 * Task 17 测试：客户端 workspace store（SSE 事件分流 / 快照幂等恢复）+ 基础组件渲染冒烟。
 *
 * store 用合成 StreamEvent 序列直喂（不经网络）；组件层 mock fetch 与 next/navigation，
 * 只断言关键元素渲染与提交请求（jsdom 无 EventSource，连接细节由工作台任务集成验证）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StreamEvent } from '@/lib/agents/events';
import { roleOrder, roleRegistry } from '@/lib/agents/registry';
import type { AgentRun, Message, Project, ProjectListItem } from '@/lib/db/provider/types';
import type { SnapshotFile } from '@/lib/projects/service';
import {
  clearWorkspaceStores,
  createWorkspaceStore,
  useWorkspace,
  useWorkspaceFile,
  type WorkspaceSnapshot,
} from '@/lib/client/store';

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

const PROJECT_ID = 7;

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    sessionId: 'session-a',
    title: '番茄钟应用',
    requirement: '做一个番茄钟，可以开始暂停和重置',
    mode: 'fast',
    status: 'running',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: 1,
    projectId: PROJECT_ID,
    role: 'assistant',
    content: '需求已收到，团队开始工作',
    meta: null,
    deliveredAt: null,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

/** 快照文件行（对齐服务层 SnapshotFile：id/updatedAt 也带上，形状以实际契约为准） */
function snapFile(over: Partial<SnapshotFile> = {}): SnapshotFile {
  return {
    id: 101,
    path: 'index.html',
    content: '',
    version: 1,
    lastEditor: 'engineer',
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

/** 空白快照（hydrate 起点用，按需覆盖字段；契约 = GET /api/projects/[id] 的 ProjectSnapshot） */
function makeSnapshot(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    project: makeProject(),
    lastSeq: 0,
    messages: [],
    files: [],
    agentRuns: [],
    checkpoints: [],
    usage: [],
    streamingFiles: [],
    softLockedFiles: [],
    ...over,
  };
}

let seqCounter = 0;
/** 合成事件：projectId 缺省用夹具值、seq 自增（与总线行为一致），其余字段按需选填 */
function ev(
  e: Pick<StreamEvent, 'event'> & Partial<Omit<StreamEvent, 'seq' | 'projectId' | 'event'>>,
  projectId: number = PROJECT_ID,
): StreamEvent {
  seqCounter += 1;
  return { seq: seqCounter, projectId, runId: null, ...e };
}

beforeEach(() => {
  seqCounter = 0;
  clearWorkspaceStores();
  cleanup();
  window.sessionStorage.clear();
});

/* ------------------------------------------------------------------ */
/* workspaceStore：事件分流                                             */
/* ------------------------------------------------------------------ */

describe('workspaceStore 事件分流', () => {
  it('file_start→delta×2→file_end→done：文件定版、在流清除、消息追加、收尾置位', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());
    expect(store.getState().files.size).toBe(0);

    store.applyEvent(ev({ event: 'file_start', agent: 'engineer', path: 'app/main.js' }));
    const streaming = store.getState().files.get('app/main.js');
    expect(streaming?.streaming).toBe(true);
    expect(streaming?.content).toBe('');
    expect(store.getState().livePaths).toEqual(['app/main.js']);

    store.applyEvent(ev({ event: 'delta', path: 'app/main.js', content: 'const a = 1;' }));
    store.applyEvent(ev({ event: 'delta', path: 'app/main.js', content: 'export default a;' }));
    expect(store.getState().files.get('app/main.js')?.content).toBe('const a = 1;export default a;');
    expect(store.getState().livePaths).toEqual(['app/main.js']);

    store.applyEvent(ev({ event: 'file_end', agent: 'engineer', path: 'app/main.js', meta: { version: 3 } }));
    const file = store.getState().files.get('app/main.js');
    expect(file?.streaming).toBe(false);
    expect(file?.content).toBe('const a = 1;export default a;');
    expect(file?.version).toBe(3);
    expect(file?.lastEditor).toBe('engineer');
    expect(store.getState().livePaths).toEqual([]);

    store.applyEvent(
      ev({ event: 'message', agent: 'leader', content: '全栈应用已生成', meta: { role: 'assistant', messageId: 21 } }),
    );
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages[0]).toMatchObject({ id: 21, role: 'assistant', content: '全栈应用已生成' });

    store.applyEvent(ev({ event: 'done' }));
    expect(store.getState().finished).toBe(true);
    expect(store.getState().project?.status).toBe('done');
  });

  it('delta 先于 file_start 到达也能建占位；agent_start/agent_end 推进 runs', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());

    // 无 file_start 的 delta（乱序/重放缺口）：仍然可累积
    store.applyEvent(ev({ event: 'delta', agent: 'pm', path: 'docs/prd.md', content: '# PRD' }));
    expect(store.getState().files.get('docs/prd.md')?.streaming).toBe(true);

    store.applyEvent(ev({ event: 'agent_start', agent: 'pm', meta: { taskKey: 'pm-prd' } }));
    expect(store.getState().runs).toHaveLength(1);
    expect(store.getState().runs[0]).toMatchObject({ agent: 'pm', taskKey: 'pm-prd', status: 'running' });

    store.applyEvent(ev({ event: 'agent_end', agent: 'pm', summary: '产出 PRD' }));
    expect(store.getState().runs[0]).toMatchObject({ status: 'done', summary: '产出 PRD' });
  });

  it('runId 关联：hydrate 的 run 先置 running 再由 agent_end 收尾，不产生重复节点', () => {
    const run: AgentRun = {
      id: 42,
      projectId: PROJECT_ID,
      taskKey: 'eng-app-main',
      agent: 'engineer',
      task: '实现 app/main.js',
      status: 'pending',
      summary: null,
      startedAt: null,
      endedAt: null,
      error: null,
    };
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot({ agentRuns: [run] }));

    store.applyEvent(ev({ event: 'agent_start', runId: 42, agent: 'engineer', meta: { taskKey: 'eng-app-main' } }));
    expect(store.getState().runs).toHaveLength(1);
    expect(store.getState().runs[0]?.status).toBe('running');

    store.applyEvent(ev({ event: 'agent_end', runId: 42, agent: 'engineer', summary: 'main.js 完成' }));
    expect(store.getState().runs).toHaveLength(1);
    expect(store.getState().runs[0]).toMatchObject({ status: 'done', summary: 'main.js 完成' });
  });

  it('message 按 messageId 去重（重放不重复）；intervention_injected 归为干预消息', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot({ messages: [makeMessage({ id: 5 })] }));

    store.applyEvent(ev({ event: 'message', content: '收到', meta: { role: 'user', messageId: 5 } }));
    expect(store.getState().messages).toHaveLength(1);

    store.applyEvent(
      ev({ event: 'intervention_injected', content: '优先做计时', meta: { messageId: 6 } }),
    );
    expect(store.getState().messages).toHaveLength(2);
    expect(store.getState().messages[1]).toMatchObject({ id: 6, role: 'intervention' });

    // 无 messageId 的消息（如领导收尾播报）：合成负数 id，不与库里 id 冲突
    store.applyEvent(ev({ event: 'message', agent: 'leader', content: '汇报', meta: { role: 'assistant' } }));
    const last = store.getState().messages.at(-1);
    expect(last?.id).toBeLessThan(0);
    expect(store.getState().messages).toHaveLength(3);
  });

  it('appendPendingIntervention：本地补登待注入干预；注入事件到达翻转为已注入（不重复、不丢 path）', () => {
    const store = createWorkspaceStore();
    store.appendPendingIntervention({ projectId: PROJECT_ID, messageId: 77, content: '优先做计时', mentions: [] });
    expect(store.getState().messages.at(-1)).toMatchObject({
      id: 77,
      role: 'intervention',
      deliveredAt: null,
      content: '优先做计时',
    });

    // 同 id 重复补登：幂等
    store.appendPendingIntervention({ projectId: PROJECT_ID, messageId: 77, content: '重复', mentions: [] });
    expect(store.getState().messages).toHaveLength(1);

    // 注入事件（同 messageId）：翻转为已注入并带上 targetTask 折算的 path
    store.applyEvent(
      ev({
        event: 'intervention_injected',
        content: '优先做计时',
        meta: { messageId: 77, targetTask: 'engineer:app/main.js' },
      }),
    );
    expect(store.getState().messages).toHaveLength(1);
    expect(store.getState().messages.at(-1)).toMatchObject({
      id: 77,
      deliveredAt: expect.any(Number),
      meta: { path: 'app/main.js' },
    });

    // store 已绑定项目后：projectId 不同的补登被拒（防串台）
    const bound = createWorkspaceStore(PROJECT_ID);
    bound.hydrate(makeSnapshot());
    bound.appendPendingIntervention({ projectId: PROJECT_ID, messageId: 80, content: '本项目的', mentions: [] });
    expect(bound.getState().messages).toHaveLength(1);
    bound.appendPendingIntervention({ projectId: 999, messageId: 81, content: '别串台', mentions: [] });
    expect(bound.getState().messages).toHaveLength(1);
  });

  it('intervention_injected 的 targetTask（engineer:{path}）折算成 meta.path；leader 卡片保留 kind/path', () => {
    const store = createWorkspaceStore();

    // T19「已注入 {文件}」队列卡：targetTask 可解析出文件路径
    store.applyEvent(
      ev({
        event: 'intervention_injected',
        content: '优先做计时',
        meta: { messageId: 8, targetTask: 'engineer:app/main.js' },
      }),
    );
    expect(store.getState().messages.at(-1)).toMatchObject({
      id: 8,
      role: 'intervention',
      meta: { path: 'app/main.js' },
    });

    // 领导卡片语义（softlock/restore）随事件保留，刷新前的聊天区即可还原卡片
    store.applyEvent(
      ev({
        event: 'message',
        agent: 'leader',
        path: 'app/main.js',
        content: '检测到你正在编辑 app/main.js',
        meta: { role: 'assistant', kind: 'softlock', path: 'app/main.js', messageId: 9 },
      }),
    );
    expect(store.getState().messages.at(-1)).toMatchObject({
      id: 9,
      meta: { kind: 'softlock', path: 'app/main.js' },
    });

    // targetTask 解析不出路径（非 engineer:{path} 形态）时不写 path
    store.applyEvent(
      ev({ event: 'intervention_injected', content: '再排一条', meta: { messageId: 10, targetTask: 'pm-prd' } }),
    );
    expect(store.getState().messages.at(-1)).toMatchObject({ id: 10, meta: null });
  });

  it('error 记录错误并清该路径在流标记；stopped 收尾且项目转 paused', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());

    store.applyEvent(ev({ event: 'file_start', agent: 'engineer', path: 'app/api.js' }));
    store.applyEvent(ev({ event: 'delta', path: 'app/api.js', content: 'export' }));
    store.applyEvent(ev({ event: 'error', agent: 'engineer', path: 'app/api.js', error: '文件生成失败' }));

    expect(store.getState().error).toBe('文件生成失败');
    expect(store.getState().files.get('app/api.js')?.streaming).toBe(false);
    expect(store.getState().finished).toBe(false);

    store.applyEvent(ev({ event: 'stopped' }));
    expect(store.getState().finished).toBe(true);
    expect(store.getState().project?.status).toBe('paused');
  });

  it('error{agent} 视为该 agent 当前 run 的终态：running 节点置 failed（不再蓝点脉冲到刷新）', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());

    store.applyEvent(ev({ event: 'agent_start', agent: 'pm', meta: { taskKey: 'pm-prd' } }));
    expect(store.getState().runs[0]).toMatchObject({ agent: 'pm', status: 'running', endedAt: null });

    store.applyEvent(ev({ event: 'error', agent: 'pm', error: 'PRD 生成失败：模型返回无法解析', meta: { taskKey: 'pm-prd' } }));
    expect(store.getState().runs).toHaveLength(1);
    expect(store.getState().runs[0]).toMatchObject({
      agent: 'pm',
      status: 'failed',
      error: 'PRD 生成失败：模型返回无法解析',
    });
    expect(store.getState().runs[0]?.endedAt).not.toBeNull();
    // 任务级失败不是收尾：运行可继续
    expect(store.getState().finished).toBe(false);
  });

  it('error{agent} 找不到运行中节点时补一个 failed 合成节点（runId 关联优先）', () => {
    const store = createWorkspaceStore();
    store.hydrate(
      makeSnapshot({
        agentRuns: [
          {
            id: 42,
            projectId: PROJECT_ID,
            taskKey: 'engineer:app/main.js',
            agent: 'engineer',
            task: '实现 app/main.js',
            status: 'running',
            summary: null,
            startedAt: 1,
            endedAt: null,
            error: null,
          },
        ],
      }),
    );

    // runId 能对上：按 id 收尾
    store.applyEvent(ev({ event: 'error', runId: 42, agent: 'engineer', error: '文件写入失败' }));
    expect(store.getState().runs).toHaveLength(1);
    expect(store.getState().runs[0]).toMatchObject({ id: 42, status: 'failed', error: '文件写入失败' });

    // 对不上（无 running 节点）：补 failed 合成节点，错误信息不丢
    store.applyEvent(ev({ event: 'error', agent: 'engineer', error: '重试仍失败', meta: { taskKey: 'engineer:app/api.js' } }));
    expect(store.getState().runs).toHaveLength(2);
    expect(store.getState().runs[1]).toMatchObject({
      agent: 'engineer',
      taskKey: 'engineer:app/api.js',
      status: 'failed',
      error: '重试仍失败',
    });
  });

  it('无 path 且无 agent 的 error 为运行级失败：置 failed 并收尾（项目不再停留「生成中」）', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());

    // 任务级失败（带 agent）：不收尾
    store.applyEvent(ev({ event: 'error', agent: 'pm', error: 'PRD 生成失败' }));
    expect(store.getState().error).toBe('PRD 生成失败');
    expect(store.getState().finished).toBe(false);

    // 顶层失败（无 path 无 agent）：收尾
    store.applyEvent(ev({ event: 'error', error: '编排器异常退出' }));
    expect(store.getState().error).toBe('编排器异常退出');
    expect(store.getState().finished).toBe(true);
    expect(store.getState().project?.status).toBe('failed');
  });

  it('不可变更新：applyEvent 产生新 state，且不复用旧 files 集合', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());
    const before = store.getState();

    store.applyEvent(ev({ event: 'delta', path: 'app/main.js', content: 'a' }));
    const after = store.getState();

    expect(after).not.toBe(before);
    expect(after.files).not.toBe(before.files);
    expect(before.files.get('app/main.js')).toBeUndefined();
    expect(after.files.get('app/main.js')?.content).toBe('a');
  });
});

/* ------------------------------------------------------------------ */
/* 直播转录块（T31）：reasoning / 产出尾流 / 生命周期                      */
/* ------------------------------------------------------------------ */

describe('workspaceStore 直播转录（liveAgents）', () => {
  const start = (over: Partial<StreamEvent> = {}): StreamEvent =>
    ev({ event: 'agent_start', agent: 'pm', meta: { taskKey: 'pm-prd' }, ...over });

  it('agent_start 开块（thinking）；reasoning 追加思考流；无 agent 的思考流忽略', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());

    store.applyEvent(start());
    expect(store.getState().liveAgents['pm']).toEqual({
      reasoning: '',
      outputPath: null,
      outputTail: '',
      status: 'thinking',
    });

    store.applyEvent(ev({ event: 'reasoning', agent: 'pm', content: '先拆功能清单…' }));
    store.applyEvent(ev({ event: 'reasoning', agent: 'pm', content: '再定验收标准。' }));
    expect(store.getState().liveAgents['pm']?.reasoning).toBe('先拆功能清单…再定验收标准。');
    expect(store.getState().liveAgents['pm']?.status).toBe('thinking');

    // 协议未带 agent：无从归属，不推进也不炸
    store.applyEvent(ev({ event: 'reasoning', content: '无归属' }));
    expect(store.getState().liveAgents['pm']?.reasoning).toBe('先拆功能清单…再定验收标准。');
  });

  it('file_start 写入中（尾流重置）→ delta 追加 → 思考流不再把状态拉回 thinking；重放 file_start 幂等', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());

    store.applyEvent(start({ agent: 'engineer', meta: { taskKey: 'engineer:app/main.js' } }));
    store.applyEvent(ev({ event: 'reasoning', agent: 'engineer', content: '读一下依赖' }));
    store.applyEvent(ev({ event: 'file_start', agent: 'engineer', path: 'app/main.js' }));
    expect(store.getState().liveAgents['engineer']).toMatchObject({ outputPath: 'app/main.js', outputTail: '', status: 'writing' });

    store.applyEvent(ev({ event: 'delta', agent: 'engineer', path: 'app/main.js', content: 'const a' }));
    store.applyEvent(ev({ event: 'delta', agent: 'engineer', path: 'app/main.js', content: ' = 1;' }));
    expect(store.getState().liveAgents['engineer']?.outputTail).toBe('const a = 1;');

    // 写作中途的思考不再把徽章闪回「思考中」（写作是更靠后的进度信号）
    store.applyEvent(ev({ event: 'reasoning', agent: 'engineer', content: '（补一段思考）' }));
    expect(store.getState().liveAgents['engineer']?.status).toBe('writing');
    expect(store.getState().liveAgents['engineer']?.reasoning).toBe('读一下依赖（补一段思考）');

    // Last-Event-ID 重放叠加：file_start 重开档，重放 delta 不重复拼接
    store.applyEvent(ev({ event: 'file_start', agent: 'engineer', path: 'app/main.js' }));
    store.applyEvent(ev({ event: 'delta', agent: 'engineer', path: 'app/main.js', content: 'const a = 1;' }));
    expect(store.getState().liveAgents['engineer']?.outputTail).toBe('const a = 1;');
  });

  it('尾流只留尾部（600）、思考流只留尾部（3000）——内存有界', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());
    store.applyEvent(start({ agent: 'engineer', meta: { taskKey: 'engineer:app/big.js' } }));
    store.applyEvent(ev({ event: 'file_start', agent: 'engineer', path: 'app/big.js' }));
    store.applyEvent(ev({ event: 'delta', agent: 'engineer', path: 'app/big.js', content: 'x'.repeat(900) }));
    store.applyEvent(ev({ event: 'reasoning', agent: 'engineer', content: '想'.repeat(3200) }));

    const live = store.getState().liveAgents['engineer'];
    expect(live?.outputTail).toBe('x'.repeat(600));
    expect(live?.reasoning).toBe('想'.repeat(3000));
  });

  it('agent_end → done + summary；块保留到下一块开始（全部 done 时整体清空）；done/stopped 收口清场', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());

    store.applyEvent(start());
    store.applyEvent(ev({ event: 'agent_end', agent: 'pm', summary: 'PRD 完成' }));
    expect(store.getState().liveAgents['pm']).toMatchObject({ status: 'done', summary: 'PRD 完成' });

    // 下一块开始：现有块全部 done → 整体清空后开新块（任务间隙不闪烁消失）
    store.applyEvent(start({ agent: 'architect', meta: { taskKey: 'architect-design' } }));
    expect(Object.keys(store.getState().liveAgents)).toEqual(['architect']);

    // 轮次收口：整体清空，不留跨轮残留
    store.applyEvent(ev({ event: 'done' }));
    expect(store.getState().liveAgents).toEqual({});
  });

  it('hydrate 播种在场占位：running 任务 → thinking 块（工程师带目标路径）；思考流本身不恢复', () => {
    const store = createWorkspaceStore();
    const running: AgentRun[] = [
      {
        id: 31,
        projectId: PROJECT_ID,
        taskKey: 'engineer:app/main.js',
        agent: 'engineer',
        task: '实现 app/main.js',
        status: 'running',
        summary: null,
        startedAt: 1,
        endedAt: null,
        error: null,
      },
    ];
    store.hydrate(makeSnapshot({ agentRuns: running }));
    expect(store.getState().liveAgents['engineer']).toEqual({
      reasoning: '',
      outputPath: 'app/main.js',
      outputTail: '',
      status: 'thinking',
    });

    // 全部任务已收尾的快照：不播种（不渲染已完成任务的直播块）
    const idle = createWorkspaceStore();
    idle.hydrate(makeSnapshot({ agentRuns: [] }));
    expect(idle.getState().liveAgents).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* workspaceStore：快照 hydrate                                         */
/* ------------------------------------------------------------------ */

describe('workspaceStore hydrate', () => {
  it('快照重建：files/messages/runs/checkpoints/usage/软锁全部就位，live 转 streaming 占位', () => {
    const run: AgentRun = {
      id: 42,
      projectId: PROJECT_ID,
      taskKey: 'eng-app-main',
      agent: 'engineer',
      task: '实现 app/main.js',
      status: 'done',
      summary: '完成',
      startedAt: 1,
      endedAt: 2,
      error: null,
    };
    const store = createWorkspaceStore();
    store.hydrate(
      makeSnapshot({
        messages: [makeMessage({ id: 5 })],
        files: [
          snapFile({ id: 11, path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' }),
          snapFile({ id: 12, path: 'app/main.js', content: 'const a = 1;', version: 1, lastEditor: 'engineer' }),
        ],
        agentRuns: [run],
        checkpoints: [
          { id: 3, projectId: PROJECT_ID, label: 'eng-app-main 前', agentRunId: null, afterRunId: 42, createdAt: 9 },
        ],
        usage: [{ agentRole: 'pm', model: 'mock', tokens: 120, calls: 1 }],
        streamingFiles: [{ path: 'app/live.js', content: 'const live = 1;' }],
        softLockedFiles: [{ fileId: 12, path: 'app/main.js', editingBy: 'user-1', editingExpiresAt: 1_800_000_000_000 }],
      }),
    );

    const state = store.getState();
    expect(state.project?.id).toBe(PROJECT_ID);
    expect(state.files.get('index.html')).toMatchObject({ content: '<!doctype html>', version: 2, streaming: false });
    expect(state.files.get('app/live.js')).toMatchObject({ content: 'const live = 1;', streaming: true });
    expect(state.livePaths).toEqual(['app/live.js']);
    expect(state.messages).toHaveLength(1);
    expect(state.runs).toHaveLength(1);
    expect(state.checkpoints).toHaveLength(1);
    expect(state.usage).toEqual([{ agentRole: 'pm', model: 'mock', tokens: 120, calls: 1 }]);
    expect(state.softLocked).toEqual(['app/main.js']);
    expect(state.finished).toBe(false);
  });

  it('幂等：同一快照二次 hydrate 状态引用不变（不触发多余渲染）', () => {
    const snapshot = makeSnapshot({
      messages: [makeMessage({ id: 5 })],
      files: [snapFile({ path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' })],
    });
    const store = createWorkspaceStore();
    store.hydrate(snapshot);
    const first = store.getState();
    store.hydrate(snapshot);
    expect(store.getState()).toBe(first);

    // 换成内容相同但对象不同的快照：仍然幂等（值等价即可，不比引用）
    store.hydrate(makeSnapshot({
      messages: [makeMessage({ id: 5 })],
      files: [snapFile({ path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' })],
    }));
    expect(store.getState()).toBe(first);
  });

  it('hydrate 后续接 delta：在流文件继续追加，定版文件从快照内容起算', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot({
      files: [snapFile({ path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' })],
      streamingFiles: [{ path: 'app/live.js', content: 'const live' }],
    }));

    store.applyEvent(ev({ event: 'delta', agent: 'engineer', path: 'app/live.js', content: ' = 1;' }));
    expect(store.getState().files.get('app/live.js')?.content).toBe('const live = 1;');

    store.applyEvent(ev({ event: 'file_end', agent: 'engineer', path: 'app/live.js', meta: { version: 4 } }));
    expect(store.getState().files.get('app/live.js')).toMatchObject({ streaming: false, version: 4 });

    // 事件路径未在快照里 → 新建占位，且不影响已有文件
    store.applyEvent(ev({ event: 'delta', path: 'app/other.js', content: 'x' }));
    expect(store.getState().files.get('index.html')?.content).toBe('<!doctype html>');
    expect(store.getState().files.get('app/other.js')?.content).toBe('x');
  });
});

/* ------------------------------------------------------------------ */
/* useWorkspaceFile 细粒度订阅（T19 打字机消费）                         */
/* ------------------------------------------------------------------ */

describe('useWorkspaceFile 细粒度订阅', () => {
  it('只订阅指定 path：其他路径更新不触发本组件重渲染，本路径更新才重渲染', () => {
    clearWorkspaceStores();
    const store = createWorkspaceStore(3);
    store.hydrate(makeSnapshot({ project: makeProject({ id: 3 }) }));

    const renders: string[] = [];
    function Probe(): ReturnType<typeof createElement> {
      const file = useWorkspaceFile(3, 'app/main.js');
      renders.push(file.content);
      return createElement('div', null, file.content);
    }
    const { container } = render(createElement(Probe));
    expect(renders).toEqual(['']); // 文件尚不存在 → 共享空占位，引用稳定

    // 其他路径的 delta：不重渲染
    act(() => {
      store.applyEvent(ev({ event: 'delta', path: 'app/other.js', content: 'x' }, 3));
    });
    expect(renders).toEqual(['']);

    // 本路径 file_start + delta：各重渲染一次，内容跟进（同一 act 内的多次通知会被 React 批处理合并）
    act(() => {
      store.applyEvent(ev({ event: 'file_start', agent: 'engineer', path: 'app/main.js' }, 3));
    });
    act(() => {
      store.applyEvent(ev({ event: 'delta', path: 'app/main.js', content: 'a' }, 3));
    });
    expect(renders).toEqual(['', '', 'a']);
    expect(container.textContent).toBe('a');

    // file_end 定版（streaming/version 变化 → 新引用，重渲染一次）后再来一条其他路径事件：不再重渲染
    act(() => {
      store.applyEvent(ev({ event: 'file_end', agent: 'engineer', path: 'app/main.js', meta: { version: 2 } }, 3));
    });
    act(() => {
      store.applyEvent(ev({ event: 'delta', path: 'app/other.js', content: 'y' }, 3));
    });
    expect(renders).toEqual(['', '', 'a', 'a']);
    expect(store.getState().files.get('app/main.js')).toMatchObject({ content: 'a', version: 2, streaming: false });
  });
});

/* ------------------------------------------------------------------ */
/* fileId 透传（T21 查看器编辑保存 / 软锁声明按 fileId 定位文件）           */
/* ------------------------------------------------------------------ */

describe('文件 fileId 透传', () => {
  it('快照 hydrate 带上 fileId；SSE 流式路径在落库前 fileId 为 null，后续快照补齐后 delta 不丢', () => {
    const store = createWorkspaceStore(PROJECT_ID);
    store.hydrate(
      makeSnapshot({
        files: [snapFile({ id: 101, path: 'index.html', version: 1, content: '<!doctype html>' })],
      }),
    );
    expect(store.getState().files.get('index.html')?.id).toBe(101);

    // 在流路径（尚未落库/fileId 未知）：delta 累积期间 id 保持 null
    act(() => {
      store.applyEvent(ev({ event: 'file_start', agent: 'engineer', path: 'app/live.js' }, PROJECT_ID));
      store.applyEvent(ev({ event: 'delta', agent: 'engineer', path: 'app/live.js', content: 'const' }, PROJECT_ID));
    });
    expect(store.getState().files.get('app/live.js')?.id).toBeNull();

    // 重新 hydrate（快照里已有该文件行）补上 id；其后的 delta 不应把 id 冲掉
    store.hydrate(
      makeSnapshot({
        files: [
          snapFile({ id: 101, path: 'index.html', version: 1, content: '<!doctype html>' }),
          snapFile({ id: 205, path: 'app/live.js', version: 2, content: 'const live' }),
        ],
        streamingFiles: [{ path: 'app/live.js', content: 'const live' }],
      }),
    );
    expect(store.getState().files.get('app/live.js')?.id).toBe(205);
    act(() => {
      store.applyEvent(ev({ event: 'delta', agent: 'engineer', path: 'app/live.js', content: ' x' }, PROJECT_ID));
    });
    expect(store.getState().files.get('app/live.js')).toMatchObject({ id: 205, content: 'const live x' });
  });
});

/* ------------------------------------------------------------------ */
/* store 单例与订阅                                                     */
/* ------------------------------------------------------------------ */

describe('workspaceStore 单例', () => {
  it('同一 projectId 返回同一实例；clear 后重建', () => {
    expect(createWorkspaceStore(PROJECT_ID)).toBe(createWorkspaceStore(PROJECT_ID));
    expect(createWorkspaceStore(PROJECT_ID)).not.toBe(createWorkspaceStore(PROJECT_ID + 1));
    const before = createWorkspaceStore(PROJECT_ID);
    clearWorkspaceStores();
    expect(createWorkspaceStore(PROJECT_ID)).not.toBe(before);
  });

  it('subscribe 在状态变更时通知，引用稳定时不通知', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.setConnected(true);
    expect(listener).toHaveBeenCalledTimes(1);
    store.hydrate(makeSnapshot()); // 幂等：不通知
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.applyEvent(ev({ event: 'delta', path: 'a.js', content: 'x' }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------ */
/* useWorkspace 连接管道（EventSource stub；T17 R2 首连重放入口）         */
/* ------------------------------------------------------------------ */

/** jsdom 无 EventSource：用可观察 stub 捕获连接 URL / onmessage / close */
class MockEventSource {
  static readonly instances: MockEventSource[] = [];

  closed = false;
  onopen: ((event: MessageEvent) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

describe('useWorkspace 连接管道', () => {
  it('快照 lastSeq 进首连 URL（?lastEventId=），重放事件经 onmessage 入 store，卸载关闭连接', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(makeSnapshot({ lastSeq: 12 })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;

    function Probe(): ReturnType<typeof createElement> {
      const state = useWorkspace(7);
      return createElement('div', null, state.project?.title ?? '');
    }
    const { unmount } = render(createElement(Probe));

    // 快照到达 → hydrate → 打开 EventSource，首连 URL 携带快照 lastSeq
    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/7', expect.anything());
    expect(MockEventSource.instances[0]?.url).toBe('/api/projects/7/stream?lastEventId=12');

    // 重放的 delta 事件经 onmessage 进 store（首连重放不依赖 Last-Event-ID 头）
    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();
    if (source === undefined) return;
    act(() => {
      source.onmessage?.(new MessageEvent('message', { data: JSON.stringify(ev({ event: 'delta', path: 'app/x.js', content: 'hi' })) }));
    });
    expect(createWorkspaceStore(7).getState().files.get('app/x.js')?.content).toBe('hi');

    // 卸载：不留悬挂连接
    unmount();
    expect(source.closed).toBe(true);

    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------------------ */
/* 组件渲染冒烟                                                         */
/* ------------------------------------------------------------------ */

const { pushMock, onDeleteMock } = vi.hoisted(() => ({ pushMock: vi.fn(), onDeleteMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/',
}));

/** fetch mock 帮手：JSON 响应（session 层读 text 后自行解析） */
function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(payload);
  return { ok, status, json: async () => payload, text: async () => text } as unknown as Response;
}

const listItem: ProjectListItem = {
  ...makeProject({ id: 7, title: '番茄钟应用', status: 'done', updatedAt: Date.now() - 60_000 }),
  fileCount: 3,
  totalTokens: 1250,
  lastMessage: '应用已生成完毕',
};

describe('组件渲染冒烟', () => {
  /** 按路由分发：/api/settings → 偏好；其余 → {project}（HomeHero 建项目） */
  function homeFetchMock(preferences: unknown = { editing_enabled: true, default_mode: 'full' }) {
    return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/settings')) return jsonResponse({ preferences });
      return jsonResponse({ project: makeProject({ id: 9 }) });
    });
  }

  it('HomeHero：标题/角色头像排/示例 chips/公告条/模式胶囊，提交后跳转项目页', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ project: makeProject({ id: 9 }) }));
    vi.stubGlobal('fetch', fetchMock);

    const { HomeHero } = await import('@/components/home/HomeHero');
    const { container } = render(createElement(HomeHero));

    expect(screen.getByText('输入想法，产出产品')).toBeInTheDocument();
    // 7 个角色 emoji 全部出现（数据源 = roleRegistry）
    for (const role of roleOrder) {
      expect(container.textContent).toContain(roleRegistry[role].emoji);
    }
    // 示例 chips
    expect(screen.getByRole('button', { name: '番茄钟' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '待办清单' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '数据看板' })).toBeInTheDocument();
    // 公告条 + 两种模式胶囊
    expect(screen.getByText('v1 支持多智能体团队协作')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /快速模式/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /完整模式/ })).toBeInTheDocument();

    // 示例 chip 回填输入框
    fireEvent.click(screen.getByRole('button', { name: '番茄钟' }));
    const input = screen.getByPlaceholderText('描述你想要的应用，团队替你实现');
    expect(input).toHaveValue('做一个番茄钟，可以开始暂停和重置');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ project: makeProject({ id: 9 }) }));
    fireEvent.change(input, { target: { value: '做一个待办清单应用' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/p/9'));
    expect(fetchMock).toHaveBeenCalledWith('/api/projects', expect.objectContaining({ method: 'POST' }));
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { requirement: string; mode: string };
    expect(body).toEqual({ requirement: '做一个待办清单应用', mode: 'fast' });

    vi.unstubAllGlobals();
  });

  it('HomeHero：模式胶囊初值接 preferences.default_mode（T23 偏好的本意消费位），随建项目请求上送', async () => {
    const fetchMock = homeFetchMock({ editing_enabled: true, default_mode: 'full' });
    vi.stubGlobal('fetch', fetchMock);

    const { HomeHero } = await import('@/components/home/HomeHero');
    render(createElement(HomeHero));

    await waitFor(() => expect(screen.getByRole('button', { name: /完整模式/ })).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.change(screen.getByPlaceholderText('描述你想要的应用，团队替你实现'), {
      target: { value: '做一个看板' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/p/9'));
    const calls = fetchMock.mock.calls as Array<[RequestInfo | URL, RequestInit?]>;
    const createCall = calls.find((call) => String(call[0]).endsWith('/api/projects'));
    expect(createCall).toBeDefined();
    const body = JSON.parse(String(createCall?.[1]?.body)) as { requirement: string; mode: string };
    expect(body).toEqual({ requirement: '做一个看板', mode: 'full' });

    vi.unstubAllGlobals();
  });

  it('HomeHero：偏好读取失败静默回退 fast，建项目仍可用', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/api/settings')) return jsonResponse({}, false, 500);
      return jsonResponse({ project: makeProject({ id: 9 }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { HomeHero } = await import('@/components/home/HomeHero');
    render(createElement(HomeHero));
    expect(screen.getByRole('button', { name: /快速模式/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByPlaceholderText('描述你想要的应用，团队替你实现'), {
      target: { value: '做一个待办' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/p/9'));

    vi.unstubAllGlobals();
  });

  it('HomeHero：IME 组词中的 Enter 不提交（中文输入确认不建项目）', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { HomeHero } = await import('@/components/home/HomeHero');
    render(createElement(HomeHero));
    const input = screen.getByPlaceholderText('描述你想要的应用，团队替你实现');

    const createCalls = (): number => fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/api/projects')).length;
    fireEvent.change(input, { target: { value: '做一个番茄钟' } });
    // 组词（isComposing）中的 Enter：只确认候选词，不触发提交
    // （挂载时的 GET /api/settings 偏好读取照常发生，与建项目无关）
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(createCalls()).toBe(0);
    expect(pushMock).not.toHaveBeenCalled();

    // 组词结束后的 Enter：正常提交
    fetchMock.mockResolvedValue(jsonResponse({ project: makeProject({ id: 9 }) }));
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith('/p/9'));

    vi.unstubAllGlobals();
  });

  it('AppSidebar：品牌/导航 active 态/最近项目/设置入口，最近项可删除', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValue(jsonResponse({ projects: [listItem] }));
    vi.stubGlobal('fetch', fetchMock);

    const { AppSidebar } = await import('@/components/shell/AppSidebar');
    render(createElement(AppSidebar));

    expect(screen.getByText('Atoms')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /首页/ })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: /我的项目/ })).toHaveAttribute('href', '/projects');
    expect(screen.getByRole('link', { name: /设置/ })).toHaveAttribute('href', '/settings');

    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();
    expect(screen.getByText('应用已生成完毕')).toBeInTheDocument();

    // 最近项 hover 删除：DELETE 成功后从列表移除
    fetchMock.mockResolvedValue(jsonResponse({}, true, 200));
    const deleteButton = screen.getByRole('button', { name: '删除项目 番茄钟应用' });
    // 键盘可达：Tab 聚焦时按钮可见（不再依赖 hover 才出现）
    expect(deleteButton.className).toContain('focus-visible:opacity-100');
    expect(deleteButton.className).not.toContain('hidden');
    fireEvent.click(deleteButton);
    await waitFor(() => expect(screen.queryByText('番茄钟应用')).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/7', expect.objectContaining({ method: 'DELETE' }));

    vi.unstubAllGlobals();
  });

  it('ProjectsGrid：卡片墙渲染统计信息；空态给引导', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ projects: [listItem] }));
    vi.stubGlobal('fetch', fetchMock);

    const { ProjectsGrid } = await import('@/components/projects/ProjectsGrid');
    render(createElement(ProjectsGrid, { onDeleted: onDeleteMock }));

    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();
    expect(screen.getByText('做一个番茄钟，可以开始暂停和重置')).toBeInTheDocument();
    expect(screen.getByText('应用已生成完毕')).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('快速')).toBeInTheDocument();
    expect(screen.getByText('3 个文件')).toBeInTheDocument();
    expect(screen.getByText('1.3k tokens')).toBeInTheDocument();
    expect(screen.getByText('1 分钟前')).toBeInTheDocument();

    // 空态
    cleanup();
    fetchMock.mockResolvedValue(jsonResponse({ projects: [] }));
    render(createElement(ProjectsGrid, { onDeleted: onDeleteMock }));
    expect(await screen.findByText('还没有项目')).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('ProjectsGrid：首次加载失败也提供重试，重试成功后渲染列表', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue(jsonResponse({ projects: [listItem] }));
    vi.stubGlobal('fetch', fetchMock);

    const { ProjectsGrid } = await import('@/components/projects/ProjectsGrid');
    render(createElement(ProjectsGrid, { onDeleted: onDeleteMock }));

    // 首次失败：错误文案 + 重试按钮（projects 尚未就绪也要能重试）
    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.queryByText('番茄钟应用')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();

    vi.unstubAllGlobals();
  });
});
