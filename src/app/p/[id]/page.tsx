import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { z } from 'zod';
import { Workspace } from '@/components/workspace/Workspace';
import { createStorage } from '@/lib/db';
import { isSeedProject } from '@/lib/seed';

/** 路径段校验：纯数字、上限 9 位防溢出（口径与 src/lib/api/route-support.ts 的 numericIdParam 一致） */
const idParamsSchema = z.object({ id: z.string().regex(/^\d{1,9}$/, '必须是数字 id') });

/**
 * 工作台数据由客户端 useWorkspace（快照 REST + SSE）恢复，页面本身是纯壳——
 * metadata 用静态标题，归属校验统一在 GET /api/projects/[id]。
 * 唯一的直读例外（T25 R1 模板画廊）：识别 seed 模板直链并改道 open 端点——
 * seed 行不属于任何访客会话（归属校验会 404），必须先克隆出本会话副本再进入。
 */
export const metadata: Metadata = {
  title: '工作台',
};

/** 工作台 `/p/[id]`：三栏布局 + 顶栏（Next 15 动态路由 params 是 Promise，必须 await） */
export default async function ProjectWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = idParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  const projectId = Number(parsed.data.id);
  const project = await createStorage().getProject(projectId);
  if (project !== null && isSeedProject(project)) {
    // 302 到 open 端点：克隆出当前会话的副本并跳回 /p/{副本id}（新访客顺带补发会话 cookie）
    redirect(`/api/projects/${projectId}/open`);
  }

  return <Workspace projectId={projectId} />;
}
