'use client';

/**
 * 查看器（Task 21）：多文件页签 + 按扩展名分发渲染 + 编辑态。
 *
 * - 页签自治（状态就近）：文件树点击开新页签 / 激活已有页签由 T25 接线——
 *   声明式走 `initialPath`（变化即打开），命令式走 ref（`ViewerTabsHandle.openFile`）。
 *   项目 id 从 /p/[id] 路由自取（useParams），布局层无需透传。
 * - 分发渲染：.md → MarkdownView；.mmd/.mermaid → MermaidView；其余 → CodeView。
 *   三个视图都是重依赖（react-markdown / mermaid / shiki），经 next/dynamic + ssr:false
 *   懒加载（.claude/rules/02）：SSR 不求值、不进首屏 bundle，页签未打开对应类型就不拉取。
 * - 编辑态（DESIGN §3.9）：进入即声明软锁（PUT lock on），保存走与 agent 同一写 API
 *   （PATCH files/[fid] + CAS baseVersion）；409 → ConflictDialog 三选；离开/保存释放软锁。
 *
 * 与顶栏「视图切换 tabs[编辑器|预览]」是两层：这里管理的是文件页签，不感知全局视图。
 */
import { Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { roleRegistry } from '@/lib/agents/registry';
import { useWorkspaceFile } from '@/lib/client/store';
import { saveHumanFile, setFileSoftLock } from '@/lib/client/session';
import { Button } from '@/components/ui/button';
import { ConflictDialog } from '@/components/viewer/ConflictDialog';
import { EditToggle } from '@/components/viewer/EditToggle';
import { TypewriterScroller } from '@/components/viewer/TypewriterScroller';
import { cn } from '@/lib/utils';
import type { FileEditor } from '@/lib/db/provider/types';

/* 重依赖视图懒加载（仅浏览器渲染；加载期给占位，避免布局塌陷） */
const LazyMarkdownView = dynamic(
  () => import('@/components/viewer/MarkdownView').then((m) => ({ default: m.MarkdownView })),
  { ssr: false, loading: () => <ViewerLoading /> },
);
const LazyCodeView = dynamic(
  () => import('@/components/viewer/CodeView').then((m) => ({ default: m.CodeView })),
  { ssr: false, loading: () => <ViewerLoading /> },
);
const LazyMermaidView = dynamic(
  () => import('@/components/viewer/MermaidView').then((m) => ({ default: m.MermaidView })),
  { ssr: false, loading: () => <ViewerLoading /> },
);

function ViewerLoading(): React.ReactElement {
  return <p className="text-muted-foreground px-4 py-3 text-xs">视图加载中…</p>;
}

/** 页签渲染类型（按扩展名分流） */
export type ViewerKind = 'markdown' | 'mermaid' | 'code';

/** 扩展名 → 渲染视图（纯函数，导出供测试与其他组件复用同一口径） */
export function viewerKindForPath(path: string): ViewerKind {
  const normalized = path.toLowerCase();
  if (normalized.endsWith('.md') || normalized.endsWith('.markdown')) return 'markdown';
  if (normalized.endsWith('.mmd') || normalized.endsWith('.mermaid')) return 'mermaid';
  return 'code';
}

/** 命令式句柄：T25 文件树点击（onOpenFile）直接调 openFile(path) */
export interface ViewerTabsHandle {
  /** 打开（或激活）一个文件页签 */
  openFile: (path: string) => void;
  /** 关闭一个文件页签 */
  closeFile: (path: string) => void;
}

export interface ViewerTabsProps {
  /** 初始打开（或激活）的文件路径；null/缺省 = 空态。后续变化同样会打开该文件 */
  initialPath?: string | null;
  /** 激活页签变化（含清空为 null）上报 */
  onActivePathChange?: (path: string | null) => void;
  /** 命令式接线（文件树点击开页签） */
  ref?: Ref<ViewerTabsHandle>;
}

/** 页签集合状态（路径与激活态一起迁移，避免双状态出现中间态） */
interface TabsState {
  paths: readonly string[];
  active: string | null;
}

const EMPTY_TABS: TabsState = { paths: [], active: null };

export function ViewerTabs({ initialPath, onActivePathChange, ref }: ViewerTabsProps): React.ReactElement {
  const projectId = useProjectIdFromRoute();
  const [tabs, setTabs] = useState<TabsState>(EMPTY_TABS);

  const openFile = useCallback((path: string): void => {
    setTabs((prev) => {
      const isOpen = prev.paths.includes(path);
      if (isOpen && prev.active === path) return prev;
      return { paths: isOpen ? prev.paths : [...prev.paths, path], active: path };
    });
  }, []);

  const closeFile = useCallback((path: string): void => {
    setTabs((prev) => {
      const index = prev.paths.indexOf(path);
      if (index < 0) return prev;
      const paths = prev.paths.filter((item) => item !== path);
      if (prev.active !== path) return { ...prev, paths };
      // 关闭激活页签：优先交给左侧邻居，否则右侧第一个
      return { paths, active: paths[index - 1] ?? paths[index] ?? null };
    });
  }, []);

  useImperativeHandle(ref, () => ({ openFile, closeFile }), [openFile, closeFile]);

  // initialPath 变化（含 T25 声明式接线）→ 打开并激活
  useEffect(() => {
    if (typeof initialPath === 'string' && initialPath !== '') openFile(initialPath);
  }, [initialPath, openFile]);

  // 激活页签上报（文件树选中态 / T25 联动）
  useEffect(() => {
    onActivePathChange?.(tabs.active);
  }, [tabs.active, onActivePathChange]);

  const activePath = tabs.active;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tabs.paths.length === 0 ? (
        <ViewerEmpty />
      ) : (
        <>
          <div
            role="tablist"
            aria-label="文件页签"
            className="border-border bg-panel flex shrink-0 items-stretch overflow-x-auto border-b"
          >
            {tabs.paths.map((path) => (
              <ViewerTabItem
                key={path}
                projectId={projectId}
                path={path}
                active={path === activePath}
                onActivate={() => openFile(path)}
                onClose={() => closeFile(path)}
              />
            ))}
          </div>
          {activePath === null ? null : <FilePane key={activePath} projectId={projectId} path={activePath} />}
        </>
      )}
    </div>
  );
}

