/**
 * SQLite 版 StorageProvider 工厂（DESIGN §12 当前实现：drizzle sqlite + better-sqlite3 WAL）
 * 方法随 Task 3-5 逐组补齐；业务代码只依赖 StorageProvider 接口，不 import 本文件。
 */
import { desc, eq } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureSchema } from './ddl';
import { projects } from './schema';
import * as schema from './schema';
import type { CreateProjectInput, Project, StorageProvider } from '../types';

/** drizzle sqlite 连接类型（带 schema 推断），后续仓库模块复用 */
export type SqliteDb = BetterSQLite3Database<typeof schema>;

/**
 * 打开 better-sqlite3 连接并套用 PRAGMA（.claude/rules/05：连接初始化一次性执行）：
 * WAL + synchronous=NORMAL + foreign_keys=ON（级联删除依赖外键约束）。
 * 文件库先递归建目录（如 data/）；`:memory:` 跳过（WAL 对内存库不生效，无害）。
 */
export function openSqlite(dbFile: string): Database.Database {
  if (dbFile !== ':memory:') mkdirSync(dirname(dbFile), { recursive: true });
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** SQLite 实现：方法按仓库分组，逐任务补齐 */
class SqliteStorage implements StorageProvider {
  private readonly db: SqliteDb;

  constructor(
    private readonly dbFile: string,
    private readonly client: Database.Database,
    db: SqliteDb,
  ) {
    this.db = db;
  }

  /** 建项目：status/created_at/updated_at 由库默认值兜底 */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const rows = await this.db.insert(projects).values(input).returning();
    const row = rows[0];
    if (!row) throw new Error('项目写入失败：insert 未返回行');
    return row;
  }

  /** 按 session 列项目：最小实现（列表聚合字段随 Task 3 的 repo-projects 扩展） */
  async listProjects(sessionId: string): Promise<Project[]> {
    return this.db
      .select()
      .from(projects)
      .where(eq(projects.sessionId, sessionId))
      .orderBy(desc(projects.updatedAt));
  }

  /** 关闭连接（幂等）：文件库实例同时移出缓存，之后需重新走工厂 */
  close(): void {
    fileStorages.delete(this.dbFile);
    if (this.client.open) this.client.close();
  }
}

/** 文件库实例缓存（按 dbFile 路径 memoize）：同进程同库只持一个连接，防句柄泄漏与 WAL 写者叠加 */
const fileStorages = new Map<string, StorageProvider>();

/**
 * 工厂：dbFile 传 ':memory:' 即内存库，否则为文件库路径。
 * 生命周期：文件库按路径 memoize——在模块层调用一次并长期持有，勿每请求新建；释放走 `storage.close()`。
 * ':memory:' 不缓存：每次调用返回全新独立内存库（测试隔离语义，见 src/lib/db/test-util.ts）。
 */
export function createSqliteStorage(dbFile: string): StorageProvider {
  const isMemory = dbFile === ':memory:';
  const cached = isMemory ? undefined : fileStorages.get(dbFile);
  if (cached) return cached;
  const client = openSqlite(dbFile);
  ensureSchema(client);
  const storage = new SqliteStorage(dbFile, client, drizzle(client, { schema }));
  if (!isMemory) fileStorages.set(dbFile, storage);
  return storage;
}
