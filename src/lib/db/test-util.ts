/** 测试专用工具（不进生产代码路径） */
import { createSqliteStorage } from './provider/sqlite/storage';
import type { StorageProvider } from './provider/types';

/** 每次调用返回独立的内存库 StorageProvider（含 PRAGMA 与建表自举，无磁盘副作用） */
export function newTestStorage(): StorageProvider {
  return createSqliteStorage(':memory:');
}
