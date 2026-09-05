/**
 * Task 21 测试：查看器（文件页签 / Markdown / Mermaid 降级 / 打字机滚动 / 编辑态与冲突）。
 *
 * - ViewerTabs 用真实 store（快照 hydrate 走 mock fetch），只 mock 网络；页签开关、激活回调、
 *   流式标记、编辑保存（软锁 PUT + PATCH CAS + 409 冲突）全部走真实组件与真实 REST 封装。
 * - 重依赖隔离：shiki（@/lib/client/highlight）与 mermaid 用 vi.mock 替身，jsdom 不做真高亮/真渲染。
 * - next/dynamic 垫片：next/dynamic(ssr:false) 在 jsdom 恒停在 loading 态（不触发 loader），
 *   测试里等价映射为 React.lazy——被懒加载的查看器视图照常渲染，生产代码仍用 next/dynamic。
 * - TypewriterScroller 在 jsdom 无布局：Object.defineProperty 注入 scrollHeight/scrollTop，
 *   模拟「内容增长 / 用户上滚」，断言跟随与暂停跟随。
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearWorkspaceStores, createWorkspaceStore, type WorkspaceSnapshot } from '@/lib/client/store';
import type { ViewerTabsHandle } from '@/components/viewer/ViewerTabs';
import type { Project } from '@/lib/db/provider/types';

/* next/dynamic 测试垫片（jsdom 下 next/dynamic 永远渲染 loading，React.lazy 行为等价） */
vi.mock('next/dynamic', () => ({
  default: (loader: () => Promise<{ default: React.ComponentType }>): React.ComponentType =>
    React.lazy(loader),
}));

/* next/navigation 只用到 useParams（ViewerTabs 从 /p/[id] 路由自取项目 id） */
vi.mock('next/navigation', () => ({ useParams: () => ({ id: String(PROJECT_ID) }) }));

/* shiki 替身：jsdom 不做真高亮（各用例按需改写实现） */
const highlightMock = vi.hoisted(() => ({
  resolveLanguage: vi.fn<(path: string) => string>(),
  highlightToHtml: vi.fn<(code: string, lang: string) => Promise<string>>(),
  HIGHLIGHT_DEBOUNCE_MS: 120,
}));
vi.mock('@/lib/client/highlight', () => highlightMock);

/* mermaid 替身：jsdom 不做真渲染 */
const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, code: string) => Promise<unknown>>(),
}));
vi.mock('mermaid', () => ({ default: mermaidMock }));

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

