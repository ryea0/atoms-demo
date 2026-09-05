'use client';

/**
 * 应用侧栏（Task 17）：品牌、主导航（active 态）、最近 8 个项目（hover 删除）、底部设置入口。
 * 数据源 GET /api/projects（服务端已按 updatedAt 倒序）；删除即调 DELETE 并从本地列表移除。
 * 窄屏折叠留给后续任务，当前按桌面固定 240px 处理。
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderOpen, Home, Settings, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { deleteProject, listProjects } from '@/lib/client/session';
import type { ProjectListItem } from '@/lib/db/provider/types';

/** 侧栏最近项目条数（DESIGN §3.9 侧栏约定） */
const RECENT_LIMIT = 8;

export function AppSidebar() {
  const pathname = usePathname();
  const [recent, setRecent] = useState<ProjectListItem[]>([]);

  // 外部系统同步（REST 列表）：挂载时拉一次，卸载不再写 state
  useEffect(() => {
    let cancelled = false;
    void listProjects()
      .then(({ projects }) => {
        if (!cancelled) setRecent(projects.slice(0, RECENT_LIMIT));
      })
      .catch((error: unknown) => console.error('[sidebar] 最近项目加载失败：', error));
    return () => {
      cancelled = true;
    };
  }, []);

  const removeRecent = useCallback((projectId: number) => {
    void deleteProject(projectId)
      .then(() => setRecent((prev) => prev.filter((item) => item.id !== projectId)))
      .catch((error: unknown) => console.error('[sidebar] 项目删除失败：', error));
  }, []);

  const navItems = [
    { href: '/', label: '首页', icon: Home, active: pathname === '/' },
    { href: '/projects', label: '我的项目', icon: FolderOpen, active: pathname.startsWith('/projects') },
  ] as const;

  return (
    <aside className="flex h-dvh w-60 shrink-0 flex-col border-r border-border bg-panel">
      {/* 品牌 */}
      <div className="flex items-center gap-2 px-5 py-4">
        <span className="flex size-6 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background">
          A
        </span>
        <span className="text-base font-semibold tracking-tight">Atoms</span>
        <span className="text-xs text-muted-foreground">Demo</span>
      </div>

      {/* 主导航 */}
      <nav className="flex flex-col gap-0.5 px-2">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
              item.active ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </Link>
        ))}
      </nav>

      {/* 最近项目 */}
      <div className="mt-5 min-h-0 flex-1 overflow-y-auto px-2">
        <p className="px-3 pb-1 text-xs text-muted-foreground">最近</p>
        {recent.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground/80">还没有项目记录</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {recent.map((item) => (
              <li key={item.id} className="group relative">
                <Link
                  href={`/p/${item.id}`}
                  className="flex flex-col rounded-lg px-3 py-2 pr-7 transition-colors hover:bg-accent"
                >
                  <span className="truncate text-sm">{item.title}</span>
                  {item.lastMessage === null ? null : (
                    <span className="truncate text-xs text-muted-foreground">{item.lastMessage}</span>
                  )}
                </Link>
                <button
                  type="button"
                  aria-label={`删除项目 ${item.title}`}
                  onClick={() => removeRecent(item.id)}
                  className="absolute right-1.5 top-2 hidden rounded p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground group-hover:block"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* 底部：头像 + 设置入口 */}
      <div className="border-t border-border p-2">
        <Link
          href="/settings"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-foreground/8 text-sm" aria-hidden>
            🧑‍💻
          </span>
          <span className="flex-1">设置</span>
          <Settings className="size-4" aria-hidden />
        </Link>
      </div>
    </aside>
  );
}
