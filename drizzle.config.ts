import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'sqlite', schema: './src/lib/db/provider/sqlite/schema.ts',
  out: './drizzle', dbCredentials: { url: process.env.DB_FILE ?? 'data/app.db' },
  /**
   * FTS5 虚表不在 drizzle schema 里（drizzle-kit 无法表达 CREATE VIRTUAL TABLE）：
   * 不排除的话 push 会把 files_fts 及其 shadow 表当「未知表」清掉（实测如此），还会留下
   * 悬空触发器让 files 写路径报 no such table。排除后 push 对虚表零操作（实测两次连跑
   * No changes detected）；索引由 ddl.ts 自举（含重建 + 补齐），与 push 的先后顺序无关。
   */
  tablesFilter: ['*', '!files_fts*'],
});
