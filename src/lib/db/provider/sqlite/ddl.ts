/**
 * fresh 库自举 DDL（与 drizzle-kit 对 ./schema.ts 的产物一一对应，全部 IF NOT EXISTS 幂等）
 *
 * 目的：内存库（测试）与新部署文件库零配置可用，不强制先跑 `npm run db:push`。
 * 注意两条与 drizzle-kit 对齐的形态（否则 push 到已自举的库会冲突）：
 * 1. 命名唯一约束写成独立 `CREATE UNIQUE INDEX`（drizzle-kit 不用表内 CONSTRAINT 子句）
 * 2. 列默认值/外键写法与 drizzle-kit 生成文本一致（DEFAULT true / no action）
 * 已有库的 schema 演进（加列/改列）仍以 drizzle-kit（`npm run db:push`）为准。
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
`;

/** 在连接上执行自举 DDL（幂等，可重复调用） */
export function ensureSchema(db: Database.Database): void {
  db.exec(SCHEMA_DDL);
}
