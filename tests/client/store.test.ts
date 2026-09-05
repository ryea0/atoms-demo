/**
 * Task 17 测试：客户端 workspace store（SSE 事件分流 / 快照幂等恢复）+ 基础组件渲染冒烟。
 *
 * store 用合成 StreamEvent 序列直喂（不经网络）；组件层 mock fetch 与 next/navigation，
 * 只断言关键元素渲染与提交请求（jsdom 无 EventSource，连接细节由工作台任务集成验证）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { StreamEvent } from '@/lib/agents/events';
import { roleOrder, roleRegistry } from '@/lib/agents/registry';
import type { AgentRun, Message, Project, ProjectListItem } from '@/lib/db/provider/types';
import {
  clearWorkspaceStores,
  createWorkspaceStore,
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

/** 空白快照（hydrate 起点用，按需覆盖字段） */
function makeSnapshot(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    project: makeProject(),
    messages: [],
    files: [],
    agentRuns: [],
    checkpoints: [],
    usage: [],
    live: [],
    softLocked: [],
    ...over,
  };
}

let seqCounter = 0;
/** 合成事件：projectId 固定、seq 自增（与总线行为一致），其余字段按需选填 */
function ev(e: Pick<StreamEvent, 'event'> & Partial<Omit<StreamEvent, 'seq' | 'projectId' | 'event'>>): StreamEvent {
  seqCounter += 1;
  return { seq: seqCounter, projectId: PROJECT_ID, runId: null, ...e };
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
          { path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' },
          { path: 'app/main.js', content: 'const a = 1;', version: 1, lastEditor: 'engineer' },
        ],
        agentRuns: [run],
        checkpoints: [{ id: 3, projectId: PROJECT_ID, label: 'eng-app-main 前', agentRunId: null, createdAt: 9 }],
        usage: [{ agentRole: 'pm', model: 'mock', tokens: 120, calls: 1 }],
        live: [{ path: 'app/live.js', content: 'const live = 1;' }],
        softLocked: ['app/main.js'],
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
      files: [{ path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' }],
    });
    const store = createWorkspaceStore();
    store.hydrate(snapshot);
    const first = store.getState();
    store.hydrate(snapshot);
    expect(store.getState()).toBe(first);

    // 换成内容相同但对象不同的快照：仍然幂等（值等价即可，不比引用）
    store.hydrate(makeSnapshot({
      messages: [makeMessage({ id: 5 })],
      files: [{ path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' }],
    }));
    expect(store.getState()).toBe(first);
  });

  it('hydrate 后续接 delta：在流文件继续追加，定版文件从快照内容起算', () => {
    const store = createWorkspaceStore();
    store.hydrate(makeSnapshot({
      files: [{ path: 'index.html', content: '<!doctype html>', version: 2, lastEditor: 'architect' }],
      live: [{ path: 'app/live.js', content: 'const live' }],
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
    fireEvent.click(screen.getByRole('button', { name: '删除项目 番茄钟应用' }));
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
});
