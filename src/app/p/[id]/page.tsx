import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Workspace } from '@/components/workspace/Workspace';

/** 路径段校验：纯数字、上限 9 位防溢出（口径与 src/lib/api/route-support.ts 的 numericIdParam 一致） */
const idParamsSchema = z.object({ id: z.string().regex(/^\d{1,9}$/, '必须是数字 id') });

/**
 * 工作台数据由客户端 useWorkspace（快照 REST + SSE）恢复，页面本身是纯壳——
 * 因此 metadata 用静态标题，不做二次无会话作用域的 DB 读（归属校验统一在 GET /api/projects/[id]）。
 */
export const metadata: Metadata = {
  title: '工作台',
};

/** 工作台 `/p/[id]`：三栏布局 + 顶栏（Next 15 动态路由 params 是 Promise，必须 await） */
export default async function ProjectWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const parsed = idParamsSchema.safeParse(await params);
  if (!parsed.success) notFound();

  return <Workspace projectId={Number(parsed.data.id)} />;
}
