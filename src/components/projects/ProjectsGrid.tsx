'use client';

/**
 * 项目卡片墙（Task 17）：GET /api/projects 一次取齐（服务端聚合，禁 N+1），
 * 渲染 ProjectCard；含加载态、错误重试与空态引导。删除后本地移除并回调父级。
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ProjectCard } from '@/components/projects/ProjectCard';
import { listProjects } from '@/lib/client/session';
import type { ProjectListItem } from '@/lib/db/provider/types';

interface ProjectsGridProps {
  /** 项目被删除时通知父级（如同步清理侧栏最近列表） */
  onDeleted?: (projectId: number) => void;
}

export function ProjectsGrid({ onDeleted }: ProjectsGridProps) {
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void listProjects()
      .then(({ projects: list }) => {
        setProjects(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error && cause.message !== '' ? cause.message : '项目列表加载失败');
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDeleted = useCallback(
    (projectId: number) => {
      setProjects((prev) => (prev === null ? prev : prev.filter((item) => item.id !== projectId)));
      onDeleted?.(projectId);
    },
    [onDeleted],
  );

  // 错误优先（首次加载失败与刷新失败同一出口）：错误文案 + 重试，projects 未就绪也能重试
  if (error !== null) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-sm text-muted-foreground">
        <p>{error}</p>
        <Button variant="outline" onClick={refresh}>
          重试
        </Button>
      </div>
    );
  }

  if (projects === null) {
    return <p className="py-12 text-center text-sm text-muted-foreground">正在加载项目…</p>;
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-16 text-center">
        <p className="text-sm font-medium">还没有项目</p>
        <p className="text-xs text-muted-foreground">去首页描述一句话需求，团队会替你产出完整应用。</p>
        <Button asChild variant="outline" className="mt-2">
          <Link href="/">去首页创建</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard
          key={project.id}
          project={project}
          onChanged={refresh}
          onDeleted={handleDeleted}
        />
      ))}
    </div>
  );
}
