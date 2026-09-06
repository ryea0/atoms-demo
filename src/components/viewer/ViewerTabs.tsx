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
import {
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react';
import dynamic from 'next/dynamic';
import { useParams } from 'next/navigation';
import { toast } from 'sonner';
import { RefreshCw, X } from 'lucide-react';
import { roleRegistry } from '@/lib/agents/registry';
import { createWorkspaceStore, useWorkspaceFile } from '@/lib/client/store';
import { isGenerationRunning } from '@/lib/client/format';
import { fetchWorkspaceSnapshot, regenerateProjectFile, saveHumanFile, setFileSoftLock } from '@/lib/client/session';
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

/**
 * 项目是否生成中（单文件重试入口的可用性信号，口径同 ChatPanel 的 isGenerationRunning）。
 * 订阅返回布尔原始值：值不变不重渲染，其他文件的 delta 流不会牵连本组件。
 */
function useGenerationRunning(projectId: number): boolean {
  const store = createWorkspaceStore(projectId);
  const getSnapshot = useCallback((): boolean => {
    const state = store.getState();
    return isGenerationRunning({
      finished: state.finished,
      projectStatus: state.project?.status ?? null,
      runningRunCount: state.runs.filter((run) => run.status === 'running').length,
      livePathCount: state.livePaths.length,
    });
  }, [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** M 角标：蓝=agent 产出、绿=人工/预置（与文件树 M 角标同一口径） */
function EditorFlag({ editor }: { editor: FileEditor }): React.ReactElement {
  const isAgent = editor in roleRegistry;
  return (
    <span
      aria-hidden
      title={editorLabel(editor)}
      className={cn('font-mono text-[10px] font-bold', isAgent ? 'text-brand' : 'text-human')}
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
  // 与 useWorkspaceFile 同一 per-project 单例：人工保存成功后需要就地推进 store
  const store = createWorkspaceStore(projectId);
  const running = useGenerationRunning(projectId);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  /** 单文件重试请求在途（重试完成前禁用入口，防重复触发） */
  const [regenerating, setRegenerating] = useState(false);
  /** 409 冲突上下文：服务端当前内容（并排 diff）+ 当前版本号（「用我的」就地重发用，T25） */
  const [conflictWith, setConflictWith] = useState<{ current: string; version: number } | null>(null);
  /** 拒存提示（流式生成中保存被拒；内联展示，不吞草稿） */
  const [blockedNotice, setBlockedNotice] = useState<string | null>(null);

  // 事件回调里要用最新版本号（SSE 随时可能推进），经 ref 取当前值
  const fileRef = useRef(file);
  useEffect(() => {
    fileRef.current = file;
  }, [file]);

  const fileId = file.id;
  const editable = fileId !== null && !file.streaming;

  /**
   * 单文件重试（CLAUDE.md 规则 3 / DESIGN §3.10③）：仅空闲可用。
   * 服务端补发完整事件链，store 由 SSE 推进（打字机可见），无需客户端重拉快照。
   * SSE 事件不带 files.id：本轮会话内生成的文件在快照 hydrate 前 id 为 null——
   * 点击时惰性拉一次快照按 path 补齐（顺带回填编辑入口），不落库的 path 才报错。
   */
  const handleRegenerate = useCallback((): void => {
    if (regenerating) return;
    const resolveId = async (): Promise<number> => {
      const known = fileRef.current.id;
      if (known !== null) return known;
      store.hydrate(await fetchWorkspaceSnapshot(projectId));
      const resolved = store.getState().files.get(path)?.id;
      if (resolved === null || resolved === undefined) {
        throw new Error(`文件尚未落库，无法重试：${path}`);
      }
      return resolved;
    };
    setRegenerating(true);
    void resolveId()
      .then((currentId) => regenerateProjectFile(projectId, currentId))
      .then((result) => {
        // ok=false = 内容已落库但校验未过（服务端语义：文件保留），降级 warning 提示
        const description = `v${result.version}${result.ok ? '（校验通过）' : '（校验未过，文件已保留）'}`;
        if (result.ok) toast.success(`已重新生成 ${result.path}`, { description });
        else toast.warning(`已重新生成 ${result.path}`, { description });
      })
      .catch((error: unknown) => {
        console.error('[viewer] 单文件重试失败：', error);
        toast.error('重新生成失败', { description: error instanceof Error ? error.message : '请稍后重试' });
      })
      .finally(() => setRegenerating(false));
  }, [projectId, path, regenerating, store]);

  /** 重试入口禁用原因（title 与读屏可见） */
  const regenerateDisabledReason = file.streaming
    ? '该文件正在生成中'
    : running
      ? '生成进行中，暂不能重试单文件：请先停止或等待本轮完成'
      : '';

  const leaveEditing = useCallback((): void => {
    setEditing(false);
    setDraft('');
    setConflictWith(null);
    setBlockedNotice(null);
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
    async (content: string, baseVersionOverride?: number): Promise<void> => {
      const current = fileRef.current;
      const currentId = current.id;
      if (currentId === null) return;
      // 流式拒存（T25）：agent 正在重写同一文件时保存必然互相覆盖，CAS 也一定会拒——
      // 直接拒存并提示，草稿与编辑态保留，生成结束后用户可原样重发
      if (current.streaming) {
        setBlockedNotice('该文件正在生成中，请稍候');
        toast.error('该文件正在生成中，请稍候');
        return;
      }
      setSaving(true);
      try {
        const baseVersion = baseVersionOverride ?? current.version;
        const result = await saveHumanFile(projectId, currentId, content, baseVersion);
        if (result.ok) {
          // 人工写不发 SSE：store 必须就地推进，否则回显旧内容、二次编辑用过期版本必 409
          store.applyHumanSave(path, { content, version: result.version });
          leaveEditing();
          return;
        }
        // CAS 失败：agent 已写入新版本 → 冲突对话框（内容供并排对比，版本号供「用我的」重发）
        setConflictWith({ current: result.current, version: result.version });
      } catch (error) {
        console.error('[viewer] 人工保存失败：', error);
        toast.error(error instanceof Error ? error.message : '保存失败，请稍后重试');
      } finally {
        setSaving(false);
      }
    },
    [projectId, leaveEditing, store, path],
  );

  /**
   * 「用我的版本」：取「409 回带的服务端版本号」与「store 当前版本号」的较大者重发——
   * SSE 断连期间只有 409 体能推进（T25），SSE 正常时 store 可能已被更新的 file_end 推进。
   */
  const handleKeepMine = (): void => {
    const known = Math.max(conflictWith?.version ?? 0, fileRef.current.version);
    setConflictWith(null);
    void persist(draft, known > 0 ? known : undefined);
  };

  const body = useMemo(() => {
    // 三类视图统一走打字机滚动——brief「流式文件自动滚动」不限于代码文件，
    // PM 流式写 PRD / 架构师流式画图同样要跟随到底部。
    // 取舍：markdown/mermaid 的重解析/重渲染开销由各自 120ms 合批压制（见视图内注释），
    // 跟随滚动本身只是 ref 写 scrollTop，不引入额外渲染。
    const view =
      kind === 'markdown' ? (
        <LazyMarkdownView content={file.content} streaming={file.streaming} />
      ) : kind === 'mermaid' ? (
        <LazyMermaidView content={file.content} streaming={file.streaming} />
      ) : (
        <LazyCodeView content={file.content} path={path} streaming={file.streaming} />
      );
    return (
      <TypewriterScroller streaming={file.streaming} scrollKey={file.content.length}>
        {view}
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
          {blockedNotice !== null && (
            <span role="alert" className="shrink-0 text-[11px] text-amber-700">
              {blockedNotice}
            </span>
          )}
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
            <>
              {/* 单文件重试（空闲 + 已落库才可用；服务端 409 兜底，SSE 事件驱动更新） */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`重新生成 ${path}`}
                title={regenerateDisabledReason !== '' ? regenerateDisabledReason : '重跑该单文件任务（工程师重写这一份）'}
                disabled={file.streaming || running || regenerating}
                onClick={handleRegenerate}
                className="max-lg:h-11 gap-1.5"
              >
                <RefreshCw className={cn('size-3.5', regenerating && 'animate-spin')} aria-hidden />
                {regenerating ? '重新生成中…' : '重新生成'}
              </Button>
              <EditToggle
                disabled={!editable}
                disabledReason={file.streaming ? '文件正在生成，暂不可编辑' : '文件尚未落库，稍后再试'}
                onEnterEditing={() => {
                  setDraft(file.content);
                  setEditing(true);
                }}
              />
            </>
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
        theirs={conflictWith?.current ?? ''}
        onKeepMine={handleKeepMine}
        onUseTheirs={leaveEditing}
      />
    </div>
  );
}
