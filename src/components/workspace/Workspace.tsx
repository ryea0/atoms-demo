'use client';

/**
 * 工作台（Task 18，DESIGN §2「三栏 + 顶部全局条」）：布局容器 + 栏目/视图切换状态。
 *
 * 职责边界：本组件只负责「布局骨架 + 切换状态」，不做业务渲染——聊天面板（T19）、
 * 文件树（T20）、查看器（T21）、预览面板（T22）各自落在对应槽位。数据统一走
 * useWorkspace（快照 hydrate + SSE 事件入 store），布局层不自拉数据、不碰 REST。
 *
 * 响应式（.claude/rules/04）：≥lg 三栏并排（聊天 30% / 文件树 20% / 查看器 50%），
 * <lg 折叠为单栏 + 底部 tab 切换——显隐用纯 CSS 完成，三栏只挂载一次（不重复订阅 store）。
 *
 * 跨面板接线（T25）：「当前打开的文件」归本层持有（选中状态就近提升到唯一消费者之上）——
 * 文件树 onSelect 与产物卡 onOpenFile 写入，查看器 onActivePathChange 回写（页签内切换也要
 * 反向点亮文件树），经 initialPath 下发声明式打开。回滚同理收口在本层：确认 → POST restore
 * → 重拉快照对齐 store（回滚不发 file 事件）。
 */
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChatPanel } from '@/components/chat/ChatPanel';
import { EditSwitch } from '@/components/common/EditSwitch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/sonner';
import { FRONTEND_INDEX_PATH, PreviewPane } from '@/components/preview/PreviewPane';
import { createWorkspaceStore, useWorkspace } from '@/lib/client/store';
import { checkpointIdForRun, checkpointLabelOf } from '@/lib/client/checkpoint';
import { fetchWorkspaceSnapshot, restoreProjectCheckpoint } from '@/lib/client/session';
import type { AgentRole } from '@/lib/db/provider/types';
import { FileTree } from '@/components/tree/FileTree';
import { ViewerTabs } from '@/components/viewer/ViewerTabs';
import { PaneShell } from './PaneShell';
import { RollbackDialog } from './RollbackDialog';
import { TopBar, type WorkspaceView } from './TopBar';

/** 窄屏（<lg）单栏模式下的栏目 */
type MobilePane = 'chat' | 'files' | 'viewer';

/** 底部切换条目（与栏目槽位一一对应） */
const MOBILE_PANES: readonly { value: MobilePane; label: string }[] = [
  { value: 'chat', label: '聊天' },
  { value: 'files', label: '文件' },
  { value: 'viewer', label: '查看' },
];

function isMobilePane(value: string): value is MobilePane {
  return value === 'chat' || value === 'files' || value === 'viewer';
}

