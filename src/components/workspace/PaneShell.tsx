/**
 * 工作台栏位壳（Task 18）：三栏共用的骨架（region 语义 + 标题条 + 空态占位）。
 *
 * Task 19/20/21/22 会把 ChatPanel / FileTree / ViewerTabs / PreviewPane 填进 children，
 * 届时本组件只剩「栏位标题 + 响应式显隐」一件事；空态样式也在此收口，避免三处重复类名。
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PaneShellProps {
  /** 无障碍名（region 语义锚点，如「聊天区」） */
  label: string;
  /** 标题条文案（如「聊天」） */
  title: string;
  /** 窄屏（<lg）单栏模式是否为当前栏目；≥lg 恒显示 */
  active: boolean;
  /** 栏宽与边框（Tailwind 字面量类：桌面三栏 30% / 20% / 50%） */
  className?: string;
  /** 栏内容（空态占位，或后续任务的真实面板） */
  children: ReactNode;
}

export function PaneShell({ label, title, active, className, children }: PaneShellProps) {
  return (
    <section
      aria-label={label}
      // 窄屏只显示当前栏目，≥lg 三栏并排（media query 优先级高于 hidden，无需 JS 判断断点）
      className={cn('min-h-0 min-w-0 flex-col lg:flex', active ? 'flex' : 'hidden', className)}
    >
      <header className="flex h-9 shrink-0 items-center border-b border-border bg-panel px-3">
        <h2 className="text-xs font-medium text-muted-foreground">{title}</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}

interface PaneEmptyProps {
  /** 主提示：一句话说明这一栏放什么 */
  hint: string;
  /** 次级说明（可省） */
  sub?: string;
  /** 附加统计行（如「已生成 2 个文件」） */
  meta?: string;
}

/** 栏位空态：对应面板未接入 / 尚无内容时的占位提示 */
export function PaneEmpty({ hint, sub, meta }: PaneEmptyProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center">
      <p className="text-sm text-muted-foreground">{hint}</p>
      {sub === undefined ? null : <p className="text-xs text-muted-foreground/80">{sub}</p>}
      {meta === undefined ? null : <p className="mt-1 text-xs text-foreground/70">{meta}</p>}
    </div>
  );
}
