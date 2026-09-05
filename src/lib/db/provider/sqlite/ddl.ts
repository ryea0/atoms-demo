/**
 * fresh 库自举 DDL（与 drizzle-kit 对 ./schema.ts 的产物一一对应，全部 IF NOT EXISTS 幂等）
 *
 * 目的：内存库（测试）与新部署文件库零配置可用，不强制先跑 `npm run db:push`。
 * 注意两条与 drizzle-kit 对齐的形态（否则 push 到已自举的库会冲突）：
 * 1. 命名唯一约束写成独立 `CREATE UNIQUE INDEX`（drizzle-kit 不用表内 CONSTRAINT 子句）
 * 2. 列默认值/外键写法与 drizzle-kit 生成文本一致（DEFAULT true / no action）
 * 唯一例外是末尾的 FTS5 虚表 files_fts（DESIGN §12 检索扩展点）：drizzle-kit 表达不了
 * CREATE VIRTUAL TABLE，故不进 ./schema.ts，只在此自举；drizzle.config.ts 已用 tablesFilter
 * 把它排除，否则 push 会把它连同 shadow 表一起清掉（T28 实测）。
 * 已有库的加列演进在 migrateColumns 里做幂等兜底（形态与 drizzle-kit 产物同形）；
 * 改列/删列等破坏性演进仍以 drizzle-kit（`npm run db:push`）为准。
 */
import type Database from 'better-sqlite3';

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS \`projects\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`session_id\` text NOT NULL,
  \`title\` text NOT NULL,
  \`requirement\` text NOT NULL,
  \`mode\` text NOT NULL,
  \`status\` text DEFAULT 'draft' NOT NULL,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`messages\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`project_id\` integer NOT NULL,
  \`role\` text NOT NULL,
  \`content\` text NOT NULL,
  \`meta\` text,
  \`delivered_at\` integer,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`agent_runs\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`project_id\` integer NOT NULL,
  \`task_key\` text NOT NULL,
  \`agent\` text NOT NULL,
  \`task\` text NOT NULL,
  \`status\` text DEFAULT 'pending' NOT NULL,
  \`summary\` text,
  \`started_at\` integer,
  \`ended_at\` integer,
  \`error\` text,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`files\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`project_id\` integer NOT NULL,
  \`path\` text NOT NULL,
  \`content\` text NOT NULL,
  \`produced_by\` text NOT NULL,
  \`last_editor\` text NOT NULL,
  \`editing_by\` text,
  \`editing_expires_at\` integer,
  \`version\` integer DEFAULT 1 NOT NULL,
  \`created_at\` integer NOT NULL,
  \`updated_at\` integer NOT NULL,
  FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`file_versions\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`file_id\` integer NOT NULL,
  \`version\` integer NOT NULL,
  \`content\` text NOT NULL,
  \`editor\` text NOT NULL,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`file_id\`) REFERENCES \`files\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`llm_providers\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`name\` text NOT NULL,
  \`base_url\` text NOT NULL,
  \`api_key\` text NOT NULL,
  \`enabled\` integer DEFAULT true NOT NULL,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`llm_models\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`provider_id\` integer NOT NULL,
  \`model_id\` text NOT NULL,
  \`display_name\` text NOT NULL,
  \`price_input\` real DEFAULT 0 NOT NULL,
  \`price_output\` real DEFAULT 0 NOT NULL,
  \`enabled\` integer DEFAULT true NOT NULL,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`provider_id\`) REFERENCES \`llm_providers\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`agent_model_bindings\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`role\` text NOT NULL,
  \`provider_id\` integer NOT NULL,
  \`model_id\` integer NOT NULL,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`provider_id\`) REFERENCES \`llm_providers\`(\`id\`) ON UPDATE no action ON DELETE cascade,
  FOREIGN KEY (\`model_id\`) REFERENCES \`llm_models\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`llm_calls\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`project_id\` integer NOT NULL,
  \`agent_role\` text NOT NULL,
  \`model\` text NOT NULL,
  \`prompt_tokens\` integer NOT NULL,
  \`completion_tokens\` integer NOT NULL,
  \`estimated\` integer DEFAULT 0 NOT NULL,
  \`cost\` real DEFAULT 0 NOT NULL,
  \`latency_ms\` integer NOT NULL,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`preferences\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`scope\` text NOT NULL,
  \`target_id\` text NOT NULL,
  \`data\` text,
  \`created_at\` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS \`checkpoints\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`project_id\` integer NOT NULL,
  \`label\` text NOT NULL,
  \`agent_run_id\` integer,
  \`after_run_id\` integer DEFAULT 0 NOT NULL,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE TABLE IF NOT EXISTS \`checkpoint_files\` (
  \`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  \`checkpoint_id\` integer NOT NULL,
  \`path\` text NOT NULL,
  \`content\` text NOT NULL,
  \`created_at\` integer NOT NULL,
  FOREIGN KEY (\`checkpoint_id\`) REFERENCES \`checkpoints\`(\`id\`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS \`files_project_path\` ON \`files\` (\`project_id\`,\`path\`);
CREATE UNIQUE INDEX IF NOT EXISTS \`preferences_scope_target\` ON \`preferences\` (\`scope\`,\`target_id\`);
CREATE UNIQUE INDEX IF NOT EXISTS \`agent_model_bindings_role\` ON \`agent_model_bindings\` (\`role\`);

/* ---- FTS5 全文检索（DESIGN §12「检索」扩展点，RETRIEVAL_PROVIDER=fts5 时消费）----
   虚表与其 shadow 表不进 drizzle schema（drizzle-kit 不管虚表），只在此自举：
   - rowid = files.id，触发器三件套随 files 写路径同步索引（agent/人工/恢复零改动）
   - files_fts 是存内容的普通 fts5 表：同步用普通 DML 即可（'delete'/'replace' 特殊命令仅外部内容表可用）
   - 全部 IF NOT EXISTS，重复执行无害 */
CREATE VIRTUAL TABLE IF NOT EXISTS \`files_fts\` USING fts5(\`path\`, \`content\`, tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS files_fts_ai AFTER INSERT ON \`files\` BEGIN
  INSERT INTO \`files_fts\`(\`rowid\`, \`path\`, \`content\`) VALUES (new.\`id\`, new.\`path\`, new.\`content\`);
END;
CREATE TRIGGER IF NOT EXISTS files_fts_ad AFTER DELETE ON \`files\` BEGIN
  DELETE FROM \`files_fts\` WHERE rowid = old.\`id\`;
END;
CREATE TRIGGER IF NOT EXISTS files_fts_au AFTER UPDATE ON \`files\` BEGIN
  UPDATE \`files_fts\` SET \`path\` = new.\`path\`, \`content\` = new.\`content\` WHERE rowid = new.\`id\`;
END;
`;

