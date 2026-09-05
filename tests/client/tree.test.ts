/**
 * Task 20 测试：文件树。
 *
 * 两层各测各的：buildTree 纯函数（嵌套/排序/过滤/空输入/默认展开）覆盖全部结构规则；
 * FileTree 组件以 props 驱动（files Map + activePath/onSelect），断言渲染、搜索、
 * M 角标配色、流式行数、选中回调与下载入口。不经过 store/网络（Workspace 层接线归 T25）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { FileTree, type FileTreeProps } from '@/components/tree/FileTree';
import { buildTree, countLines, defaultExpandedDirs } from '@/lib/client/tree';
import type { WorkspaceFile } from '@/lib/client/store';

/* ------------------------------------------------------------------ */
/* buildTree 纯函数                                                     */
/* ------------------------------------------------------------------ */

describe('buildTree 结构', () => {
  it('空输入 → 空数组', () => {
    expect(buildTree([])).toEqual([]);
  });

  it('根级文件直接挂在根上，path/name/kind 齐全', () => {
    expect(buildTree(['README.md'])).toEqual([
      { path: 'README.md', name: 'README.md', kind: 'file', children: [] },
    ]);
  });

  it('嵌套路径折叠成目录树，目录含全部后代', () => {
    const tree = buildTree(['app/frontend/index.html', 'app/backend/api.js']);
    expect(tree).toHaveLength(1);
    const app = tree[0];
    expect(app?.path).toBe('app');
    expect(app?.kind).toBe('dir');
    expect(app?.children.map((node) => node.path)).toEqual(['app/backend', 'app/frontend']);
    expect(app?.children[0]?.children[0]?.path).toBe('app/backend/api.js');
    expect(app?.children[0]?.children[0]?.name).toBe('api.js');
  });

  it('排序：目录在前、文件在后，组内大小写不敏感字母序', () => {
    const tree = buildTree(['Beta.md', 'alpha.ts', 'docs/note.md', 'App/main.js', 'Archive/old.txt']);
    expect(tree.map((node) => `${node.kind}:${node.name}`)).toEqual([
      'dir:App',
      'dir:Archive',
      'dir:docs',
      'file:alpha.ts',
      'file:Beta.md',
    ]);
  });

  it('重复路径只出现一次（防御：Map 键天然唯一，纯函数自身也保证）', () => {
    const tree = buildTree(['docs/prd.md', 'docs/prd.md']);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children).toHaveLength(1);
  });

  it('同段名文件与目录并存时互不吞并（docs 文件 + docs.md 文件）', () => {
    const tree = buildTree(['docs/prd.md', 'docs.md']);
    expect(tree.map((node) => node.path)).toEqual(['docs', 'docs.md']);
    expect(tree[0]?.children[0]?.path).toBe('docs/prd.md');
  });
});

describe('buildTree 过滤', () => {
  const PATHS = ['docs/prd.md', 'docs/design/arch.md', 'app/frontend/index.html', 'README.md'];

  it('按文件路径子串过滤，裁掉无命中的分支', () => {
    const tree = buildTree(PATHS, { filter: 'prd' });
    expect(tree.map((node) => node.path)).toEqual(['docs']);
    expect(tree[0]?.children.map((node) => node.path)).toEqual(['docs/prd.md']);
  });

  it('命中目录名 → 整棵子树保留', () => {
    const tree = buildTree(PATHS, { filter: 'docs' });
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children.map((node) => node.path)).toEqual(['docs/design', 'docs/prd.md']);
  });

  it('大小写不敏感', () => {
    const tree = buildTree(PATHS, { filter: 'INDEX' });
    expect(tree[0]?.children[0]?.children[0]?.path).toBe('app/frontend/index.html');
  });

  it('无命中 → 空数组（组件据此显示「无匹配」）', () => {
    expect(buildTree(PATHS, { filter: '不存在' })).toEqual([]);
  });

  it('空白过滤串视同不过滤', () => {
    expect(buildTree(['README.md'], { filter: '   ' })).toEqual([
      { path: 'README.md', name: 'README.md', kind: 'file', children: [] },
    ]);
  });
});

