'use client';

/**
 * 项目卡片（Task 17）：标题（双击 inline 重命名）、需求摘要、最近消息、状态徽章、
 * 模式标签、文件数、tokens、相对时间；右上角操作菜单（进入 / 导出 zip / 删除→Dialog 二次确认）。
 */
import { useState } from 'react';
import Link from 'next/link';
import { Download, LogIn, MoreVertical, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  deleteProject,
  openProjectExport,
  renameProject,
} from '@/lib/client/session';
import { formatRelativeTime, formatTokens, modeLabel, statusBadgeVariant, statusLabel } from '@/lib/client/format';
import type { ProjectListItem } from '@/lib/db/provider/types';

interface ProjectCardProps {
  project: ProjectListItem;
  /** 标题重命名/删除成功后通知父级刷新列表 */
  onChanged: () => void;
  /** 删除成功回调（父级可同步清理侧栏最近列表） */
  onDeleted: (projectId: number) => void;
}

export function ProjectCard({ project, onChanged, onDeleted }: ProjectCardProps) {
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState(project.title);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const startRename = (): void => {
    setDraftTitle(project.title);
    setRenaming(true);
  };

  const commitRename = (): void => {
    const title = draftTitle.trim();
    setRenaming(false);
    if (title === '' || title === project.title) {
      setDraftTitle(project.title);
      return;
    }
    void renameProject(project.id, title)
      .then(onChanged)
      .catch((error: unknown) => {
        console.error('[project-card] 重命名失败：', error);
        setDraftTitle(project.title);
      });
  };

  const confirmDelete = (): void => {
    setDeleting(true);
    void deleteProject(project.id)
      .then(() => onDeleted(project.id))
      .catch((error: unknown) => console.error('[project-card] 删除失败：', error))
      .finally(() => {
        setDeleting(false);
        setConfirmOpen(false);
      });
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 transition-colors hover:border-foreground/20">
      <div className="flex items-start gap-2">
        {renaming ? (
          <Input
            value={draftTitle}
            autoFocus
            aria-label="项目标题"
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') {
                setDraftTitle(project.title);
                setRenaming(false);
              }
            }}
            className="h-7 text-sm"
          />
        ) : (
          <Link
            href={`/p/${project.id}`}
            title="双击重命名"
            onDoubleClick={startRename}
            className="min-w-0 flex-1 truncate text-sm font-medium"
          >
            {project.title}
          </Link>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`更多操作 ${project.title}`}>
              <MoreVertical className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem asChild>
              <Link href={`/p/${project.id}`}>
                <LogIn aria-hidden />
                进入工作台
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openProjectExport(project.id)}>
              <Download aria-hidden />
              导出 zip
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmOpen(true)}>
              <Trash2 aria-hidden />
              删除项目
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{project.requirement}</p>

      {project.lastMessage === null ? null : (
        <p className="line-clamp-1 border-l-2 border-border pl-2 text-xs text-muted-foreground">{project.lastMessage}</p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={statusBadgeVariant(project.status)}>{statusLabel(project.status)}</Badge>
        <Badge variant="outline">{modeLabel(project.mode)}</Badge>
        <span className="font-mono">{project.fileCount} 个文件</span>
        <span className="font-mono">{formatTokens(project.totalTokens)} tokens</span>
        <span className="ml-auto">{formatRelativeTime(project.updatedAt)}</span>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除项目「{project.title}」？</DialogTitle>
            <DialogDescription>
              项目下的文件、消息、任务记录与用量统计会一并删除，此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              取消
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? '删除中…' : '确认删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