/** /p/[id] 的项目 id（非法段按 0 处理：查看器只显示空态，不发请求） */
function useProjectIdFromRoute(): number {
  const params = useParams<{ id?: string }>();
  const raw = params?.id;
  const parsed = typeof raw === 'string' && /^\d{1,9}$/.test(raw) ? Number(raw) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}

function ViewerEmpty(): React.ReactElement {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <p className="text-muted-foreground text-sm">在文件树中选择文件，在这里查看与编辑</p>
      <p className="text-muted-foreground/80 text-xs">支持 Markdown 渲染、代码高亮与流程图</p>
    </div>
  );
}

interface ViewerTabItemProps {
  projectId: number;
  path: string;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}

/** 单个页签：M 角标（编辑者着色）+ 文件名 + × 关闭。细粒度订阅自身 path，其他文件流式不牵连 */
function ViewerTabItem({ projectId, path, active, onActivate, onClose }: ViewerTabItemProps): React.ReactElement {
  const file = useWorkspaceFile(projectId, path);
  const name = baseNameOf(path);

  return (
    <div
      className={cn(
        'group/tab flex shrink-0 items-center gap-0.5 border-b-2 pl-2.5',
        active ? 'border-brand bg-background' : 'border-transparent',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        title={path}
        onClick={onActivate}
        className={cn(
          'flex h-9 max-lg:h-11 items-center gap-1.5 rounded-t-md px-1.5 text-xs transition-colors',
          active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <EditorFlag editor={file.lastEditor} />
        <span className="font-mono">{name}</span>
        {file.streaming ? (
          <>
            <span aria-hidden className="bg-brand size-1.5 animate-pulse rounded-full" />
            <span className="sr-only">生成中</span>
          </>
        ) : null}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`关闭 ${name}`}
        title={`关闭 ${path}`}
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground max-lg:size-9"
      >
        <X className="size-3" aria-hidden />
      </Button>
    </div>
  );
}

function baseNameOf(path: string): string {
  const segments = path.split('/');
  return segments[segments.length - 1] ?? path;
}

/** M 角标：蓝=agent 产出、绿=人工/预置（与文件树 M 角标同一口径） */
function EditorFlag({ editor }: { editor: FileEditor }): React.ReactElement {
  const isAgent = editor in roleRegistry;
  return (
    <span
      aria-hidden
      title={editorLabel(editor)}
      className={cn('font-mono text-[10px] font-bold', isAgent ? 'text-brand' : 'text-emerald-600')}
    >
      M
    </span>
  );
}

function editorLabel(editor: FileEditor): string {
  if (editor === 'human') return '人工';
  if (editor === 'seed') return '预置';
  return roleRegistry[editor]?.name ?? editor;
}

/* ------------------------------------------------------------------ */
/* 单文件面板（查看 / 编辑）                                             */
/* ------------------------------------------------------------------ */

interface FilePaneProps {
  projectId: number;
  path: string;
}

/** 软锁释放失败不阻断主流程：锁有 TTL，且 agent 侧只在文件边界查询 */
function releaseLock(projectId: number, fileId: number): void {
  void setFileSoftLock(projectId, fileId, false).catch((error: unknown) => {
    console.error('[viewer] 软锁释放失败：', error);
  });
}

/**
 * 单文件查看/编辑面板。以 path 为 key 挂载：切换页签即重置编辑态，
 * 杜绝「上一份草稿串到下一个文件」这类跨文件状态泄漏。
 */
function FilePane({ projectId, path }: FilePaneProps): React.ReactElement {
  const file = useWorkspaceFile(projectId, path);
  const kind = viewerKindForPath(path);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflictWith, setConflictWith] = useState<string | null>(null);

  // 事件回调里要用最新版本号（SSE 随时可能推进），经 ref 取当前值
  const fileRef = useRef(file);
  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  const fileId = file.id;
  const editable = fileId !== null && !file.streaming;

  const leaveEditing = useCallback((): void => {
    setEditing(false);
    setDraft('');
    setConflictWith(null);
  }, []);

  // 软锁生命周期 = 编辑态生命周期（进入声明，取消/保存/卸载释放；锁自身还有 TTL 兜底）
  useEffect(() => {
    if (!editing || fileId === null) return;
    void setFileSoftLock(projectId, fileId, true).catch((error: unknown) => {
      console.error('[viewer] 软锁声明失败：', error);
    });
    return () => releaseLock(projectId, fileId);
  }, [editing, fileId, projectId]);

  const persist = useCallback(
    async (content: string): Promise<void> => {
      const current = fileRef.current;
      const currentId = current.id;
      if (currentId === null) return;
      setSaving(true);
      try {
        const result = await saveHumanFile(projectId, currentId, content, current.version);
        if (result.ok) {
          leaveEditing();
          return;
        }
        // CAS 失败：agent 已写入新版本 → 冲突对话框（带上服务端当前内容供并排对比）
        setConflictWith(result.current);
      } catch (error) {
        console.error('[viewer] 人工保存失败：', error);
        toast.error(error instanceof Error ? error.message : '保存失败，请稍后重试');
      } finally {
        setSaving(false);
      }
    },
    [projectId, leaveEditing],
  );

  const handleKeepMine = (): void => {
    setConflictWith(null);
    void persist(draft);
  };

  const body = useMemo(() => {
    if (kind === 'markdown') {
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="px-4 py-3">
            <LazyMarkdownView content={file.content} streaming={file.streaming} />
          </div>
        </div>
      );
    }
    if (kind === 'mermaid') {
      return (
        <div className="min-h-0 flex-1 overflow-auto">
          <LazyMermaidView content={file.content} streaming={file.streaming} />
        </div>
      );
    }
    return (
      <TypewriterScroller streaming={file.streaming} scrollKey={file.content.length}>
        <LazyCodeView content={file.content} path={path} streaming={file.streaming} />
      </TypewriterScroller>
    );
  }, [kind, file.content, file.streaming, path]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border bg-background flex h-10 shrink-0 items-center gap-2 border-b px-3">
        <span className="font-mono min-w-0 truncate text-xs text-foreground">{path}</span>
        <span className="text-muted-foreground shrink-0 text-[11px]">{editorLabel(file.lastEditor)} 修改</span>
        {file.streaming ? (
          <span className="bg-brand/10 text-brand shrink-0 rounded px-1.5 py-0.5 text-[11px]">生成中</span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {editing ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label="取消编辑"
                onClick={leaveEditing}
                disabled={saving}
                className="max-lg:h-11"
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                aria-label="保存修改"
                onClick={() => void persist(draft)}
                disabled={saving}
                className="max-lg:h-11"
              >
                {saving ? '保存中…' : '保存'}
              </Button>
            </>
          ) : (
            <EditToggle
              disabled={!editable}
              disabledReason={file.streaming ? '文件正在生成，暂不可编辑' : '文件尚未落库，稍后再试'}
              onEnterEditing={() => {
                setDraft(file.content);
                setEditing(true);
              }}
            />
          )}
        </div>
      </header>

      {editing ? (
        <textarea
          aria-label={`编辑 ${path}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          className="font-mono min-h-0 flex-1 resize-none bg-background p-4 text-xs leading-relaxed outline-none"
        />
      ) : (
        // 懒加载视图显式给边界：模块未就绪时占位，而不是让整个查看器树挂起
        <Suspense fallback={<ViewerLoading />}>{body}</Suspense>
      )}

      <ConflictDialog
        open={conflictWith !== null}
        onOpenChange={(open) => {
          if (!open) setConflictWith(null);
        }}
        mine={draft}
        theirs={conflictWith ?? ''}
        onKeepMine={handleKeepMine}
        onUseTheirs={leaveEditing}
      />
    </div>
  );
}
