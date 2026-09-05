'use client';

/**
 * 工作台顶栏（Task 18，DESIGN §2「顶部条 50px」）：
 * 返回 logo · 项目标题+状态下拉 · 视图切换 tabs[编辑器|预览] · 成员头像排（运行中高亮+脉冲）
 * · 分享（复制链接 toast） · 设置入口 · SSE 连接指示灯 · 预留操作槽（T19 挂 EditSwitch）。
 *
 * 只做展示与切换回调：项目 / 运行中角色 / 连接态都由 Workspace 从 useWorkspace 取好传入，
 * 不自己拉数据。预览面板（T22）接管「预览」档位；actions 槽由 Workspace 注入（T19 EditSwitch）。
 */
import { useCallback } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown, Download, Link2, Settings } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { roleOrder, roleRegistry } from '@/lib/agents/registry';
import { formatRelativeTime, modeLabel, statusBadgeVariant, statusLabel } from '@/lib/client/format';
import { openProjectExport } from '@/lib/client/session';
import type { AgentRole, Project } from '@/lib/db/provider/types';

/** 查看器主区视图（编辑器 / 预览；预览档由 T22 PreviewPane 填充） */
export type WorkspaceView = 'editor' | 'preview';

export interface TopBarProps {
  /** 项目（快照未就绪时为 null：顶栏先渲染骨架） */
  project: Project | null;
  /** 运行中角色集合（头像排高亮 + 脉冲） */
  runningRoles: ReadonlySet<AgentRole>;
  /** SSE 连接状态（指示灯） */
  connected: boolean;
  /** 受控视图（状态在 Workspace，供查看器主区联动切换） */
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  /** 预留操作槽内容（T19 挂 EditSwitch；缺省渲染空容器） */
  actions?: ReactNode;
}

interface InfoRow {
  label: string;
  value: string;
}

