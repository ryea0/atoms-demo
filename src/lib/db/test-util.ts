/** 测试专用工具（不进生产代码路径） */
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './provider/sqlite/schema';
import { createSqliteStorage, createStorageFromClient, openSqlite, type SqliteDb } from './provider/sqlite/storage';
import type { StorageProvider } from './provider/types';

/** 每次调用返回独立的内存库 StorageProvider（含 PRAGMA 与建表自举，无磁盘副作用） */
export function newTestStorage(): StorageProvider {
  return createSqliteStorage(':memory:');
}

/**
 * 独立内存库 + 同连接的 drizzle 实例：仓库层尚未暴露写方法的表（llm_providers/llm_models/
 * agent_model_bindings 等全局表）可直接用 db 插桩数据；storage 与插桩共用同一连接、互相可见。
 */
export function newTestStorageWithDb(): { storage: StorageProvider; db: SqliteDb } {
  const client = openSqlite(':memory:');
  return { storage: createStorageFromClient(client), db: drizzle(client, { schema }) };
}
