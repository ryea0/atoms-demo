/**
 * 存储入口（DESIGN §12）：DB_DRIVER 工厂。
 * 业务代码统一 `createStorage()` 取 StorageProvider，切换实现不改调用方。
 */
import { createSqliteStorage } from './provider/sqlite/storage';
import type { StorageProvider } from './provider/types';

export function createStorage(env: NodeJS.ProcessEnv = process.env): StorageProvider {
  if ((env.DB_DRIVER ?? 'sqlite') !== 'sqlite') {
    throw new Error('postgres provider 未实现（DESIGN §12 预留）');
  }
  return createSqliteStorage(env.DB_FILE ?? 'data/app.db');
}
