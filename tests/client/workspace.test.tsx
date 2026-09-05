/**
 * Task 18 测试：工作台三栏布局 + 顶栏 render smoke。
 *
 * 布局层职责 = 结构 + 空态，断言聚焦：三栏容器存在、各栏空态提示可见、顶栏要素齐全
 * （返回 logo / 标题+状态下拉 / 视图切换 / 成员头像排 / 分享 / 设置 / 预留操作容器）、
 * 窄屏底部栏目 tab 可切换。SSE 事件分流与连接管道已由 tests/client/store.test.ts 覆盖，
 * 这里只保证「useWorkspace 驱动的页面骨架」能挂起来。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Workspace } from '@/components/workspace/Workspace';
import { clearWorkspaceStores, type WorkspaceSnapshot } from '@/lib/client/store';
import { roleRegistry } from '@/lib/agents/registry';
import type { AgentRun, Project } from '@/lib/db/provider/types';

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

function makeRun(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: 42,
    projectId: PROJECT_ID,
    taskKey: 'eng-app-main',
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

/** 空白快照（契约 = GET /api/projects/[id] 的 ProjectSnapshot） */
function makeSnapshot(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    project: makeProject(),
    lastSeq: 0,
    messages: [],
    files: [
      {
        id: 101,
        path: 'index.html',
        content: '<!doctype html>',
        version: 1,
        lastEditor: 'engineer',
        updatedAt: 1_700_000_000_000,
      },
      {
        id: 102,
        path: 'docs/prd.md',
        content: '# PRD',
        version: 1,
        lastEditor: 'pm',
        updatedAt: 1_700_000_000_000,
      },
    ],
    agentRuns: [makeRun({ agent: 'engineer', status: 'running' }), makeRun({ id: 41, agent: 'pm', status: 'done' })],
    checkpoints: [],
    usage: [],
    streamingFiles: [],
    softLockedFiles: [],
    ...over,
  };
}

/* jsdom 无 EventSource：只记录 URL 与关闭动作（连接细节在 store 测试里断言） */
class MockEventSource {
  static instances: MockEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

/** fetch mock 帮手：JSON 响应（session 层读 text 后自行解析） */
function jsonResponse(payload: unknown): Response {
  const text = JSON.stringify(payload);
  return { ok: true, status: 200, json: async () => payload, text: async () => text } as unknown as Response;
}

/** 挂载工作台（快照 + EventSource 全部 mock，不经网络） */
function mountWorkspace(snapshot: WorkspaceSnapshot = makeSnapshot()) {
  const fetchMock = vi.fn().mockResolvedValue(jsonResponse(snapshot));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
  MockEventSource.instances.length = 0;
  return render(createElement(Workspace, { projectId: PROJECT_ID }));
}

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/projects',
}));

