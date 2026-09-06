/**
 * SQLite 项目仓库（DESIGN §12 按仓库分组实现之一）。
 * 约定（.claude/rules/05、CLAUDE.md 规则 9）：
 * - 每个方法闭包绑定同一连接，全部查询强制 sessionId/projectId 过滤
 * - 列表聚合（文件数/token 汇总/最后消息）单条 SQL 取齐，禁 N+1
 * - SQLite 无 jsonb，JSON 走 text({mode:'json'})，由 schema 层序列化/反序列化
 */
import { count, desc, eq, sql } from 'drizzle-orm';
import { files, llmCalls, messages, projects } from './schema';
import type { SqliteDb } from './storage';
import type { CreateProjectInput, Project, ProjectListItem, ProjectsRepo, ProjectStatus } from '../types';

/** 行 → 领域类型映射：把 schema 形状挡在仓库层内，避免 schema 加列泄漏进业务类型 */
function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    sessionId: row.sessionId,
    title: row.title,
    requirement: row.requirement,
    mode: row.mode,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createProjectsRepo(db: SqliteDb): ProjectsRepo {
  return {
    /** 建项目：status/created_at/updated_at 由库默认值兜底 */
    async createProject(input: CreateProjectInput): Promise<Project> {
      const rows = await db.insert(projects).values(input).returning();
      const row = rows[0];
      if (!row) throw new Error('项目写入失败：insert 未返回行');
      return toProject(row);
    },

    /** 项目总数（count(*) 单行聚合；seed 幂等守卫用，与 session 无关） */
    async countProjects(): Promise<number> {
      const rows = await db.select({ value: count() }).from(projects).all();
      return rows[0]?.value ?? 0;
    },

    /**
     * 按 session 列项目（卡片墙数据）。
     * 三表直连会产生笛卡尔积（文件数×调用数），计数被放大——所以 files/llm_calls 各自先按
     * project_id 预聚合成派生表再 leftJoin；最后一条消息没有天然聚合函数（需按 created_at+id
     * 兜底排序取一条），用相关子查询表达。整体仍是一条 SQL，每行只查一次库，无 N+1。
     */
    async listProjects(sessionId: string): Promise<ProjectListItem[]> {
      const fileAgg = db
        .select({ projectId: files.projectId, fileCount: count(files.id).as('file_count') })
        .from(files)
        .groupBy(files.projectId)
        .as('fa');
      const tokenAgg = db
        .select({
          projectId: llmCalls.projectId,
          totalTokens: sql<number>`sum(${llmCalls.promptTokens} + ${llmCalls.completionTokens})`.as('total_tokens'),
        })
        .from(llmCalls)
        .groupBy(llmCalls.projectId)
        .as('ta');

      const rows = await db
        .select({
          project: projects,
          fileCount: sql<number>`coalesce(${fileAgg.fileCount}, 0)`,
          totalTokens: sql<number>`coalesce(${tokenAgg.totalTokens}, 0)`,
          lastMessage: sql<
            string | null
          >`(select m.content from ${messages} m where m.project_id = ${projects.id} order by m.created_at desc, m.id desc limit 1)`,
        })
        .from(projects)
        .leftJoin(fileAgg, eq(fileAgg.projectId, projects.id))
        .leftJoin(tokenAgg, eq(tokenAgg.projectId, projects.id))
        .where(eq(projects.sessionId, sessionId))
        .orderBy(desc(projects.updatedAt), desc(projects.id));

      return rows.map((r) => ({
        ...toProject(r.project),
        fileCount: r.fileCount,
        totalTokens: r.totalTokens,
        lastMessage: r.lastMessage,
      }));
    },

    async getProject(projectId: number): Promise<Project | null> {
      const rows = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
      const row = rows[0];
      return row ? toProject(row) : null;
    },

    /** 重命名：顺带推进 updated_at，让卡片墙/最近会话按变更时间排序 */
    async renameProject(projectId: number, title: string): Promise<void> {
      await db.update(projects).set({ title, updatedAt: Date.now() }).where(eq(projects.id, projectId));
    },

    /** 删除项目：子表经外键 onDelete cascade 一并清除（连接已开 foreign_keys=ON） */
    async deleteProject(projectId: number): Promise<void> {
      await db.delete(projects).where(eq(projects.id, projectId));
    },

    async updateProjectStatus(projectId: number, status: ProjectStatus): Promise<void> {
      await db.update(projects).set({ status, updatedAt: Date.now() }).where(eq(projects.id, projectId));
    },

    /** 最近会话：updatedAt 倒序（并列时按 id 稳定排序），默认 8 条 */
    async getRecentSessions(sessionId: string, limit = 8): Promise<Project[]> {
      const rows = await db
        .select()
        .from(projects)
        .where(eq(projects.sessionId, sessionId))
        .orderBy(desc(projects.updatedAt), desc(projects.id))
        .limit(limit);
      return rows.map(toProject);
    },
  };
}
