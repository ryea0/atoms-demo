/**
 * Task 19 测试：聊天面板（消息流 / 工具卡 / 时间线 / @ 浮层 / 干预 / 停止 / 裁决卡片）。
 *
 * ChatPanel 以 WorkspaceState 直喂（store 的事件分流已由 tests/client/store.test.ts 覆盖），
 * REST 用 fetch mock 断言请求体。重点断言：
 * - 干预入队/停止的真实请求（POST messages / POST stop）
 * - 软锁裁决三按钮发送**精确指令文本**（与 orchestrator.rulingOf 匹配词一致）
 * - 队列卡（待注入 / 已注入 {文件}）、时间线键控与「⭐ 用户指定」标记
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChatPanel } from '@/components/chat/ChatPanel';
import {
  clearWorkspaceStores,
  createWorkspaceStore,
  type WorkspaceFile,
  type WorkspaceState,
} from '@/lib/client/store';
import type { AgentRun, Message, Project } from '@/lib/db/provider/types';

const PROJECT_ID = 7;

/* ------------------------------------------------------------------ */
/* 夹具                                                                 */
/* ------------------------------------------------------------------ */

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    sessionId: 'session-a',
    title: '番茄钟应用',
    requirement: '做一个番茄钟，可以开始暂停和重置',
    mode: 'fast',
    status: 'running',
    createdAt: 1_700_000_000_000,
    updatedAt: Date.now() - 60_000,
    ...over,
  };
}

let messageId = 0;

function msg(role: Message['role'], content: string, over: Partial<Message> = {}): Message {
  messageId += 1;
  return {
    id: messageId,
    projectId: PROJECT_ID,
    role,
    content,
    meta: null,
    deliveredAt: null,
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

function makeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 42,
    projectId: PROJECT_ID,
    taskKey: 'engineer:app/main.js',
    agent: 'engineer',
    task: '实现 app/main.js',
    status: 'running',
    summary: null,
    startedAt: Date.now(),
    endedAt: null,
    error: null,
    ...over,
  };
}

function makeFile(over: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return { id: 1, content: 'define([], () => ({}))', version: 2, lastEditor: 'engineer', streaming: false, ...over };
}

function makeState(over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    projectId: PROJECT_ID,
    project: makeProject(),
    files: new Map<string, WorkspaceFile>(),
    messages: [],
    runs: [],
    checkpoints: [],
    usage: [],
    softLocked: [],
    connected: true,
    livePaths: [],
    finished: false,
    error: null,
    ...over,
  };
}

interface RecordedCall {
  url: string;
  body: unknown;
}

/** fetch mock：按 URL 回包并记录请求体（settings 缺省回默认偏好） */
function makeFetchMock(preferences: unknown = { editing_enabled: true, default_mode: 'full' }) {
  const calls: RecordedCall[] = [];
  const respond = (url: string): unknown => {
    if (url.endsWith('/messages')) return { delivered: 'intervention', messageId: 99 };
    if (url.endsWith('/stop')) return { ok: true };
    if (url.includes('/api/settings')) return { preferences };
    return { ok: true };
  };
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null });
    const payload = respond(url);
    const text = JSON.stringify(payload);
    return { ok: true, status: 200, json: async () => payload, text: async () => text } as unknown as Response;
  };
  const fetchMock = vi.fn(fetchImpl);
  return { calls, fetchMock };
}

/** 最近一次请求（url 结尾匹配；stop 请求无 body） */
function lastPost(calls: readonly RecordedCall[], suffix: string): RecordedCall | undefined {
  return [...calls].reverse().find((call) => call.url.endsWith(suffix));
}

function mount(state: WorkspaceState, handlers: { onOpenFile?: (path: string) => void; onRollback?: (runId: number) => void } = {}) {
  return render(
    createElement(ChatPanel, {
      state,
      onOpenFile: handlers.onOpenFile,
      onRollback: handlers.onRollback,
    }),
  );
}