beforeEach(() => {
  clearWorkspaceStores();
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* 三栏布局                                                             */
/* ------------------------------------------------------------------ */

describe('Workspace 三栏布局', () => {
  it('三栏容器存在（聊天/文件树/查看器），各栏空态提示就位；卸载关闭 SSE 连接', async () => {
    const { unmount } = mountWorkspace();

    // 快照 hydrate 后标题出现在顶栏
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();

    expect(screen.getByRole('region', { name: '聊天区' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '文件树' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '查看器' })).toBeInTheDocument();

    // 空态提示（聊天/查看器仍为占位；文件树自 T20 起挂真实 FileTree）
    expect(screen.getByText('团队消息与任务时间线会在这里实时展示')).toBeInTheDocument();
    expect(screen.getByText('在文件树中选择文件，在这里查看与编辑')).toBeInTheDocument();

    // 文件树渲染快照文件（docs/app 整棵子树默认展开可见）
    expect(screen.getByRole('tree', { name: '项目文件' })).toBeInTheDocument();
    expect(screen.getByText('index.html')).toBeInTheDocument();
    expect(screen.getByText('prd.md')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下载项目' })).toBeEnabled(); // 快照就绪 → 项目可导出

    unmount();
    expect(MockEventSource.instances[0]?.closed).toBe(true);
  });

  it('快照未就绪也能渲染骨架（顶栏显示加载中，不白屏）', () => {
    const fetchMock = vi.fn().mockReturnValue(new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;
    render(createElement(Workspace, { projectId: PROJECT_ID }));

    expect(screen.getByRole('region', { name: '聊天区' })).toBeInTheDocument();
    expect(screen.getByText('加载中…')).toBeInTheDocument();

    // 项目未就绪：分享没有可复制的地址，必须禁用（防 /p/ 死链 + 假成功提示）
    expect(screen.getByRole('button', { name: '复制分享链接' })).toBeDisabled();
  });

  it('快照加载失败（project 恒 null）：分享保持禁用，不弹「已复制」', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource);
    MockEventSource.instances.length = 0;
    render(createElement(Workspace, { projectId: PROJECT_ID }));

    // 骨架仍在，标题回落为加载中
    expect(await screen.findByText('加载中…')).toBeInTheDocument();
    const shareButton = screen.getByRole('button', { name: '复制分享链接' });
    expect(shareButton).toBeDisabled();

    // 禁用按钮点击不触发复制，也不产生成功 toast
    fireEvent.click(shareButton);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByText('链接已复制')).not.toBeInTheDocument();
  });

  it('顶栏触控目标：<lg 档位扩到 ≥44px（jsdom 不套 CSS，断言响应式标记类）', async () => {
    mountWorkspace();
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();

    // 分享 / 设置：桌面 36px 视觉，<lg 44px
    expect(screen.getByRole('button', { name: '复制分享链接' }).className).toContain('max-lg:size-11');
    expect(screen.getByRole('link', { name: '打开设置' }).className).toContain('max-lg:size-11');
    // 视图切换：列表 48px 且去掉内边距；触发器必须显式 44px——只抬列表高度
    // 会掉进 p-[3px] + h-[calc(100%-1px)] 的坑（48-6-1=41px，不达标）
    const tablist = screen.getByRole('tablist', { name: '视图切换' });
    expect(tablist.className).toContain('max-lg:h-12');
    expect(tablist.className).toContain('max-lg:p-0');
    expect(screen.getByRole('tab', { name: '编辑器' }).className).toContain('max-lg:h-11');
    expect(screen.getByRole('tab', { name: '预览' }).className).toContain('max-lg:h-11');
  });

  it('底部栏目 tab 激活态：扁平栏不漏出原语阴影（同特异性覆盖）', async () => {
    mountWorkspace();
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();

    const className = screen.getByRole('tab', { name: '聊天' }).className;
    expect(className).toContain(
      'group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none',
    );
    // 裸 data-[state=active]:shadow-none 只有 (0,2,0)，压不住原语 (0,3,0) 的阴影——不允许回退
    expect(className).not.toMatch(/(?:^| )data-\[state=active\]:shadow-none/);
  });
});

/* ------------------------------------------------------------------ */
/* 顶栏                                                                 */
/* ------------------------------------------------------------------ */

describe('TopBar 顶栏', () => {
  it('返回 logo / 标题+状态 / 视图切换 / 成员头像排 / 分享 / 设置 / 预留操作容器齐全', async () => {
    mountWorkspace();
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();

    // 返回 logo 与设置入口
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '打开设置' })).toHaveAttribute('href', '/settings');

    // 标题 + 状态徽章（running → 生成中）+ 下拉触发器
    expect(screen.getByText('生成中')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '项目信息' })).toBeInTheDocument();

    // 视图切换 tabs（默认编辑器）
    expect(screen.getByRole('tab', { name: '编辑器' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '预览' })).toHaveAttribute('aria-selected', 'false');

    // 连接指示灯：SSE onopen 后转为已连接
    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();
    if (source !== undefined) {
      act(() => {
        source.onopen?.();
      });
    }
    expect(screen.getByText('实时连接已建立')).toBeInTheDocument();

    // 成员头像排：7 角色全量，运行中角色带「运行中」标记（工程师 running / pm done）
    expect(screen.getByRole('list', { name: '团队成员' })).toBeInTheDocument();
    expect(screen.getByLabelText(`${roleRegistry.engineer.name}·运行中`)).toBeInTheDocument();
    expect(screen.getByLabelText(`${roleRegistry.pm.name}·待命`)).toBeInTheDocument();
    for (const role of ['leader', 'architect', 'analyst', 'seo', 'ads'] as const) {
      expect(screen.getByLabelText(`${roleRegistry[role].name}·待命`)).toBeInTheDocument();
    }

    // 分享按钮 + 预留操作容器
    expect(screen.getByRole('button', { name: '复制分享链接' })).toBeInTheDocument();
    expect(document.querySelector('[data-topbar-actions]')).not.toBeNull();
  });

  it('视图切换到预览：PreviewPane 接管主区（frontend 未产出→占位；产出→装配 iframe）', async () => {
    mountWorkspace();
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();

    // Radix Tabs 在 mousedown 时切换选中（click 不触发）
    fireEvent.mouseDown(screen.getByRole('tab', { name: '预览' }));
    expect(screen.getByRole('tab', { name: '预览' })).toHaveAttribute('aria-selected', 'true');
    // 夹具只有 index.html / docs/prd.md，没有 app/frontend/index.html → 预览占位
    expect(screen.getByText('工程师完成 frontend 后可预览')).toBeInTheDocument();
    expect(screen.queryByText('在文件树中选择文件，在这里查看与编辑')).not.toBeInTheDocument();

    // 工程师产出前端入口后，同一视图直接呈现服务端装配 iframe（T22 接线）
    const withFrontend = makeSnapshot({
      files: [
        ...makeSnapshot().files,
        {
          id: 103,
          path: 'app/frontend/index.html',
          content: '<!doctype html><title>Todo</title>',
          version: 1,
          lastEditor: 'engineer',
          updatedAt: 1_700_000_000_000,
        },
      ],
    });
    cleanup();
    mountWorkspace(withFrontend);
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('tab', { name: '预览' }));
    const iframe = screen.getByTitle('应用预览');
    expect(iframe).toHaveAttribute('src', `/api/projects/${PROJECT_ID}/preview`);
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('分享按钮：复制当前地址并提示成功', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });

    mountWorkspace();
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制分享链接' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/p/${PROJECT_ID}`));
    await waitFor(() => expect(screen.getByText('链接已复制')).toBeInTheDocument());
  });

  it('连接指示灯跟随 SSE 状态（onopen 已连接 / onerror 断线重试）', async () => {
    mountWorkspace(makeSnapshot());

    // MockEventSource 不会自动触发回调：先断线提示，onopen 后转已连接
    expect(await screen.findByText('连接已断开，正在重试')).toBeInTheDocument();

    const source = MockEventSource.instances[0];
    expect(source).toBeDefined();
    if (source === undefined) return;
    act(() => {
      source.onopen?.();
    });
    expect(screen.getByText('实时连接已建立')).toBeInTheDocument();

    act(() => {
      source.onerror?.(new Event('error'));
    });
    expect(screen.getByText('连接已断开，正在重试')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* 窄屏底部栏目切换（断点折叠由 CSS 完成，这里只验选中态）                   */
/* ------------------------------------------------------------------ */

describe('窄屏底部栏目切换', () => {
  it('默认选中聊天，点击后切换选中态', async () => {
    mountWorkspace();
    expect(await screen.findByText('番茄钟应用')).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: '工作区栏目' });
    expect(tablist).toBeInTheDocument();

    const chatTab = screen.getByRole('tab', { name: '聊天' });
    const filesTab = screen.getByRole('tab', { name: '文件' });
    const viewerTab = screen.getByRole('tab', { name: '查看' });
    expect(chatTab).toHaveAttribute('aria-selected', 'true');

    fireEvent.mouseDown(filesTab);
    expect(filesTab).toHaveAttribute('aria-selected', 'true');
    expect(chatTab).toHaveAttribute('aria-selected', 'false');
    expect(viewerTab).toHaveAttribute('aria-selected', 'false');
  });
});