/** 三个典型文件：Markdown / Mermaid / 代码（覆盖三种渲染分发） */
function makeSnapshot(over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    project: makeProject(),
    lastSeq: 0,
    messages: [],
    files: [
      {
        id: 101,
        path: 'docs/prd.md',
        content: '# 需求\n\n做一个番茄钟\n\n> 引用要点',
        version: 3,
        lastEditor: 'pm',
        updatedAt: 1_700_000_000_000,
      },
      {
        id: 102,
        path: 'docs/flow.mmd',
        content: 'graph TD; A-->B;',
        version: 1,
        lastEditor: 'architect',
        updatedAt: 1_700_000_000_000,
      },
      {
        id: 103,
        path: 'app/main.js',
        content: 'const a = 1;\nexport default a;\n',
        version: 2,
        lastEditor: 'engineer',
        updatedAt: 1_700_000_000_000,
      },
    ],
    agentRuns: [],
    checkpoints: [],
    usage: [],
    streamingFiles: [],
    softLockedFiles: [],
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* fetch mock（按 方法 + URL 前缀 路由；未命中即抛错，防漏配静默通过）        */
/* ------------------------------------------------------------------ */

interface FetchRoute {
  method: 'GET' | 'PATCH' | 'PUT' | 'POST';
  /** URL 包含该前缀即命中 */
  prefix: string;
  /** 返回响应；需要记录请求体时在 respond 里自行收集 */
  respond: (body: unknown) => Response | Promise<Response>;
}

function jsonResponse(payload: unknown, status = 200): Response {
  const text = JSON.stringify(payload);
  return { ok: status < 400, status, json: async () => payload, text: async () => text } as unknown as Response;
}

function stubFetch(routes: FetchRoute[]): void {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase() as FetchRoute['method'];
    const route = routes.find((item) => item.method === method && url.includes(item.prefix));
    if (route === undefined) throw new Error(`测试未配置该请求：${method} ${url}`);
    const raw = typeof init?.body === 'string' ? init.body : '';
    let body: unknown = null;
    if (raw !== '') {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = raw;
      }
    }
    return route.respond(body);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/**
 * 快照直接灌进 store（不经网络）。
 * 架构口径：数据恢复（快照 hydrate + SSE）由 Workspace 的 useWorkspace 负责（唯一连接拥有者），
 * ViewerTabs 只做细粒度订阅——这里等价于「Workspace 已挂载」的前置状态，也避免测试里开第二条 SSE。
 */
function hydrateStore(snapshot: WorkspaceSnapshot = makeSnapshot()): void {
  createWorkspaceStore(PROJECT_ID).hydrate(snapshot);
}

/** 偏好路由（EditToggle 读取；默认 editing_enabled=true） */
function baseRoutes(editingEnabled = true): FetchRoute[] {
  return [
    {
      method: 'GET',
      prefix: '/api/settings',
      respond: () => jsonResponse({ preferences: { editing_enabled: editingEnabled, default_mode: 'fast' } }),
    },
  ];
}

/** 默认 shiki 替身行为：按路径给语言、返回可断言的 HTML */
function stubHighlight(): void {
  highlightMock.resolveLanguage.mockImplementation((path: string) => (path.endsWith('.js') ? 'javascript' : 'text'));
  highlightMock.highlightToHtml.mockImplementation(async (code: string, lang: string) => `<pre data-lang="${lang}">${code}</pre>`);
}

/* jsdom 无 EventSource：ViewerTabs 不开连接（连接归 useWorkspace），这里仅防漏配 */
class NoEventSource {
  close(): void {}
}

/** 挂载 ViewerTabs（快照 + 偏好走 mock fetch，不经网络） */
async function mountViewer(props: { initialPath?: string | null; onActivePathChange?: (path: string | null) => void } = {}) {
  const { ViewerTabs } = await import('@/components/viewer/ViewerTabs');
  const ref = { current: null as ViewerTabsHandle | null };
  const rendered = render(createElement(ViewerTabs, { ...props, ref }));
  return { ref, ...rendered };
}

/** 给滚动容器注入 jsdom 没有的布局几何，并返回读写 scrollTop 的句柄 */
interface ScrollGeometry {
  height: number;
  top: number;
  contentHeight: number;
}

function injectScrollGeometry(el: Element, geometry: ScrollGeometry): void {
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: geometry.height });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => geometry.contentHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => geometry.top,
    set: (value: number) => {
      geometry.top = value;
    },
  });
}

/** 等待两帧 effect（jsdom 无 rAF 节流，微任务足够） */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  clearWorkspaceStores();
  cleanup();
  vi.stubGlobal('EventSource', NoEventSource as unknown as typeof EventSource);
  highlightMock.resolveLanguage.mockReset();
  highlightMock.highlightToHtml.mockReset();
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
  stubHighlight();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
/* 渲染分发（纯函数）                                                    */
/* ------------------------------------------------------------------ */

describe('viewerKindForPath 渲染分发', () => {
  it('按扩展名分流：md→markdown、mmd→mermaid、其余→code、无扩展名→code', async () => {
    const { viewerKindForPath } = await import('@/components/viewer/ViewerTabs');
    expect(viewerKindForPath('docs/prd.md')).toBe('markdown');
    expect(viewerKindForPath('docs/README.markdown')).toBe('markdown');
    expect(viewerKindForPath('docs/architecture.mmd')).toBe('mermaid');
    expect(viewerKindForPath('docs/design.mermaid')).toBe('mermaid');
    expect(viewerKindForPath('app/main.js')).toBe('code');
    expect(viewerKindForPath('Dockerfile')).toBe('code');
  });
});

/* ------------------------------------------------------------------ */
/* ViewerTabs 页签开关                                                   */
/* ------------------------------------------------------------------ */