describe('defaultExpandedDirs / countLines', () => {
  it('.atoms / docs / app 顶层目录整棵子树默认展开，白名单外目录不在内', () => {
    const expanded = defaultExpandedDirs([
      'docs/prd.md',
      'app/frontend/index.html',
      'app/backend/api.js',
      '.atoms/run.json',
      'src/lib/util.ts',
      'README.md',
    ]);
    expect([...expanded].sort()).toEqual(['.atoms', 'app', 'app/backend', 'app/frontend', 'docs']);
  });

  it('空输入 → 空集合', () => {
    expect(defaultExpandedDirs([]).size).toBe(0);
  });

  it('countLines：按换行计数，空内容为 0 行', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('a\n')).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* FileTree 组件（props 驱动，不接 store）                                */
/* ------------------------------------------------------------------ */

const FILES: readonly (readonly [path: string, editor: WorkspaceFile['lastEditor']])[] = [
  ['docs/prd.md', 'pm'],
  ['app/frontend/index.html', 'human'],
  ['app/backend/api.js', 'engineer'],
  ['README.md', 'seed'],
];

function makeFiles(extra?: readonly (readonly [string, WorkspaceFile])[]): Map<string, WorkspaceFile> {
  const files = new Map<string, WorkspaceFile>();
  for (const [path, editor] of FILES) {
    files.set(path, { content: `# ${path}\n正文`, version: 1, lastEditor: editor, streaming: false });
  }
  for (const [path, file] of extra ?? []) files.set(path, file);
  return files;
}

function renderTree(over: Partial<FileTreeProps> = {}): { onSelect: ReturnType<typeof vi.fn> } {
  const onSelect = vi.fn<(path: string) => void>();
  const props: FileTreeProps = { files: makeFiles(), onSelect, ...over };
  render(createElement(FileTree, props));
  return { onSelect };
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FileTree 渲染', () => {
  it('目录树按默认展开渲染：docs/app 可见，未列入默认的目录折叠且可展开', () => {
    const files = makeFiles([
      ['src/lib/util.ts', { content: 'export {};', version: 1, lastEditor: 'engineer', streaming: false }],
    ]);
    renderTree({ files });

    // 默认展开：docs / app 后代可见
    expect(screen.getByRole('treeitem', { name: /docs/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('treeitem', { name: /app/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('prd.md')).toBeInTheDocument();
    expect(screen.getByText('index.html')).toBeInTheDocument();
    expect(screen.getByText('api.js')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();

    // 非默认目录折叠：后代不渲染；白名单外的目录逐层展开（src → lib → util.ts）
    const src = screen.getByRole('treeitem', { name: /src/ });
    expect(src).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('util.ts')).not.toBeInTheDocument();
    fireEvent.click(src);
    fireEvent.click(screen.getByRole('treeitem', { name: /lib/ }));
    expect(screen.getByText('util.ts')).toBeInTheDocument();
  });

  it('空项目 → 空态文案（与工作台栏位占位同源），不渲染搜索框', () => {
    renderTree({ files: new Map() });
    expect(screen.getByText('生成开始后，文件会在这里长出目录树')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('目录折叠可再收起（覆盖默认展开项的手动折叠）', () => {
    renderTree();
    const docs = screen.getByRole('treeitem', { name: /docs/ });
    fireEvent.click(docs);
    expect(docs).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('prd.md')).not.toBeInTheDocument();
  });
});

describe('FileTree 搜索过滤', () => {
  it('输入过滤词只剩命中文件，清空后恢复全量', () => {
    renderTree();
    const input = screen.getByRole('textbox', { name: '搜索文件' });
    fireEvent.change(input, { target: { value: 'prd' } });

    expect(screen.getByText('prd.md')).toBeInTheDocument();
    expect(screen.queryByText('index.html')).not.toBeInTheDocument();
    expect(screen.queryByText('README.md')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('index.html')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('搜索时命中目录自动展开（过滤期间不依赖手动展开态）', () => {
    renderTree();
    // app 默认展开，这里用非默认目录验证：折叠状态下搜索仍能命中后代
    fireEvent.click(screen.getByRole('treeitem', { name: /docs/ }));
    expect(screen.queryByText('prd.md')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索文件' }), { target: { value: 'prd' } });
    expect(screen.getByText('prd.md')).toBeInTheDocument();
  });

  it('无匹配给出明确空态', () => {
    renderTree();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索文件' }), { target: { value: 'zzz' } });
    expect(screen.getByText('没有匹配「zzz」的文件')).toBeInTheDocument();
  });
});

describe('FileTree 角标与流式状态', () => {
  it('M 角标：agent 蓝（brand）/ human 绿，title 提示最后编辑者；seed 算预置（绿）', () => {
    renderTree();

    const agentBadge = screen.getByTitle('产品经理 修改');
    expect(agentBadge).toHaveTextContent('M');
    expect(agentBadge.className).toContain('text-brand');

    const humanBadge = screen.getByTitle('人工修改');
    expect(humanBadge.className).toContain('text-emerald-600');

    expect(screen.getByTitle('预置文件')).toBeInTheDocument();
    expect(screen.getByTitle('工程师 修改')).toBeInTheDocument();
  });

  it('流式文件：脉冲图标 + 行数计数；非流式文件无生成中标记', () => {
    const files = makeFiles([
      [
        'app/backend/api.js',
        { content: 'export const a = 1;\nexport const b = 2;', version: 0, lastEditor: 'engineer', streaming: true },
      ],
    ]);
    renderTree({ files });

    expect(screen.getByText('2 行')).toBeInTheDocument();
    // 闪烁只落在「生成中」图标上，不闪烁整行文件名
    expect(screen.getByTitle('生成中').className).toContain('animate-pulse');
    expect(screen.getAllByTitle('生成中')).toHaveLength(1);
    expect(screen.getByRole('treeitem', { name: /prd\.md/ }).className).not.toContain('animate-pulse');
  });

  it('新文件出现动画：行节点带 fade-in / slide-in 过渡类', () => {
    renderTree();
    expect(screen.getByRole('treeitem', { name: /prd\.md/ }).className).toContain('fade-in');
  });
});

describe('FileTree 选择与下载', () => {
  it('点击文件回调 onSelect(path)，目录点击只切换折叠不触发回调', () => {
    const { onSelect } = renderTree();

    fireEvent.click(screen.getByText('prd.md'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('docs/prd.md');

    fireEvent.click(screen.getByRole('treeitem', { name: /docs/ }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('activePath 命中行高亮（aria-selected），其余行不选中', () => {
    renderTree({ activePath: 'docs/prd.md' });

    expect(screen.getByRole('treeitem', { name: /prd\.md/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('treeitem', { name: /index\.html/ })).toHaveAttribute('aria-selected', 'false');
    // 选中行带浅蓝底（品牌色 token）
    expect(screen.getByRole('treeitem', { name: /prd\.md/ }).className).toContain('bg-brand/10');
  });

  it('触控目标：树行与搜索框在 <lg 抬到 ≥44px（响应式标记类）', () => {
    renderTree();
    expect(screen.getByRole('treeitem', { name: /prd\.md/ }).className).toContain('max-lg:h-11');
    expect(screen.getByRole('textbox', { name: '搜索文件' }).className).toContain('max-lg:h-11');
  });

  it('下载项目：projectId 存在 → 复用 openProjectExport 打开导出地址', () => {
    const openMock = vi.fn<(url?: string | URL, target?: string) => Window | null>().mockReturnValue(null);
    vi.stubGlobal('open', openMock);
    renderTree({ projectId: 42 });

    fireEvent.click(screen.getByRole('button', { name: '下载项目' }));
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(openMock).toHaveBeenCalledWith('/api/projects/42/export', '_blank');
  });

  it('projectId 缺省（快照未就绪）→ 下载按钮禁用，点击不触发导出', () => {
    const openMock = vi.fn();
    vi.stubGlobal('open', openMock);
    renderTree();

    const button = screen.getByRole('button', { name: '下载项目' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(openMock).not.toHaveBeenCalled();
  });
});