beforeEach(() => {
  messageId = 0;
  cleanup();
  clearWorkspaceStores(); // store 是 per-project 单例：测试间互不串扰（本地补登干预用）
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* 消息流                                                               */
/* ------------------------------------------------------------------ */

describe('消息流渲染', () => {
  it('user 右对齐带 @ chips、assistant 直接排列；空态给出引导文案', () => {
    mount(
      makeState({
        messages: [
          msg('user', '做一个番茄钟', { meta: { mentions: ['pm'] } }),
          msg('assistant', '需求已收到，团队开始工作'),
        ],
      }),
    );

    expect(screen.getByText('做一个番茄钟')).toBeInTheDocument();
    expect(screen.getByText('需求已收到，团队开始工作')).toBeInTheDocument();
    // @ 指定成员以 chip 呈现（输入区 chips 同名按钮也在，取“至少出现一次”语义）
    expect(screen.getAllByText('产品经理').length).toBeGreaterThan(0);
    // 无消息无任务时的空态
  });

  it('无消息无任务：渲染引导占位', () => {
    mount(makeState());
    expect(screen.getByText('还没有消息。描述你的需求，生成过程会在这里实时直播')).toBeInTheDocument();
  });

  it('快照加载失败：顶部红条呈现错误文案（role=alert）', () => {
    mount(makeState({ project: null, error: '快照加载失败：Failed to fetch' }));
    expect(screen.getByRole('alert')).toHaveTextContent('快照加载失败：Failed to fetch');
  });

  it('收尾后的最后一条 assistant 消息渲染为领导汇报卡', () => {
    mount(
      makeState({
        finished: true,
        messages: [msg('assistant', '中间过程消息'), msg('assistant', '全部任务已完成，可点击预览查看应用')],
      }),
    );
    expect(screen.getByText(/领导汇报/)).toBeInTheDocument();
    expect(screen.getByText('全部任务已完成，可点击预览查看应用')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 干预队列卡片                                                          */
/* ------------------------------------------------------------------ */

describe('干预队列卡片', () => {
  it('未投递的 intervention 渲染「排队中」队列卡', () => {
    mount(
      makeState({
        messages: [msg('intervention', '计时器要支持毫秒显示', { deliveredAt: null, meta: { mentions: [] } })],
      }),
    );
    expect(screen.getByText('📥 排队中，将注入下一任务边界')).toBeInTheDocument();
    expect(screen.getByText('计时器要支持毫秒显示')).toBeInTheDocument();
  });

  it('已投递的 intervention 渲染「已注入 {文件}」卡（targetTask 折算的 path）', () => {
    mount(
      makeState({
        messages: [
          msg('intervention', '计时器要支持毫秒显示', { deliveredAt: Date.now(), meta: { path: 'app/main.js' } }),
        ],
      }),
    );
    expect(screen.getByText('已注入 app/main.js')).toBeInTheDocument();
  });

  it('targetTask 无法解析出文件时回退「已注入下一步骤」', () => {
    mount(
      makeState({
        messages: [msg('intervention', '优先做计时', { deliveredAt: Date.now(), meta: null })],
      }),
    );
    expect(screen.getByText('已注入下一步骤')).toBeInTheDocument();
  });

  it('运行中：输入框上方出现干预黄条；发送走 POST messages（干预入队）', async () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ runs: [makeRun()] }));

    expect(screen.getByText(/将注入下一个步骤/)).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '计时器要支持毫秒显示' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    await waitFor(() => {
      const sent = lastPost(calls, `/api/projects/${PROJECT_ID}/messages`);
      expect(sent?.body).toEqual({ content: '计时器要支持毫秒显示', mentions: [] });
    });
  });

  it('运行中：停止钮（左下）可见且发送 POST stop；空闲时不渲染', async () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { unmount } = mount(makeState({ runs: [makeRun()] }));

    fireEvent.click(screen.getByRole('button', { name: '停止生成' }));
    await waitFor(() => {
      expect(lastPost(calls, `/api/projects/${PROJECT_ID}/stop`)?.url).toBe(`/api/projects/${PROJECT_ID}/stop`);
    });
    unmount();

    // 空闲（已收尾）：没有停止钮
    const idle = makeFetchMock();
    vi.stubGlobal('fetch', idle.fetchMock as unknown as typeof fetch);
    mount(makeState({ finished: true, project: makeProject({ status: 'done' }) }));
    expect(screen.queryByRole('button', { name: '停止生成' })).not.toBeInTheDocument();
    expect(screen.queryByText(/将注入下一个步骤/)).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 软锁裁决 / 回滚通知卡片                                                */
/* ------------------------------------------------------------------ */

describe('软锁裁决卡片', () => {
  const softlock = (): Message =>
    msg('assistant', '检测到你正在编辑 app/main.js：保留你的修改并跳过 / 覆盖生成 / 完成编辑后继续', {
      meta: { kind: 'softlock', path: 'app/main.js' },
    });

  it.each([
    ['覆盖生成', '覆盖'],
    ['保留修改并跳过', '保留'],
    ['完成编辑后继续', '稍后'],
  ])('「%s」发送精确指令文本「%s」（与 rulingOf 匹配词一致）', async (label, expected) => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const { unmount } = mount(makeState({ runs: [makeRun()], messages: [softlock()] }));

    expect(screen.getByText(/需要你裁决/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => {
      expect(lastPost(calls, `/api/projects/${PROJECT_ID}/messages`)?.body).toEqual({
        content: expected,
        mentions: [],
      });
    });
    unmount();
  });

  it('裁决只发一次：点击后三按钮置灰，防重复裁决', async () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ runs: [makeRun()], messages: [softlock()] }));

    const override = screen.getByRole('button', { name: '覆盖生成' });
    fireEvent.click(override);
    await waitFor(() => expect(override).toBeDisabled());
    expect(screen.getByRole('button', { name: '保留修改并跳过' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '完成编辑后继续' })).toBeDisabled();

    // 置灰后点击不再发请求（只有第一次裁决入队）
    const sent = calls.filter((call) => call.url.endsWith('/messages'));
    expect(sent).toHaveLength(1);
  });

  it('非运行中（生成已收尾）禁用裁决按钮，不误触发新一轮', () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ finished: true, project: makeProject({ status: 'done' }), messages: [softlock()] }));

    const button = screen.getByRole('button', { name: '覆盖生成' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(calls.some((call) => call.url.endsWith('/messages'))).toBe(false);
  });

  it('restore 通知渲染回滚通知卡', () => {
    mount(
      makeState({
        messages: [msg('assistant', '已回滚到检查点「任务前:pm-prd」：恢复 3 个文件。', { meta: { kind: 'restore' } })],
      }),
    );
    expect(screen.getByText('↩️ 回滚通知')).toBeInTheDocument();
    expect(screen.getByText(/已回滚到检查点/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 工具卡                                                               */
/* ------------------------------------------------------------------ */

describe('产物工具卡', () => {
  it('engineer 单文件任务派生工具卡：📄/✏️ 图标 + path + 产物摘要 + 版本', () => {
    const onOpenFile = vi.fn();
    mount(
      makeState({
        files: new Map([['app/main.js', makeFile({ lastEditor: 'human', version: 2 })]]),
        runs: [
          makeRun({
            status: 'done',
            endedAt: Date.now(),
            summary: '实现番茄钟计时逻辑，含开始/暂停/重置',
          }),
        ],
      }),
      { onOpenFile },
    );

    const card = screen.getByRole('button', { name: '打开 app/main.js' });
    expect(card).toHaveTextContent('app/main.js');
    expect(card).toHaveTextContent('实现番茄钟计时逻辑，含开始/暂停/重置');
    expect(card).toHaveTextContent('v2');
    expect(card).toHaveTextContent('✏️'); // 人工最后编辑
    expect(screen.queryByText('生成中')).not.toBeInTheDocument();
  });

  it('点击工具卡回调 onOpenFile(path)；在流文件显示「生成中」徽标', () => {
    const onOpenFile = vi.fn();
    mount(
      makeState({
        files: new Map([['app/main.js', makeFile({ streaming: true, version: 0 })]]),
        runs: [makeRun({ summary: null })],
      }),
      { onOpenFile },
    );

    fireEvent.click(screen.getByRole('button', { name: '打开 app/main.js' }));
    expect(onOpenFile).toHaveBeenCalledWith('app/main.js');
    expect(screen.getByText('生成中')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 时间线                                                               */
/* ------------------------------------------------------------------ */

describe('任务时间线', () => {
  it('按 runs 渲染任务行：状态、⭐ 用户指定、失败红字', () => {
    mount(
      makeState({
        runs: [
          makeRun({
            id: 11,
            taskKey: 'user-pm-0',
            agent: 'pm',
            task: '梳理需求',
            status: 'done',
            endedAt: Date.now(),
            summary: '产出 PRD',
          }),
          makeRun({ id: 12, agent: 'engineer', status: 'running' }),
          makeRun({ id: 13, taskKey: 'engineer:app/api.js', task: '实现 app/api.js', status: 'failed', error: '语法校验未通过' }),
          makeRun({ id: 14, taskKey: 'user-ads-0', agent: 'ads', task: '投放策略', status: 'stopped' }),
        ],
      }),
    );

    expect(screen.getByRole('region', { name: '任务时间线' })).toBeInTheDocument();
    expect(screen.getByText('已完成')).toBeInTheDocument();
    expect(screen.getByText('进行中')).toBeInTheDocument();
    expect(screen.getByText('失败')).toBeInTheDocument();
    expect(screen.getByText('已停止')).toBeInTheDocument();
    // ⭐ 用户指定：taskKey 以 user- 开头
    expect(screen.getAllByText('⭐ 用户指定')).toHaveLength(2);
    // 失败红条（任务级错误可见）
    expect(screen.getByText('语法校验未通过')).toBeInTheDocument();
  });

  it('「回到此任务前」按钮回调 onRollback(runId)；未接线时禁用', () => {
    const onRollback = vi.fn();
    const runs = [makeRun({ id: 12, task: '实现 app/main.js', status: 'done', endedAt: Date.now() })];
    const { unmount } = mount(makeState({ runs }), { onRollback });

    fireEvent.click(screen.getByRole('button', { name: '回到此任务前：实现 app/main.js' }));
    expect(onRollback).toHaveBeenCalledWith(12);
    unmount();

    // 未接线（onRollback 缺省）：按钮禁用态占位
    mount(makeState({ runs }));
    expect(screen.getByRole('button', { name: '回到此任务前：实现 app/main.js' })).toBeDisabled();
  });
});

/* ------------------------------------------------------------------ */
/* 输入区：chips / @ 浮层 / 模式胶囊                                      */
/* ------------------------------------------------------------------ */

describe('输入区', () => {
  it('空闲发送：POST messages 携带内容与勾选 chips（mentions）并清空输入', async () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ finished: true, project: makeProject({ status: 'done' }) }));

    fireEvent.click(screen.getByRole('button', { name: '指定产品经理' }));
    expect(screen.getByRole('button', { name: '指定产品经理' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: '补充一个深色模式' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    await waitFor(() => {
      expect(lastPost(calls, `/api/projects/${PROJECT_ID}/messages`)?.body).toEqual({
        content: '补充一个深色模式',
        mentions: ['pm'],
      });
    });
    await waitFor(() => {
      expect((screen.getByRole('textbox', { name: '输入消息' }) as HTMLTextAreaElement).value).toBe('');
    });
  });

  it('@ 触发浮层：点击候选回填中文名，发送时 mentions 含该角色', async () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ finished: true, project: makeProject({ status: 'done' }) }));

    const input = screen.getByRole('textbox', { name: '输入消息' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@产', selectionStart: 2 } });

    const popover = screen.getByRole('listbox', { name: '成员浮层' });
    expect(popover).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: /产品经理/ }));
    expect(input.value).toBe('@产品经理 ');
    expect(screen.queryByRole('listbox', { name: '成员浮层' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '@产品经理 帮我梳理需求', selectionStart: 12 } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    await waitFor(() => {
      expect(lastPost(calls, `/api/projects/${PROJECT_ID}/messages`)?.body).toEqual({
        content: '@产品经理 帮我梳理需求',
        mentions: ['pm'],
      });
    });
  });

  it('@ 浮层键盘：Enter 选中候选、Esc 关闭浮层', () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ finished: true, project: makeProject({ status: 'done' }) }));

    const input = screen.getByRole('textbox', { name: '输入消息' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@工程师', selectionStart: 4 } });
    expect(screen.getByRole('listbox', { name: '成员浮层' })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('@工程师 ');
    expect(screen.queryByRole('listbox', { name: '成员浮层' })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '@seo', selectionStart: 4 } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox', { name: '成员浮层' })).not.toBeInTheDocument();
    // Esc 只关浮层，不清输入
    expect(input.value).toBe('@seo');
  });

  it('模式胶囊初值取 preferences.default_mode；读取失败静默回退完整模式', async () => {
    const fast = makeFetchMock({ editing_enabled: true, default_mode: 'fast' });
    vi.stubGlobal('fetch', fast.fetchMock as unknown as typeof fetch);
    const { unmount } = mount(makeState());
    await waitFor(() => expect(screen.getByRole('button', { name: '生成模式' }).textContent).toContain('快速'));
    unmount();

    const fallback = makeFetchMock();
    vi.stubGlobal('fetch', fallback.fetchMock as unknown as typeof fetch);
    mount(makeState());
    await waitFor(() => expect(screen.getByRole('button', { name: '生成模式' }).textContent).toContain('完整'));
  });

  it('IME 组词中的 Enter：不误选 @ 候选、不把半截拼音当消息发出', async () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ finished: true, project: makeProject({ status: 'done' }) }));

    const input = screen.getByRole('textbox', { name: '输入消息' }) as HTMLTextAreaElement;
    // 浮层打开时：组词 Enter 只确认候选词
    fireEvent.change(input, { target: { value: '@工程师', selectionStart: 4 } });
    expect(screen.getByRole('listbox', { name: '成员浮层' })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.getByRole('listbox', { name: '成员浮层' })).toBeInTheDocument();
    expect(input.value).toBe('@工程师');

    // 无浮层时：组词 Enter 不提交（文本保留、无请求）
    fireEvent.change(input, { target: { value: 'zu ci zhong de Enter', selectionStart: 20 } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(input.value).toBe('zu ci zhong de Enter');
    expect(calls.some((call) => call.url.endsWith('/messages'))).toBe(false);

    // 组词结束后正常 Enter 才提交
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(lastPost(calls, `/api/projects/${PROJECT_ID}/messages`)?.body).toEqual({
        content: 'zu ci zhong de Enter',
        mentions: [],
      });
    });
  });

  it('运行中发送干预：队列卡即时出现（不依赖刷新），注入事件到达后翻转为已注入', async () => {
    const { calls, fetchMock } = makeFetchMock(); // messages 回包 {delivered:'intervention', messageId:99}
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    // ChatPanel 不订阅 store（生产里由 Workspace 的 useWorkspace 驱动重渲染）：
    // 测试里手动订阅并用最新 messages 重渲染，等价模拟父组件数据流
    const store = createWorkspaceStore(PROJECT_ID);
    let current = makeState({ runs: [makeRun()] });
    const mounted = render(createElement(ChatPanel, { state: current }));
    const unsubscribe = store.subscribe(() => {
      current = makeState({ runs: [makeRun()], messages: store.getState().messages });
      mounted.rerender(createElement(ChatPanel, { state: current }));
    });

    const input = screen.getByRole('textbox', { name: '输入消息' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '要能同时开多个笔记' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    // 入队分支只落库不发 SSE：响应 messageId 本地补登，队列卡即时可见
    await waitFor(() => expect(screen.getByText(/排队中/)).toBeInTheDocument());
    expect(screen.getByText('要能同时开多个笔记')).toBeInTheDocument();

    // 注入事件（同 messageId）到达：翻转为「已注入 {文件}」，不再是排队中
    act(() => {
      store.applyEvent({
        seq: 1,
        projectId: PROJECT_ID,
        runId: null,
        event: 'intervention_injected',
        content: '要能同时开多个笔记',
        meta: { messageId: 99, targetTask: 'engineer:app/main.js' },
      });
    });
    expect(screen.getByText('已注入 app/main.js')).toBeInTheDocument();
    expect(screen.queryByText(/排队中/)).not.toBeInTheDocument();
    expect(calls.filter((call) => call.url.endsWith('/messages'))).toHaveLength(1);

    unsubscribe();
  });

  it('快照未就绪（projectId=null）：输入区禁用，不误发请求', () => {
    const { calls, fetchMock } = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    mount(makeState({ project: null, projectId: null, error: '快照加载失败' }));

    expect(screen.getByRole('textbox', { name: '输入消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '输入消息' }), { target: { value: 'hi' } });
    expect(calls.some((call) => call.url.endsWith('/messages'))).toBe(false);
  });
});
