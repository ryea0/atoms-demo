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
 */
import { useCallback, useMemo, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/sonner';
import { useWorkspace } from '@/lib/client/store';
import type { AgentRole } from '@/lib/db/provider/types';
import { ViewerTabs } from '@/components/viewer/ViewerTabs';
import { PaneEmpty, PaneShell } from './PaneShell';
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

  const handleViewChange = useCallback((next: WorkspaceView) => setView(next), []);
  const handlePaneChange = useCallback((value: string) => {
    if (isMobilePane(value)) setPane(value);
  }, []);

  // 运行中角色集合（快照里的 running run + SSE agent_start/agent_end 推进的结果）
  const runningRoles = useMemo(() => {
    const roles = new Set<AgentRole>();
    for (const run of state.runs) {
      if (run.status === 'running') roles.add(run.agent);
    }
    return roles;
  }, [state.runs]);

  const fileCount = state.files.size;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      <TopBar
        project={state.project}
        runningRoles={runningRoles}
        connected={state.connected}
        view={view}
        onViewChange={handleViewChange}
      />

      {/* 三栏主体：桌面并排，窄屏由显隐类折叠成单栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 聊天区 ~30%：T19 在此挂 ChatPanel */}
        <PaneShell
          label="聊天区"
          title="聊天"
          active={pane === 'chat'}
          className="flex-1 border-r border-border lg:flex-none lg:w-[30%]"
        >
          <PaneEmpty
            hint="团队消息与任务时间线会在这里实时展示"
            sub="生成开始后，领导分派与成员产出都会出现在这里"
          />
        </PaneShell>

        {/* 文件树 ~20%：T20 在此挂 FileTree */}
        <PaneShell
          label="文件树"
          title="文件"
          active={pane === 'files'}
          className="flex-1 border-r border-border lg:flex-none lg:w-[20%]"
        >
          <PaneEmpty
            hint="生成开始后，文件会在这里长出目录树"
            sub="支持按名搜索、查看修改标记与下载项目"
            meta={fileCount === 0 ? '还没有生成任何文件' : `已生成 ${fileCount} 个文件`}
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
            <PaneEmpty hint="应用预览将在这里呈现" sub="生成完成后，可在浏览器内直接操作全栈应用" />
          ) : (
            <ViewerTabs />
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

      {/* toast 挂本页（分享复制提示用），不进根布局 */}
      <Toaster position="top-center" richColors />
    </div>
  );
}
