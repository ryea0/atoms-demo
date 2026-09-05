/**
 * SQLite 虚拟文件系统仓库（DESIGN §12 按仓库分组实现之一）。
 * 约定（CLAUDE.md 规则 6/9/11、.claude/rules/05、DESIGN §3.9/§3.10）：
 * - agent/人工读写只走 files 表；所有查询强制 project_id 过滤——file_versions 无 project_id，
 *   归属一律经 files 回查或联表约束，绝不以裸 fileId 信任调用方
 * - 覆盖写统一入口：事务内「旧版本入 file_versions → 推进 content/version/last_editor」，
 *   agent 写、人工保存、版本恢复共用，保证 diff/回滚/可再撤销语义一致
 * - 事务必须短小：better-sqlite3 的事务回调是同步执行的（返回即 COMMIT），
 *   因此事务内只能用 drizzle 同步 API（run/all）做纯 DB 写，严禁 await/IO/LLM 调用
 */
import { and, asc, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { fileVersions, files } from './schema';
import type { SqliteDb } from './storage';
import type {
  FileEditor,
  FileListItem,
  FileRow,
  FileVersion,
  FilesRepo,
  SaveHumanInput,
  SaveHumanResult,
  UpsertFileInput,
} from '../types';

/** 人工编辑软锁 TTL（DESIGN §3.9：标记 editing_by=human，10min 过期） */
const SOFT_LOCK_TTL_MS = 10 * 60 * 1000;

/** 行 → 领域类型映射：把 schema 形状挡在仓库层内 */
function toFileRow(row: typeof files.$inferSelect): FileRow {
  return {
    id: row.id,
    projectId: row.projectId,
    path: row.path,
    content: row.content,
    producedBy: row.producedBy,
    lastEditor: row.lastEditor,
    editingBy: row.editingBy,
    editingExpiresAt: row.editingExpiresAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toFileVersion(row: typeof fileVersions.$inferSelect): FileVersion {
  return {
    id: row.id,
    fileId: row.fileId,
    version: row.version,
    content: row.content,
    editor: row.editor,
    createdAt: row.createdAt,
  };
}

export function createFilesRepo(db: SqliteDb): FilesRepo {
  /** 按 id 取文件：id 与 project_id 同查，跨项目/不存在的 fileId 一律不可见（规则 9） */
  async function getFileRowById(projectId: number, fileId: number): Promise<FileRow | null> {
    const rows = await db
      .select()
      .from(files)
      .where(and(eq(files.id, fileId), eq(files.projectId, projectId)))
      .limit(1);
    const row = rows[0];
    return row ? toFileRow(row) : null;
  }

  /** 归属校验兜底：file_versions/checkpoints 等子表无 project_id，操作前必须先确认文件归属 */
  function requireFile(row: FileRow | null, projectId: number, fileId: number): FileRow {
    if (!row) throw new Error(`文件不存在或归属不符：projectId=${projectId} fileId=${fileId}`);
    return row;
  }

  /**
   * 覆盖写核心（CAS）：一个短事务内先归档旧版本，再以 version=baseVersion 为条件推进当前版本。
   * 返回新版本号；null = 版本已被并发修改（影响行数 0），由调用方决定是抛错还是按冲突返回。
   * 同步事务（见文件头注释）：回调内不允许 await。
   */
  function overwriteWithArchive(
    fileId: number,
    projectId: number,
    baseVersion: number,
    previous: { content: string; lastEditor: FileEditor },
    next: { content: string; lastEditor: FileEditor },
  ): number | null {
    return db.transaction((tx) => {
      tx.insert(fileVersions)
        .values({ fileId, version: baseVersion, content: previous.content, editor: previous.lastEditor })
        .run();
      const rows = tx
        .update(files)
        .set({
          content: next.content,
          lastEditor: next.lastEditor,
          version: baseVersion + 1,
          updatedAt: Date.now(),
        })
        .where(
          and(eq(files.id, fileId), eq(files.projectId, projectId), eq(files.version, baseVersion)),
        )
        .returning({ version: files.version })
        .all();
      const row = rows[0];
      return row ? row.version : null;
    });
  }

  return {
    /** 统一写入口：新路径插 v1；已存在则旧版本入档并 version+1（V1 串行执行，读后写不再加锁） */
    async upsertFile(input: UpsertFileInput): Promise<{ fileId: number; version: number }> {
      const existingRows = await db
        .select()
        .from(files)
        .where(and(eq(files.projectId, input.projectId), eq(files.path, input.path)))
        .limit(1);
      const existing = existingRows[0];

      if (!existing) {
        const inserted = await db
          .insert(files)
          .values({
            projectId: input.projectId,
            path: input.path,
            content: input.content,
            producedBy: input.editor,
            lastEditor: input.editor,
          })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error('文件写入失败：insert 未返回行');
        return { fileId: row.id, version: row.version };
      }

      const version = overwriteWithArchive(
        existing.id,
        input.projectId,
        existing.version,
        { content: existing.content, lastEditor: existing.lastEditor },
        { content: input.content, lastEditor: input.editor },
      );
      if (version === null) {
        throw new Error(
          `文件并发修改冲突：projectId=${input.projectId} path=${input.path} baseVersion=${existing.version}`,
        );
      }
      return { fileId: existing.id, version };
    },

    async getFile(projectId: number, path: string): Promise<FileRow | null> {
      const rows = await db
        .select()
        .from(files)
        .where(and(eq(files.projectId, projectId), eq(files.path, path)))
        .limit(1);
      const row = rows[0];
      return row ? toFileRow(row) : null;
    },

    async getFileById(projectId: number, fileId: number): Promise<FileRow | null> {
      return getFileRowById(projectId, fileId);
    },

    async listFiles(projectId: number): Promise<FileListItem[]> {
      return db
        .select({ path: files.path, version: files.version, lastEditor: files.lastEditor })
        .from(files)
        .where(eq(files.projectId, projectId))
        .orderBy(asc(files.path))
        .all();
    },

    /** 人工保存（CAS，DESIGN §3.9 检测层）：与 agent 写同一覆盖写入口，旧版本同样入档 */
    async saveHuman(input: SaveHumanInput): Promise<SaveHumanResult> {
      const current = await getFileRowById(input.projectId, input.fileId);
      // 文件不存在（或归属不符）同样走冲突分支：current 置空串，前端按空内容渲染
      if (!current) return { ok: false, conflict: true, current: '' };

      const version = overwriteWithArchive(
        input.fileId,
        input.projectId,
        input.baseVersion,
        { content: current.content, lastEditor: current.lastEditor },
        { content: input.content, lastEditor: 'human' },
      );
      if (version === null) {
        // CAS 失败：回读服务端当前内容供冲突对话框（并排 diff）使用
        const latest = await getFileRowById(input.projectId, input.fileId);
        return { ok: false, conflict: true, current: latest?.content ?? '' };
      }
      return { ok: true, version };
    },

    /** 版本历史：联表强制 project 作用域（file_versions 无 project_id）；新→旧倒序供版本侧栏 */
    async listFileVersions(projectId: number, fileId: number): Promise<FileVersion[]> {
      const rows = await db
        .select({ version: fileVersions })
        .from(fileVersions)
        .innerJoin(files, eq(files.id, fileVersions.fileId))
        .where(and(eq(fileVersions.fileId, fileId), eq(files.projectId, projectId)))
        .orderBy(desc(fileVersions.version), desc(fileVersions.id))
        .all();
      return rows.map((row) => toFileVersion(row.version));
    },

    /** 恢复 = 以该历史版本内容写一个新版本（当前内容照常入档，因此可再撤销） */
    async restoreFileVersion(projectId: number, fileId: number, version: number): Promise<number> {
      const file = requireFile(await getFileRowById(projectId, fileId), projectId, fileId);
      const historyRows = await db
        .select()
        .from(fileVersions)
        .where(and(eq(fileVersions.fileId, fileId), eq(fileVersions.version, version)))
        .limit(1);
      const history = historyRows[0];
      if (!history) {
        throw new Error(`历史版本不存在：projectId=${projectId} fileId=${fileId} version=${version}`);
      }
      // 恢复是人工动作（查看器版本侧栏一键恢复）：last_editor 记 human
      const next = overwriteWithArchive(
        fileId,
        projectId,
        file.version,
        { content: file.content, lastEditor: file.lastEditor },
        { content: history.content, lastEditor: 'human' },
      );
      if (next === null) {
        throw new Error(
          `恢复时版本已被并发修改：projectId=${projectId} fileId=${fileId} baseVersion=${file.version}`,
        );
      }
      return next;
    },

    /** 声明式软锁：只翻标记位，不动 version/updated_at（锁状态不参与内容乐观锁，也不应搅动卡片墙排序） */
    async setSoftLock(projectId: number, fileId: number, on: boolean): Promise<void> {
      await db
        .update(files)
        .set(
          on
            ? { editingBy: 'human', editingExpiresAt: Date.now() + SOFT_LOCK_TTL_MS }
            : { editingBy: null, editingExpiresAt: null },
        )
        .where(and(eq(files.id, fileId), eq(files.projectId, projectId)));
    },

    /** 只统计未过期软锁（editing_by 非空且 TTL 未到）——过期锁视为无人持有 */
    async getSoftLockedFiles(projectId: number): Promise<FileRow[]> {
      const rows = await db
        .select()
        .from(files)
        .where(
          and(
            eq(files.projectId, projectId),
            isNotNull(files.editingBy),
            gt(files.editingExpiresAt, Date.now()),
          ),
        )
        .orderBy(asc(files.path));
      return rows.map(toFileRow);
    },

    async readAllFiles(projectId: number): Promise<FileRow[]> {
      const rows = await db
        .select()
        .from(files)
        .where(eq(files.projectId, projectId))
        .orderBy(asc(files.path));
      return rows.map(toFileRow);
    },
  };
}