/** fts 索引补齐兜底：FTS 上线前已存在的 files 行没有索引条目，连接自举时按 files.id 补齐（幂等，demo 量级 O(N) 可接受） */
const FTS_BACKFILL_SQL = `
INSERT INTO \`files_fts\`(\`rowid\`, \`path\`, \`content\`)
SELECT \`id\`, \`path\`, \`content\` FROM \`files\`
WHERE \`id\` NOT IN (SELECT \`rowid\` FROM \`files_fts\`);
`;

/** 在连接上执行自举 DDL（幂等，可重复调用） */
export function ensureSchema(db: Database.Database): void {
  db.exec(SCHEMA_DDL);
  db.exec(FTS_BACKFILL_SQL);
  migrateColumns(db);
}

/**
 * 已有库的加列迁移（SQLite 无 ADD COLUMN IF NOT EXISTS：先查 pragma 再 ALTER）。
 * 列形态与 drizzle-kit `npm run db:push` 的产物同形（integer DEFAULT 0 NOT NULL），
 * 新库建表已含列 → no-op；旧库（schema 演进前）在此补齐，无需先手跑 db:push。
 */
function migrateColumns(db: Database.Database): void {
  const columns = db.pragma('table_info(checkpoints)') as unknown;
  if (!Array.isArray(columns)) return;
  const names = new Set(
    columns.flatMap((row) => (typeof row === 'object' && row !== null && 'name' in row && typeof (row as { name: unknown }).name === 'string' ? [(row as { name: string }).name] : [])),
  );
  if (!names.has('after_run_id')) {
    db.exec('ALTER TABLE `checkpoints` ADD COLUMN `after_run_id` integer DEFAULT 0 NOT NULL');
  }
}