/** 剪贴板复制：环境无 clipboard API（旧浏览器/测试环境）或被拒绝时按失败处理，用户可见提示 */
async function copyText(text: string): Promise<boolean> {
  try {
    if ('clipboard' in navigator) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (error) {
    console.error('[topbar] 分享链接复制失败：', error);
  }
  return false;
}

/** 七角色头像排：运行中角色描边高亮 + 脉冲，其余降透明度（数据源 = roleRegistry） */
function AgentAvatars({ running }: { running: ReadonlySet<AgentRole> }) {
  return (
    <ul aria-label="团队成员" className="hidden items-center -space-x-1.5 md:flex">
      {roleOrder.map((role) => {
        const meta = roleRegistry[role];
        const isRunning = running.has(role);
        return (
          <li
            key={role}
            aria-label={`${meta.name}·${isRunning ? '运行中' : '待命'}`}
            title={`${meta.name}${isRunning ? '（运行中）' : '（待命）'}`}
            className={cn(
              'flex size-7 items-center justify-center rounded-full border-2 bg-background text-xs',
              isRunning ? 'animate-pulse' : 'opacity-40',
            )}
            /* 角色主题色是注册表运行时值（与首页头像排同源），属动态值豁免 */
            style={{ borderColor: meta.color }}
          >
            <span aria-hidden>{meta.emoji}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function TopBar({ project, runningRoles, connected, view, onViewChange, actions }: TopBarProps) {
  const share = useCallback(() => {
    // 项目未就绪时按钮已禁用，这里兜底，绝不复制出 /p/ 死链
    if (project === null) return;
    // 分享固定指向工作台根路径（不携带查看器内状态），对方打开即见完整三栏
    void copyText(`${window.location.origin}/p/${project.id}`).then((copied) => {
      if (copied) {
        toast.success('链接已复制', { description: '发给协作者即可打开同一项目' });
      } else {
        toast.error('复制失败', { description: '请手动复制浏览器地址栏链接' });
      }
    });
  }, [project]);

  const handleViewChange = useCallback(
    (value: string) => {
      onViewChange(value === 'preview' ? 'preview' : 'editor');
    },
    [onViewChange],
  );

  const infoRows: InfoRow[] =
    project === null
      ? []
      : [
          { label: '需求', value: project.requirement },
          { label: '模式', value: modeLabel(project.mode) },
          { label: '状态', value: statusLabel(project.status) },
          { label: '更新', value: formatRelativeTime(project.updatedAt) },
        ];

  return (
    <header className="flex h-[50px] shrink-0 items-center gap-2 border-b border-border bg-background px-3 sm:px-4">
      {/* 返回 logo */}
      <Link
        href="/"
        aria-label="返回首页"
        className="flex shrink-0 items-center gap-2 rounded-lg p-1 transition-colors hover:bg-accent"
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background">
          A
        </span>
        <span className="hidden text-sm font-semibold tracking-tight sm:inline">Atoms</span>
      </Link>

      {/* 项目标题 + 状态下拉（快照未就绪时只给占位标题） */}
      {project === null ? (
        <span className="min-w-0 truncate text-sm text-muted-foreground">加载中…</span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="项目信息"
              className="min-w-0 max-w-[13rem] gap-1.5 max-lg:h-11 sm:max-w-[18rem]"
            >
              <span className="truncate">{project.title}</span>
              <Badge variant={statusBadgeVariant(project.status)} className="shrink-0">
                {statusLabel(project.status)}
              </Badge>
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuLabel>项目详情</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="flex flex-col gap-1.5 px-2 pb-2 text-xs">
              {infoRows.map((row) => (
                <div key={row.label} className="flex gap-2">
                  <span className="w-7 shrink-0 text-muted-foreground">{row.label}</span>
                  <span className="min-w-0 flex-1 break-words text-foreground">{row.value}</span>
                </div>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => openProjectExport(project.id)}>
              <Download className="size-4" aria-hidden />
              导出项目 zip
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
        {/* 视图切换：编辑器（T21）/ 预览（T22）。
            <lg 触控目标 ≥44px（规则 04）：列表 48px 且去掉 3px 内边距，触发器显式 44px——
            只抬列表高度不够（触发器是 h-[calc(100%-1px)]，48-6-1=41px） */}
        <Tabs value={view} onValueChange={handleViewChange}>
          <TabsList aria-label="视图切换" className="shrink-0 max-lg:h-12 max-lg:p-0">
            <TabsTrigger value="editor" className="max-lg:h-11">
              编辑器
            </TabsTrigger>
            <TabsTrigger value="preview" className="max-lg:h-11">
              预览
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <AgentAvatars running={runningRoles} />

        {/* SSE 连接指示灯 */}
        <span
          aria-hidden
          className={cn('size-2 shrink-0 rounded-full', connected ? 'bg-brand' : 'bg-muted-foreground/40')}
        />
        <span className="sr-only">{connected ? '实时连接已建立' : '连接已断开，正在重试'}</span>

        <Button
          variant="ghost"
          size="icon"
          aria-label="复制分享链接"
          title="复制分享链接"
          onClick={share}
          /* 项目未就绪（快照加载中/失败）时没有可分享的项目地址，禁用防死链 */
          disabled={project === null}
          /* 桌面 50px 顶栏内保持 36px 视觉；<lg 扩到 44px 触控目标（规则 04） */
          className="size-9 shrink-0 max-lg:size-11"
        >
          <Link2 className="size-4" aria-hidden />
        </Button>

        <Link
          href="/settings"
          aria-label="打开设置"
          title="设置"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground max-lg:size-11"
        >
          <Settings className="size-4" aria-hidden />
        </Link>

        {/* 预留操作槽（Workspace 注入 EditSwitch，DESIGN §3.9 编辑能力开关） */}
        <div data-topbar-actions="">{actions}</div>
      </div>
    </header>
  );
}