describe('ViewerTabs 页签', () => {
  it('initialPath 打开页签并渲染 Markdown；激活路径经 onActivePathChange 上报', async () => {
    const onActivePathChange = vi.fn();
    hydrateStore();
    stubFetch(baseRoutes());
    await mountViewer({ initialPath: 'docs/prd.md', onActivePathChange });

    // 页签：文件名 + 激活态
    const tab = await screen.findByRole('tab', { name: 'prd.md' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(onActivePathChange).toHaveBeenCalledWith('docs/prd.md');

    // Markdown 渲染（react-markdown：标题 / 段落 / 引用徽章）
    expect(await screen.findByRole('heading', { level: 1, name: '需求' })).toBeInTheDocument();
    expect(screen.getByText('做一个番茄钟')).toBeInTheDocument();
    expect(screen.getByText('引用')).toBeInTheDocument();

    // 文件头：完整路径 + 最后编辑者（PM）
    expect(screen.getByText('docs/prd.md')).toBeInTheDocument();
    expect(screen.getByText('产品经理 修改')).toBeInTheDocument();

    // 流式面板统一走打字机滚动（brief「流式文件自动滚动」不限于代码文件）
    expect(screen.getByTestId('typewriter-scroller')).toBeInTheDocument();
  });

  it('Markdown 表格（remark-gfm）：管道表格渲染成 table 而非碎段落', async () => {
    hydrateStore(
      makeSnapshot({
        files: [
          {
            id: 104,
            path: 'docs/table.md',
            content: '| 字段 | 说明 |\n| --- | --- |\n| path | 文件路径 |\n| version | 版本号 |',
            version: 1,
            lastEditor: 'pm',
            updatedAt: 1_700_000_000_000,
          },
        ],
      }),
    );
    stubFetch(baseRoutes());
    await mountViewer({ initialPath: 'docs/table.md' });

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: '字段' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '文件路径' })).toBeInTheDocument();
    // 碎段落形态（gfm 缺失时的退化）不应出现
    expect(screen.queryByText('| 字段 | 说明 |')).not.toBeInTheDocument();
  });

  it('打开第二个文件 / 点击切换 / 关闭回收；重复打开不产生重复页签', async () => {
    const onActivePathChange = vi.fn();
    hydrateStore();
    stubFetch(baseRoutes());
    const { ref } = await mountViewer({ onActivePathChange });

    expect(await screen.findByText('在文件树中选择文件，在这里查看与编辑')).toBeInTheDocument();
    act(() => {
      ref.current?.openFile('docs/prd.md');
      ref.current?.openFile('app/main.js');
      ref.current?.openFile('app/main.js'); // 重复打开：只激活，不加页签
    });
    expect(await screen.findByRole('tab', { name: 'main.js' })).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.getByRole('tab', { name: 'main.js' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('app/main.js')).toBeInTheDocument();
    expect(onActivePathChange).toHaveBeenLastCalledWith('app/main.js');

    // 点击另一个页签 → 激活切换
    fireEvent.click(screen.getByRole('tab', { name: 'prd.md' }));
    expect(screen.getByRole('tab', { name: 'prd.md' })).toHaveAttribute('aria-selected', 'true');
    expect(onActivePathChange).toHaveBeenLastCalledWith('docs/prd.md');

    // 关闭非激活页签：激活态不动
    fireEvent.click(screen.getByRole('button', { name: '关闭 main.js' }));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.getByRole('tab', { name: 'prd.md' })).toHaveAttribute('aria-selected', 'true');

    // 关闭最后一个页签 → 回空态，激活路径上报 null
    fireEvent.click(screen.getByRole('button', { name: '关闭 prd.md' }));
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(await screen.findByText('在文件树中选择文件，在这里查看与编辑')).toBeInTheDocument();
    expect(onActivePathChange).toHaveBeenLastCalledWith(null);
  });

  it('流式中的文件：页签带生成中标记，查看器显示已到内容，编辑不可用', async () => {
    hydrateStore(makeSnapshot({ files: [], streamingFiles: [{ path: 'app/main.js', content: 'const live' }] }));
    stubFetch(baseRoutes());
    await mountViewer({ initialPath: 'app/main.js' });

    // 页签（sr-only 标记）与文件头都标明流式状态
    expect((await screen.findAllByText('生成中')).length).toBeGreaterThan(0);
    // 打字机容器里已到的内容照常渲染（流式高亮走 debounce）
    expect(await screen.findByText(/const live/)).toBeInTheDocument();
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    expect(editButton).toBeDisabled();
  });

  it('Mermaid 文件走 MermaidView（替身渲染出 SVG）', async () => {
    mermaidMock.render.mockImplementation(async () => ({ svg: '<svg data-mermaid-ok="1" />', bindFunctions: () => undefined }));
    hydrateStore();
    stubFetch(baseRoutes());
    const { container } = await mountViewer({ initialPath: 'docs/flow.mmd' });

    await waitFor(() => expect(mermaidMock.render).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-mermaid-ok]')).not.toBeNull();
    expect(screen.queryByText('图表语法错误')).not.toBeInTheDocument();
    // 图表面板也走打字机滚动（架构师流式画图期间跟随到底部）
    expect(screen.getByTestId('typewriter-scroller')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* CodeView 流式高亮 debounce（shiki 用替身，jsdom 不做真高亮）              */
/* ------------------------------------------------------------------ */

describe('CodeView 流式高亮 debounce', () => {
  it('流式态：内容更新后 120ms 才高亮，窗口内的多次更新只保留最后一次', async () => {
    const { CodeView } = await import('@/components/viewer/CodeView');
    vi.useFakeTimers();

    const { rerender } = render(
      createElement(CodeView, { content: 'const a =', path: 'app/main.js', streaming: true }),
    );
    // 挂载即高亮一次（已到内容立即可读），后续更新进入 120ms 合批窗口
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(highlightMock.highlightToHtml).toHaveBeenCalledTimes(1);
    expect(highlightMock.highlightToHtml).toHaveBeenCalledWith('const a =', 'javascript');

    // 窗口内的连续 delta：只保留最后一次
    rerender(createElement(CodeView, { content: 'const a =', path: 'app/main.js', streaming: true }));
    rerender(createElement(CodeView, { content: 'const a = 1;', path: 'app/main.js', streaming: true }));
    await act(async () => {
      vi.advanceTimersByTime(119);
    });
    expect(highlightMock.highlightToHtml).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(highlightMock.highlightToHtml).toHaveBeenCalledTimes(2);
    expect(highlightMock.highlightToHtml).toHaveBeenLastCalledWith('const a = 1;', 'javascript');
  });

  it('非流式（已定版）：内容变化立即高亮，不等 debounce', async () => {
    const { CodeView } = await import('@/components/viewer/CodeView');
    vi.useFakeTimers();
    const { rerender } = render(
      createElement(CodeView, { content: 'const b = 2;', path: 'app/main.js', streaming: false }),
    );
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(highlightMock.highlightToHtml).toHaveBeenCalledTimes(1);

    rerender(createElement(CodeView, { content: 'const b = 3;', path: 'app/main.js', streaming: false }));
    await act(async () => {
      vi.advanceTimersByTime(0);
    });
    expect(highlightMock.highlightToHtml).toHaveBeenCalledTimes(2);
    expect(highlightMock.highlightToHtml).toHaveBeenLastCalledWith('const b = 3;', 'javascript');
  });

  it('高亮失败（语言不支持等）降级为纯文本 pre，不白屏', async () => {
    highlightMock.highlightToHtml.mockRejectedValue(new Error('语言不存在'));
    const { CodeView } = await import('@/components/viewer/CodeView');
    render(createElement(CodeView, { content: 'const c = 3;', path: 'weird/file.weird', streaming: false }));
    expect(await screen.findByText('const c = 3;')).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ */
/* MermaidView 渲染失败降级                                              */
/* ------------------------------------------------------------------ */

describe('MermaidView 渲染', () => {
  it('坏语法：try/catch 降级为源码 + 「图表语法错误」提示条', async () => {
    mermaidMock.render.mockRejectedValue(new Error('Parse error on line 2'));
    const { MermaidView } = await import('@/components/viewer/MermaidView');
    render(createElement(MermaidView, { content: 'graph TD; A-->' }));

    expect(await screen.findByText('图表语法错误')).toBeInTheDocument();
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    // 源码照常可见（用户可自行修正后重试）
    expect(screen.getByText('graph TD; A-->')).toBeInTheDocument();
  });

  it('语法修正后重试：再次渲染并清除降级提示', async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error('Parse error')).mockResolvedValueOnce({
      svg: '<svg data-mermaid-ok="1" />',
      bindFunctions: () => undefined,
    });
    const { MermaidView } = await import('@/components/viewer/MermaidView');
    const { rerender } = render(createElement(MermaidView, { content: 'graph TD; A-->' }));
    expect(await screen.findByText('图表语法错误')).toBeInTheDocument();

    rerender(createElement(MermaidView, { content: 'graph TD; A-->B;' }));
    await screen.findByText('图表语法错误'); // 渲染中先保留旧提示
    await waitFor(() => expect(screen.queryByText('图表语法错误')).not.toBeInTheDocument());
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
  });
});

/* ------------------------------------------------------------------ */
/* TypewriterScroller 跟随滚动                                           */
/* ------------------------------------------------------------------ */

describe('TypewriterScroller 自动滚动', () => {
  // 本文件其余用例用 createElement（跟随 store.test 既有风格）；这里 children 是必填 prop，
  // createElement 形态会被 TS 拒收（P 含 children），故直接用 JSX 表达
  async function mountScroller(props: { streaming?: boolean; scrollKey: number }) {
    const { TypewriterScroller } = await import('@/components/viewer/TypewriterScroller');
    const utils = render(
      <TypewriterScroller streaming={props.streaming ?? true} scrollKey={props.scrollKey}>
        <p>内容</p>
      </TypewriterScroller>,
    );
    return { ...utils, TypewriterScroller };
  }

  it('流式内容增长时自动跟随到底部；用户上滚后暂停跟随', async () => {
    const geometry: ScrollGeometry = { height: 300, top: 0, contentHeight: 500 };
    const { rerender, TypewriterScroller } = await mountScroller({ scrollKey: 10 });
    const el = screen.getByTestId('typewriter-scroller');
    // jsdom 无布局：注入几何后模拟「内容增长」（scrollKey 变化触发跟随滚动）
    injectScrollGeometry(el, geometry);
    rerender(
      <TypewriterScroller streaming scrollKey={11}>
        <p>内容</p>
      </TypewriterScroller>,
    );
    await settle();
    expect(geometry.top).toBe(500);

    // 内容继续增长 → 继续跟随
    geometry.contentHeight = 900;
    rerender(
      <TypewriterScroller streaming scrollKey={12}>
        <p>内容</p>
      </TypewriterScroller>,
    );
    await settle();
    expect(geometry.top).toBe(900);

    // 用户上滚 → 暂停跟随，内容继续增长也不再拖动；出现「回到底部」
    geometry.top = 300;
    fireEvent.scroll(el);
    geometry.contentHeight = 1200;
    rerender(
      <TypewriterScroller streaming scrollKey={13}>
        <p>内容</p>
      </TypewriterScroller>,
    );
    await settle();
    expect(geometry.top).toBe(300);
    expect(screen.getByRole('button', { name: '回到底部' })).toBeInTheDocument();
  });

  it('回到底部按钮：点击后恢复跟随', async () => {
    const geometry: ScrollGeometry = { height: 300, top: 0, contentHeight: 500 };
    const { rerender, TypewriterScroller } = await mountScroller({ scrollKey: 10 });
    const el = screen.getByTestId('typewriter-scroller');
    injectScrollGeometry(el, geometry);

    // 上滚暂停（此刻尚未跟随任何内容）
    geometry.top = 100;
    fireEvent.scroll(el);
    geometry.contentHeight = 800;
    rerender(
      <TypewriterScroller streaming scrollKey={11}>
        <p>内容</p>
      </TypewriterScroller>,
    );
    await settle();
    expect(geometry.top).toBe(100);

    // 回到底部 → 恢复跟随
    fireEvent.click(screen.getByRole('button', { name: '回到底部' }));
    expect(geometry.top).toBe(800);
    geometry.contentHeight = 1000;
    rerender(
      <TypewriterScroller streaming scrollKey={12}>
        <p>内容</p>
      </TypewriterScroller>,
    );
    await settle();
    expect(geometry.top).toBe(1000);
  });
});

/* ------------------------------------------------------------------ */
/* ConflictDialog 三选                                                   */
/* ------------------------------------------------------------------ */

describe('ConflictDialog 冲突三选', () => {
  const MINE = '第一行\n我的第二行';
  const THEIRS = '第一行\nagent 的第二行';

  async function mountDialog() {
    const { ConflictDialog } = await import('@/components/viewer/ConflictDialog');
    const onKeepMine = vi.fn();
    const onUseTheirs = vi.fn();
    render(
      createElement(ConflictDialog, {
        open: true,
        onOpenChange: () => undefined,
        mine: MINE,
        theirs: THEIRS,
        onKeepMine,
        onUseTheirs,
      }),
    );
    return { onKeepMine, onUseTheirs };
  }

  it('标题为「工程师已更新」，点「用我的版本」回调 onKeepMine', async () => {
    const { onKeepMine, onUseTheirs } = await mountDialog();
    expect(await screen.findByText('工程师已更新')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '用我的版本' }));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
    expect(onUseTheirs).not.toHaveBeenCalled();
  });

  it('点「用 agent 的版本」回调 onUseTheirs', async () => {
    const { onKeepMine, onUseTheirs } = await mountDialog();
    expect(await screen.findByText('工程师已更新')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '用 agent 的版本' }));
    expect(onUseTheirs).toHaveBeenCalledTimes(1);
    expect(onKeepMine).not.toHaveBeenCalled();
  });

  it('「并排对比」展开两栏 diff（整行红绿），展开后仍可选择保留哪版', async () => {
    const { onKeepMine } = await mountDialog();
    expect(await screen.findByText('工程师已更新')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '并排对比' }));

    // 两栏都可见：我的版本行 + agent 版本行（diff 行级着色）
    expect(screen.getByText('我的第二行')).toBeInTheDocument();
    expect(screen.getByText('agent 的第二行')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '用我的版本' }));
    expect(onKeepMine).toHaveBeenCalledTimes(1);
  });

  it('diffLines：相同行配对，差异行同行对照（整行级），缺行的一侧补 null', async () => {
    const { diffLines } = await import('@/lib/client/diff-lines');
    expect(diffLines('a\nb\nc', 'a\nX\nc')).toEqual([
      { left: 'a', right: 'a', same: true },
      { left: 'b', right: 'X', same: false },
      { left: 'c', right: 'c', same: true },
    ]);
    expect(diffLines('a\nb', 'a')).toEqual([
      { left: 'a', right: 'a', same: true },
      { left: 'b', right: null, same: false },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 编辑态：软锁 + 保存 + 冲突                                             */
/* ------------------------------------------------------------------ */

describe('查看器编辑态（软锁 / 保存 / 冲突）', () => {
  it('偏好开关关闭时不渲染编辑按钮', async () => {
    hydrateStore();
    stubFetch(baseRoutes(false));
    await mountViewer({ initialPath: 'app/main.js' });
    expect(await screen.findByText('app/main.js')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: '编辑文件' })).not.toBeInTheDocument());
  });

  /** 模拟服务端真实 CAS：baseVersion 必须等于服务端当前版本，成功即 +1（不再慷慨放行） */
  function casRoute(collector: { patchBodies: unknown[] }) {
    let serverVersion = 2;
    let serverContent = 'const a = 1;\nexport default a;\n';
    return {
      get serverVersion() {
        return serverVersion;
      },
      get serverContent() {
        return serverContent;
      },
      route: {
        method: 'PATCH' as const,
        prefix: `/api/projects/${PROJECT_ID}/files/103`,
        respond: (body: unknown) => {
          collector.patchBodies.push(body);
          const patch = body as { content: string; baseVersion: number };
          if (patch.baseVersion !== serverVersion) {
            return jsonResponse({ conflict: true, current: serverContent }, 409);
          }
          serverContent = patch.content;
          serverVersion += 1;
          return jsonResponse({ version: serverVersion });
        },
      },
    };
  }

  it('进入编辑置软锁，保存发 PATCH {content, baseVersion}，成功后退出编辑并释放软锁', async () => {
    const lockBodies: unknown[] = [];
    const patchBodies: unknown[] = [];
    const cas = casRoute({ patchBodies });
    stubFetch([
      ...baseRoutes(),
      {
        method: 'PUT',
        prefix: `/api/projects/${PROJECT_ID}/files/103/lock`,
        respond: (body) => {
          lockBodies.push(body);
          return jsonResponse({});
        },
      },
      cas.route,
    ]);

    hydrateStore();
    await mountViewer({ initialPath: 'app/main.js' });
    // 快照已就绪（fileId 可用）才可进入编辑
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);

    // 进入编辑：textarea 带原文，软锁声明（PUT lock on）
    const textarea = await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    expect(textarea).toHaveValue('const a = 1;\nexport default a;\n');
    await waitFor(() => expect(lockBodies).toEqual([{ on: true }]));

    fireEvent.change(textarea, { target: { value: 'const a = 2;\nexport default a;\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(patchBodies).toEqual([{ content: 'const a = 2;\nexport default a;\n', baseVersion: 2 }]),
    );
    // 保存成功 → 退出编辑 + 释放软锁
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑 app/main.js' })).not.toBeInTheDocument());
    expect(lockBodies).toEqual([{ on: true }, { on: false }]);
  });

  it('保存成功后 store 就地推进：回显新内容，二次编辑以新版本号保存不再 409', async () => {
    const lockBodies: unknown[] = [];
    const patchBodies: unknown[] = [];
    const cas = casRoute({ patchBodies });
    stubFetch([
      ...baseRoutes(),
      {
        method: 'PUT',
        prefix: `/api/projects/${PROJECT_ID}/files/103/lock`,
        respond: (body) => {
          lockBodies.push(body);
          return jsonResponse({});
        },
      },
      cas.route,
    ]);

    hydrateStore();
    await mountViewer({ initialPath: 'app/main.js' });
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);

    const textarea = await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    fireEvent.change(textarea, { target: { value: 'const a = 2;\nexport default a;\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    // ① 首次保存带快照版本 2，成功后服务端已是 v3
    await waitFor(() =>
      expect(patchBodies).toEqual([{ content: 'const a = 2;\nexport default a;\n', baseVersion: 2 }]),
    );
    expect(cas.serverVersion).toBe(3);
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑 app/main.js' })).not.toBeInTheDocument());
    expect(screen.queryByText('工程师已更新')).not.toBeInTheDocument();

    // ② 查看态回显的是刚保存的内容（PATCH 不发 SSE，必须由 store 本地推进，否则回显旧内容）
    expect(await screen.findByText(/const a = 2;/)).toBeInTheDocument();

    // ③ 二次编辑：草稿来自 store（新内容），保存以新版本号 3 → 不再 409（否则无限冲突循环）
    fireEvent.click(await screen.findByRole('button', { name: '编辑文件' }));
    const second = await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    expect(second).toHaveValue('const a = 2;\nexport default a;\n');
    fireEvent.change(second, { target: { value: 'const a = 3;\nexport default a;\n' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() =>
      expect(patchBodies[1]).toEqual({ content: 'const a = 3;\nexport default a;\n', baseVersion: 3 }),
    );
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑 app/main.js' })).not.toBeInTheDocument());
    expect(screen.queryByText('工程师已更新')).not.toBeInTheDocument();
    expect(lockBodies).toEqual([{ on: true }, { on: false }, { on: true }, { on: false }]);
  });

  it('409 冲突 → 冲突对话框；用我的版本以最新版本重发；用 agent 的版本放弃草稿', async () => {
    const lockBodies: unknown[] = [];
    const patchBodies: unknown[] = [];
    stubFetch([
      ...baseRoutes(),
      {
        method: 'PUT',
        prefix: `/api/projects/${PROJECT_ID}/files/103/lock`,
        respond: (body) => {
          lockBodies.push(body);
          return jsonResponse({});
        },
      },
      {
        method: 'PATCH',
        prefix: `/api/projects/${PROJECT_ID}/files/103`,
        respond: (body) => {
          // 真实 CAS：agent 已把服务端推进到 v3，只有 baseVersion=3 能成功
          patchBodies.push(body);
          const patch = body as { content: string; baseVersion: number };
          return patch.baseVersion !== 3
            ? jsonResponse({ conflict: true, current: 'agent 写的最新内容' }, 409)
            : jsonResponse({ version: 4 });
        },
      },
    ]);

    hydrateStore();
    await mountViewer({ initialPath: 'app/main.js' });
    // 快照已就绪（fileId 可用）才可进入编辑
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);
    const textarea = await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    fireEvent.change(textarea, { target: { value: '我的修改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    // 409 → 冲突对话框（含 agent 最新内容预览）；此时 store 仍停在 v2（SSE 未到）
    expect(await screen.findByText('工程师已更新')).toBeInTheDocument();
    expect(screen.getByText('agent 写的最新内容')).toBeInTheDocument();
    expect(patchBodies).toEqual([{ content: '我的修改', baseVersion: 2 }]);

    // agent 写入随 SSE 到达（file_end 带 meta.version）：store 版本推进到 3
    act(() => {
      createWorkspaceStore(PROJECT_ID).applyEvent({
        seq: 1,
        projectId: PROJECT_ID,
        runId: null,
        event: 'file_end',
        agent: 'engineer',
        path: 'app/main.js',
        meta: { version: 3 },
      });
    });

    // 用我的版本：以 SSE 推进到的最新版本重发 → 成功（过期版本会一直冲突）
    fireEvent.click(screen.getByRole('button', { name: '用我的版本' }));
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toEqual({ content: '我的修改', baseVersion: 3 });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑 app/main.js' })).not.toBeInTheDocument());
    expect(lockBodies).toEqual([{ on: true }, { on: false }]);
  });

  it('SSE 断连期间 409 体回带 version：「用我的版本」用它就地重发一次成功（T25）', async () => {
    const lockBodies: unknown[] = [];
    const patchBodies: unknown[] = [];
    stubFetch([
      ...baseRoutes(),
      {
        method: 'PUT',
        prefix: `/api/projects/${PROJECT_ID}/files/103/lock`,
        respond: (body) => {
          lockBodies.push(body);
          return jsonResponse({});
        },
      },
      {
        method: 'PATCH',
        prefix: `/api/projects/${PROJECT_ID}/files/103`,
        respond: (body) => {
          patchBodies.push(body);
          const patch = body as { content: string; baseVersion: number };
          // agent 已把服务端推进到 v3，但 SSE 断连：store 始终停在 v2，只能靠 409 体里的 version
          return patch.baseVersion !== 3
            ? jsonResponse({ conflict: true, current: 'agent 写的最新内容', version: 3 }, 409)
            : jsonResponse({ version: 4 });
        },
      },
    ]);

    hydrateStore();
    await mountViewer({ initialPath: 'app/main.js' });
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);
    const textarea = await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    fireEvent.change(textarea, { target: { value: '我的修改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText('工程师已更新')).toBeInTheDocument();
    expect(patchBodies).toEqual([{ content: '我的修改', baseVersion: 2 }]);

    // 全程无 SSE（store 版本仍停在 v2）——「用我的版本」以 409 回带的 version=3 重发
    fireEvent.click(screen.getByRole('button', { name: '用我的版本' }));
    await waitFor(() => expect(patchBodies).toHaveLength(2));
    expect(patchBodies[1]).toEqual({ content: '我的修改', baseVersion: 3 });
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑 app/main.js' })).not.toBeInTheDocument());
    expect(lockBodies).toEqual([{ on: true }, { on: false }]);
  });

  it('agent 流式写同文件期间人工保存拒存：不发 PATCH，提示稍候（T25）', async () => {
    const patchBodies: unknown[] = [];
    const lockBodies: unknown[] = [];
    stubFetch([
      ...baseRoutes(),
      {
        method: 'PUT',
        prefix: `/api/projects/${PROJECT_ID}/files/103/lock`,
        respond: (body) => {
          lockBodies.push(body);
          return jsonResponse({});
        },
      },
      {
        method: 'PATCH',
        prefix: `/api/projects/${PROJECT_ID}/files/103`,
        respond: (body) => {
          patchBodies.push(body);
          return jsonResponse({ version: 3 });
        },
      },
    ]);

    hydrateStore();
    await mountViewer({ initialPath: 'app/main.js' });
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);
    const textarea = await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    fireEvent.change(textarea, { target: { value: '我的修改' } });

    // 编辑期间工程师开始重写同一文件（file_start → streaming）
    act(() => {
      createWorkspaceStore(PROJECT_ID).applyEvent({
        seq: 1,
        projectId: PROJECT_ID,
        runId: null,
        event: 'file_start',
        agent: 'engineer',
        path: 'app/main.js',
      });
    });

    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));

    // 拒存：PATCH 一次都不发，编辑态与草稿保留，给中文提示
    expect(patchBodies).toEqual([]);
    expect(await screen.findByText('该文件正在生成中，请稍候')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '编辑 app/main.js' })).toBeInTheDocument();

    // 生成结束后可正常保存（草稿未丢）
    act(() => {
      createWorkspaceStore(PROJECT_ID).applyEvent({
        seq: 2,
        projectId: PROJECT_ID,
        runId: null,
        event: 'file_end',
        agent: 'engineer',
        path: 'app/main.js',
        meta: { version: 3 },
      });
    });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ content: '我的修改', baseVersion: 3 });
  });

  it('409 后选择「用 agent 的版本」：放弃草稿退出编辑，软锁释放', async () => {
    const lockBodies: unknown[] = [];
    stubFetch([
      ...baseRoutes(),
      {
        method: 'PUT',
        prefix: `/api/projects/${PROJECT_ID}/files/103/lock`,
        respond: (body) => {
          lockBodies.push(body);
          return jsonResponse({});
        },
      },
      {
        method: 'PATCH',
        prefix: `/api/projects/${PROJECT_ID}/files/103`,
        respond: () => jsonResponse({ conflict: true, current: 'agent 写的最新内容' }, 409),
      },
    ]);

    hydrateStore();
    await mountViewer({ initialPath: 'app/main.js' });
    // 快照已就绪（fileId 可用）才可进入编辑
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);
    const textarea = await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    fireEvent.change(textarea, { target: { value: '我的修改' } });
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(await screen.findByText('工程师已更新')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '用 agent 的版本' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑 app/main.js' })).not.toBeInTheDocument());
    expect(lockBodies).toEqual([{ on: true }, { on: false }]);
    expect(screen.queryByText('工程师已更新')).not.toBeInTheDocument();
  });

  it('取消编辑：不发 PATCH，软锁释放', async () => {
    const lockBodies: unknown[] = [];
    const patchBodies: unknown[] = [];
    stubFetch([
      ...baseRoutes(),
      {
        method: 'PUT',
        prefix: `/api/projects/${PROJECT_ID}/files/103/lock`,
        respond: (body) => {
          lockBodies.push(body);
          return jsonResponse({});
        },
      },
      {
        method: 'PATCH',
        prefix: `/api/projects/${PROJECT_ID}/files/103`,
        respond: (body) => {
          patchBodies.push(body);
          return jsonResponse({ version: 3 });
        },
      },
    ]);

    hydrateStore();
    await mountViewer({ initialPath: 'app/main.js' });
    // 快照已就绪（fileId 可用）才可进入编辑
    const editButton = await screen.findByRole('button', { name: '编辑文件' });
    await waitFor(() => expect(editButton).toBeEnabled());
    fireEvent.click(editButton);
    await screen.findByRole('textbox', { name: '编辑 app/main.js' });
    await waitFor(() => expect(lockBodies).toEqual([{ on: true }]));

    fireEvent.click(screen.getByRole('button', { name: '取消编辑' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '编辑 app/main.js' })).not.toBeInTheDocument());
    expect(patchBodies).toEqual([]);
    expect(lockBodies).toEqual([{ on: true }, { on: false }]);
  });
});
