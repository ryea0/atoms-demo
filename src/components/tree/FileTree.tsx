'use client';

/**
 * 文件树（Task 20，DESIGN §2 中栏）：搜索框 · 目录树（折叠箭头/类型图标/M 角标/流式状态）
 * · 底部「下载项目」。
 *
 * 职责边界：纯展示 + 交互回调，不自拉数据——文件集合、选中路径都由 Workspace 层
 * （useWorkspace → props）传入；选中态接线（activePath/onSelect 归 T25）由父层决定，
 * 本组件只消费 props。结构变换全部走 src/lib/client/tree.ts 纯函数（嵌套/排序/过滤/默认展开）。
 *
 * 性能：树结构按「路径集合签名」memo——SSE delta 高频更新 files Map 时路径集合不变，
 * 树节点引用保持稳定，只有流式行的行数计数这一处文本会重渲染（规则 03：不逐字符重建整棵树）。
 */
import { Fragment, useCallback, useMemo, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  Download,
  File,
  FileCode,
  FileImage,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Search,
  SquareTerminal,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { roleRegistry } from '@/lib/agents/registry';
import type { FileEditor } from '@/lib/db/provider/types';
import { openProjectExport } from '@/lib/client/session';
import type { WorkspaceFile } from '@/lib/client/store';
import { buildTree, countLines, defaultExpandedDirs, type TreeNode } from '@/lib/client/tree';

export interface FileTreeProps {
  /** 虚拟 FS 文件集合（path → 内容/版本/最后编辑者/在流标记），来自 useWorkspace().files */
  files: ReadonlyMap<string, WorkspaceFile>;
  /** 项目 id（导出 zip 用）；快照未就绪传 null/缺省 → 下载按钮禁用防死链 */
  projectId?: number | null;
  /** 当前选中高亮路径（查看器打开的文件）；null = 无选中 */
  activePath?: string | null;
  /** 点击文件回调（目录点击只切换折叠，不触发） */
  onSelect?: (path: string) => void;
}

/* ------------------------------------------------------------------ */
/* 展示映射（类型图标 / M 角标）                                          */
/* ------------------------------------------------------------------ */

/** 扩展名 → 类型图标（md/代码/图/脚本/图源；未识别回落通用文件） */
const EXT_ICONS: Readonly<Record<string, LucideIcon>> = {
  md: FileText,
  markdown: FileText,
  txt: FileText,
  mmd: Workflow,
  json: FileJson,
  js: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  css: FileCode,
  html: FileCode,
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  svg: FileImage,
  webp: FileImage,
  ico: FileImage,
  sh: SquareTerminal,
  bash: SquareTerminal,
  zsh: SquareTerminal,
};

function iconFor(name: string): LucideIcon {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  return EXT_ICONS[ext] ?? File;
}

/** M 角标语义：蓝 = agent 最后修改，绿 = 人工/预置（取 files.lastEditor，DESIGN §2） */
const BADGE_AGENT = 'bg-brand/10 text-brand';
const BADGE_HUMAN = 'bg-emerald-500/10 text-emerald-600';

interface EditorBadge {
  readonly title: string;
  readonly className: string;
}

function editorBadgeOf(editor: FileEditor): EditorBadge {
  if (editor === 'human') return { title: '人工修改', className: BADGE_HUMAN };
  if (editor === 'seed') return { title: '预置文件', className: BADGE_HUMAN };
  return { title: `${roleRegistry[editor].name} 修改`, className: BADGE_AGENT };
}

/** 新文件出现动画（CSS opacity/translate 过渡，tw-animate-css 工具类） */
const APPEAR = 'animate-in fade-in slide-in-from-left-2 duration-300';

/* ------------------------------------------------------------------ */
/* 组件                                                                 */
/* ------------------------------------------------------------------ */

export function FileTree({ files, projectId, activePath = null, onSelect }: FileTreeProps) {
  const [query, setQuery] = useState('');
  /** 用户手动折叠/展开的目录覆盖表（缺省走 defaultExpandedDirs 推导） */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map<string, boolean>());

  // 路径集合签名：delta 只改内容不改路径集合，签名不变 → 树与默认展开引用稳定
  const pathKey = useMemo(() => Array.from(files.keys()).join('\n'), [files]);
  const paths = useMemo<readonly string[]>(() => (pathKey === '' ? [] : pathKey.split('\n')), [pathKey]);
  const defaults = useMemo(() => defaultExpandedDirs(paths), [paths]);

  const filter = query.trim();
  const isSearching = filter !== '';
  const nodes = useMemo(() => buildTree(paths, { filter }), [paths, filter]);

  const handleToggle = useCallback((path: string, expanded: boolean) => {
    setOverrides((prev) => new Map(prev).set(path, expanded));
  }, []);

  const handleDownload = useCallback(() => {
    // 按钮在无 projectId 时已禁用，这里兜底，绝不打开 /api/projects/undefined 死链
    if (projectId === undefined || projectId === null) return;
    openProjectExport(projectId);
  }, [projectId]);

  /** 递归渲染：目录=折叠行，文件=选中回调行；折叠子树不渲染（列表态按需出 DOM） */
  const renderNodes = (list: readonly TreeNode[], depth: number): ReactNode[] =>
    list.map((node) => {
      const isDir = node.kind === 'dir';
      // 搜索期间全部展开（用户要的是「找到」，不是保持折叠层级）
      const expanded = isSearching || (overrides.get(node.path) ?? defaults.has(node.path));
      const file = isDir ? undefined : files.get(node.path);
      const isActive = !isDir && activePath === node.path;
      const streaming = file?.streaming === true;
      const badge = file === undefined ? undefined : editorBadgeOf(file.lastEditor);
      const Icon = isDir ? (expanded ? FolderOpen : Folder) : iconFor(node.name);

      return (
        <Fragment key={node.path}>
          <button
            type="button"
            role="treeitem"
            aria-expanded={isDir ? expanded : undefined}
            aria-selected={isDir ? undefined : isActive}
            aria-level={depth + 1}
            title={node.path}
            onClick={() => (isDir ? handleToggle(node.path, !expanded) : onSelect?.(node.path))}
            style={{ paddingLeft: 6 + depth * 12 }}
            className={cn(
              'flex h-9 w-full items-center gap-1.5 rounded-lg pr-2 text-left max-lg:h-11',
              'transition-colors hover:bg-accent',
              isActive ? 'bg-brand/10' : 'text-foreground/90',
              isDir ? 'text-xs text-foreground/80' : 'font-mono text-xs',
              APPEAR,
            )}
          >
            {isDir ? (
              <ChevronRight
                aria-hidden
                className={cn('size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
              />
            ) : null}
            {streaming ? (
              <span role="img" aria-label="生成中" title="生成中" className="shrink-0 animate-pulse">
                <Icon aria-hidden className="size-4 shrink-0 text-brand" />
              </span>
            ) : (
              <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{node.name}</span>
            {streaming ? (
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                {countLines(file?.content ?? '')} 行
              </span>
            ) : null}
            {badge === undefined ? null : (
              <span
                role="img"
                aria-label={badge.title}
                title={badge.title}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[10px] font-semibold leading-none',
                  badge.className,
                )}
              >
                M
              </span>
            )}
          </button>
          {isDir && expanded ? <div role="group">{renderNodes(node.children, depth + 1)}</div> : null}
        </Fragment>
      );
    });

  const hasFiles = files.size > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {hasFiles ? (
        <>
          {/* 搜索框（过滤在 buildTree 纯函数内完成） */}
          <div className="relative shrink-0 border-b border-border px-2 py-2">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索文件"
              aria-label="搜索文件"
              className="h-9 pl-9 text-xs max-lg:h-11"
            />
          </div>

          {/* 树本体（无匹配提示放 tree 外，避免 role=tree 出现非 treeitem 子节点） */}
          <div className="min-h-0 flex-1 overflow-hidden px-1.5 py-1.5">
            {nodes.length === 0 ? (
              <p className="px-2 py-6 text-center text-xs text-muted-foreground">没有匹配「{filter}」的文件</p>
            ) : (
              <div role="tree" aria-label="项目文件" className="h-full overflow-y-auto">
                {renderNodes(nodes, 0)}
              </div>
            )}
          </div>
        </>
      ) : (
        /* 空态：与栏位占位同源文案（文件尚未生长 / 项目草稿） */
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
          <p className="text-sm text-muted-foreground">生成开始后，文件会在这里长出目录树</p>
          <p className="text-xs text-muted-foreground/80">支持按名搜索、查看修改标记与下载项目</p>
          <p className="mt-1 text-xs text-foreground/70">还没有生成任何文件</p>
        </div>
      )}

      {hasFiles ? (
        /* 底部固定下载入口（导出 zip；与顶栏「导出项目 zip」同走 openProjectExport） */
        <div className="shrink-0 border-t border-border p-2">
          <Button
            type="button"
            variant="outline"
            onClick={handleDownload}
            disabled={projectId === undefined || projectId === null}
            className="h-9 w-full gap-1.5 text-xs max-lg:h-11"
          >
            <Download className="size-4" aria-hidden />
            下载项目
          </Button>
        </div>
      ) : null}
    </div>
  );
}
