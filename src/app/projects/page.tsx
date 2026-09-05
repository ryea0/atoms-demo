import type { Metadata } from "next";
import { ProjectsGrid } from "@/components/projects/ProjectsGrid";

export const metadata: Metadata = {
  title: "我的项目",
};

/** 我的项目：卡片墙（数据在 ProjectsGrid 客户端拉取，便于删除/重命名后就地刷新） */
export default function ProjectsPage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">我的项目</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          双击标题可重命名；卡片右上角菜单可进入、导出 zip 或删除。
        </p>
      </header>
      <ProjectsGrid />
    </div>
  );
}