export function Workspace({ projectId }: { projectId: number }) {
  const state = useWorkspace(projectId);
  const [view, setView] = useState<WorkspaceView>('editor');
  const [pane, setPane] = useState<MobilePane>('chat');
  /** 当前打开的文件（文件树高亮 + 查看器激活页签的唯一事实来源） */
  const [activePath, setActivePath] = useState<string | null>(null);
  /** 待确认的回滚目标（cpId + 展示 label）；null = 关闭 */
  const [rollbackTarget, setRollbackTarget] = useState<{ checkpointId: number; label: string } | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const handleViewChange = useCallback((next: WorkspaceView) => setView(next), []);
  const handlePaneChange = useCallback((value: string) => {
    if (isMobilePane(value)) setPane(value);
  }, []);

  // 文件树点击 / 产物卡点击 → 打开并激活查看器页签；<lg 单栏下同时切到查看栏
  // （否则页签在隐藏栏里打开，移动端毫无反馈——T25 R1 评审 Finding 2）
  const handleOpenFile = useCallback((path: string) => {
    setActivePath(path);
    setPane('viewer');
  }, []);
  // 查看器页签切换/关闭 → 回写选中态（文件树高亮跟随，双向不回环：同值 setState 不触发渲染）
  const handleActivePathChange = useCallback((path: string | null) => setActivePath(path), []);

  /** 时间线「回到此任务前」：先解析该任务之前的检查点，命中才进确认闸 */
  const handleRollback = useCallback(
    (runId: number) => {
      const checkpointId = checkpointIdForRun(state.checkpoints, runId);
      if (checkpointId === null) {
        toast.error('该任务之前没有可用检查点，无法回滚');
        return;
      }
      const checkpoint = state.checkpoints.find((item) => item.id === checkpointId);
      setRollbackTarget({ checkpointId, label: checkpoint === undefined ? String(checkpointId) : checkpointLabelOf(checkpoint) });
    },
    [state.checkpoints],
  );

  /** 确认回滚：POST restore → 重拉快照整体重建 store（回滚不发 file 事件，快照是唯一对齐途径） */
  const confirmRollback = useCallback(() => {
    if (rollbackTarget === null || projectId === null) return;
    setRollingBack(true);
    const { checkpointId } = rollbackTarget;
    void restoreProjectCheckpoint(projectId, checkpointId)
      .then(() => fetchWorkspaceSnapshot(projectId))
      .then((snapshot) => {
        createWorkspaceStore(projectId).hydrate(snapshot);
        setRollbackTarget(null);
        toast.success('已回滚到检查点，文件已恢复');
      })
      .catch((error: unknown) => {
        console.error('[workspace] 检查点回滚失败：', error);
        toast.error('回滚失败', { description: error instanceof Error ? error.message : '请稍后重试' });
      })
      .finally(() => setRollingBack(false));
  }, [rollbackTarget, projectId]);

  // 运行中角色集合（快照里的 running run + SSE agent_start/agent_end 推进的结果）
  const runningRoles = useMemo(() => {
    const roles = new Set<AgentRole>();
    for (const run of state.runs) {
      if (run.status === 'running') roles.add(run.agent);
    }
    return roles;
  }, [state.runs]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <TopBar
        project={state.project}
        runningRoles={runningRoles}
        connected={state.connected}
        view={view}
        onViewChange={handleViewChange}
        /* 人工编辑能力开关（DESIGN §3.9，T23 交付）挂顶栏预留槽位；<sm 收起防顶栏溢出（设置页仍可切） */
        actions={<EditSwitch className="hidden items-center gap-2 select-none text-sm text-muted-foreground sm:flex" />}
      />

      {/* 三栏主体：桌面并排，窄屏由显隐类折叠成单栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 聊天区 ~30%：消息流 / 工具卡 / 任务时间线 / 干预（T19） */}
        <PaneShell
          label="聊天区"
          title="聊天"
          active={pane === 'chat'}
          className="flex-1 border-r border-border lg:flex-none lg:w-[30%]"
        >
          <ChatPanel state={state} onOpenFile={handleOpenFile} onRollback={handleRollback} />
        </PaneShell>

        {/* 文件树 ~20%：FileTree（T20）；选中态由本层 activePath 下发（T25 跨面板接线） */}
        <PaneShell
          label="文件树"
          title="文件"
          active={pane === 'files'}
          className="flex-1 border-r border-border lg:flex-none lg:w-[20%]"
        >
          <FileTree
            files={state.files}
            projectId={state.project?.id ?? null}
            activePath={activePath}
            onSelect={handleOpenFile}
          />
        </PaneShell>

        {/* 查看器/预览 ~50%：T21 ViewerTabs、T22 PreviewPane 在此填充 */}
        <PaneShell
          label="查看器"
          title="查看器"
          active={pane === 'viewer'}
          className="min-w-0 flex-1 lg:w-1/2"
        >
          {view === 'preview' ? (
            <PreviewPane projectId={projectId} hasFrontend={state.files.has(FRONTEND_INDEX_PATH)} />
          ) : (
            <ViewerTabs initialPath={activePath} onActivePathChange={handleActivePathChange} />
          )}
        </PaneShell>
      </div>

      {/* 窄屏底部栏目切换（桌面端三栏并排时隐藏）；触控目标 ≥ 44px */}
      <nav aria-label="工作区栏目" className="shrink-0 border-t border-border bg-background lg:hidden">
        <Tabs value={pane} onValueChange={handlePaneChange}>
          <TabsList aria-label="工作区栏目" className="h-14 w-full justify-around gap-0 rounded-none bg-background p-0">
            {MOBILE_PANES.map((item) => (
              <TabsTrigger
                key={item.value}
                value={item.value}
                // shadow 覆盖必须与原语的 compound 规则同特异性
                // （group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm 为 (0,3,0)，
                //   裸 data-[state=active]:shadow-none 只有 (0,2,0)，压不住会漏出淡阴影）
                className="h-full flex-1 rounded-none border-b-2 border-transparent px-2 text-xs text-muted-foreground data-[state=active]:border-brand data-[state=active]:bg-transparent data-[state=active]:text-foreground group-data-[variant=default]/tabs-list:data-[state=active]:shadow-none"
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </nav>

      {/* 回滚确认闸（时间线入口）：确认语义在此，POST 与快照刷新在 confirmRollback */}
      <RollbackDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRollbackTarget(null);
        }}
        checkpointLabel={rollbackTarget?.label ?? ''}
        onConfirm={confirmRollback}
        pending={rollingBack}
      />

      {/* toast 挂本页（分享复制/回滚提示用），不进根布局 */}
      <Toaster position="top-center" richColors />
    </div>
  );
}
