import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig, type AnySQLiteColumn, type ForeignKey } from 'drizzle-orm/sqlite-core';
import { rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { newTestStorage } from '@/lib/db/test-util';
import { createSqliteStorage, openSqlite } from '@/lib/db/provider/sqlite/storage';
import { ensureSchema } from '@/lib/db/provider/sqlite/ddl';
import * as tables from '@/lib/db/provider/sqlite/schema';

/** DESIGN §7 的全部表（12 张）：schema.ts 漏建即失败 */
const ALL_TABLES = [
  'projects',
  'messages',
  'agent_runs',
  'files',
  'file_versions',
  'llm_providers',
  'llm_models',
  'agent_model_bindings',
  'llm_calls',
  'preferences',
  'checkpoints',
  'checkpoint_files',
] as const;

/**
 * FTS5 检索扩展点（Task 28，DESIGN §12）：虚表 + 其 5 张 shadow 表。
 * drizzle-kit 不管虚表（schema.ts 无对应声明），只由 ddl.ts 自举——这里显式钉住
 * 对象清单，避免「以为 push 会建/删它」或 shadow 表漏建导致检索静默失效。
 */
const FTS_TABLES = [
  'files_fts',
  'files_fts_config',
  'files_fts_content',
  'files_fts_data',
  'files_fts_docsize',
  'files_fts_idx',
] as const;

/** 表级元组：name + type + notnull + dflt_value + pk */
type ColumnTuple = readonly [string, string, string, string | null, string];
/** 外键元组：from -> table.to on_delete on_update（统一小写，忽略声明顺序差异） */
type FkTuple = string;

/** better-sqlite3 的 pragma()/all() 返回 unknown，用 zod 收窄（规则 01/07） */
const nameRows = z.array(z.object({ name: z.string() }));
const columnInfoRows = z.array(
  z.object({
    name: z.string(),
    type: z.string(),
    notnull: z.number(),
    dflt_value: z.string().nullable(),
    pk: z.number(),
  }),
);
const fkListRows = z.array(
  z.object({
    table: z.string(),
    from: z.string(),
    to: z.string().nullable(),
    on_update: z.string(),
    on_delete: z.string(),
  }),
);

/** drizzle 列默认值 → SQLite dflt_value 文本（必须与 drizzle-kit 生成的 DDL 字面量同形：DEFAULT true / 'draft' / 0） */
function expectedDefault(column: AnySQLiteColumn): string | null {
  const value: unknown = column.default;
  if (value === undefined) return null; // $defaultFn（created_at）/自增 id/无默认 → 库侧无 DEFAULT 子句
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  throw new Error(`未支持的列默认值类型：${String(value)}`);
}

function expectedColumns(table: Parameters<typeof getTableConfig>[0]): ColumnTuple[] {
  return getTableConfig(table)
    .columns.map(
      (c) =>
        [
          c.name,
          c.getSQLType().toLowerCase(), // SQLite 的 PRAGMA 会把关键字类型大写（INTEGER/REAL），统一小写比较
          String(c.notNull),
          expectedDefault(c),
          String(c.primary),
        ] as const,
    )
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** drizzle 外键集合 → 可比较元组（未显式声明的 action 在 SQLite 侧落 NO ACTION） */
function expectedForeignKeys(fks: readonly ForeignKey[]): FkTuple[] {
  return fks
    .map((fk) => {
      const ref = fk.reference();
      const from = ref.columns.map((c) => c.name).join(',');
      const to = `${getTableConfig(ref.foreignTable).name}.${ref.foreignColumns.map((c) => c.name).join(',')}`;
      return `${from}->${to} ${(fk.onDelete ?? 'no action').toLowerCase()} ${(fk.onUpdate ?? 'no action').toLowerCase()}`;
    })
    .sort();
}

function actualColumns(db: Database.Database, table: string): ColumnTuple[] {
  return columnInfoRows
    .parse(db.pragma(`table_info(${table})`))
    .map((r) => [r.name, r.type.toLowerCase(), r.notnull ? 'true' : 'false', r.dflt_value, r.pk ? 'true' : 'false'] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
}

function actualForeignKeys(db: Database.Database, table: string): FkTuple[] {
  return fkListRows
    .parse(db.pragma(`foreign_key_list(${table})`))
    .map((r) => `${r.from}->${r.table}.${r.to} ${r.on_delete.toLowerCase()} ${r.on_update.toLowerCase()}`)
    .sort();
}

describe('schema', () => {
  it('建表并可插入项目', async () => {
    const s = newTestStorage();
    const p = await s.createProject({ sessionId: 'sx', title: 't', requirement: 'r', mode: 'fast' });
    expect(p.id).toBeGreaterThan(0);
    expect((await s.listProjects('sx')).length).toBe(1);
  });

  it('ensureSchema 幂等建出 DESIGN §7 全部 12 张表 + FTS5 虚表（T28）', () => {
    const db = openSqlite(':memory:');
    try {
      ensureSchema(db);
      ensureSchema(db); // 二次执行必须无害（fresh DB 自举 + 已有库不冲突）
      const rows = nameRows.parse(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all(),
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...ALL_TABLES, ...FTS_TABLES].sort());
      // 命名唯一约束必须落成独立 UNIQUE INDEX（与 drizzle-kit 形态一致，否则 db:push 撞名）
      const idx = nameRows
        .parse(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all())
        .map((r) => r.name)
        .sort();
      expect(idx).toEqual(['agent_model_bindings_role', 'files_project_path', 'preferences_scope_target']);
    } finally {
      db.close();
    }
  });

  /**
   * T2 对齐守卫扩展（T28）：FTS5 虚表形态与触发器清单钉死。
   * 虚表不进 drizzle schema（drizzle-kit 不管虚表），漂移只能在这里拦：
   * - files_fts 必须 trigram 分词（子串检索语义依赖它）
   * - 触发器三件套名字固定（ai/ad/au），files 写路径零改动即可保持索引同步
   */
  it('FTS5 虚表 trigram 分词 + files 触发器三件套（防漂移）', () => {
    const db = openSqlite(':memory:');
    try {
      ensureSchema(db);
      ensureSchema(db); // IF NOT EXISTS 二次执行不得重复建/报错
      const objects = z
        .array(z.object({ name: z.string(), type: z.string(), sql: z.string().nullable() }))
        .parse(db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name LIKE 'files_fts%'").all());
      const virtualTable = objects.find((o) => o.name === 'files_fts');
      expect(virtualTable?.type).toBe('table');
      expect(virtualTable?.sql ?? '').toContain('CREATE VIRTUAL TABLE');
      expect(virtualTable?.sql ?? '').toContain("tokenize='trigram'");
      const triggers = objects.filter((o) => o.type === 'trigger').map((o) => o.name).sort();
      expect(triggers).toEqual(['files_fts_ad', 'files_fts_ai', 'files_fts_au']);
      for (const trigger of objects.filter((o) => o.type === 'trigger')) {
        expect(trigger.sql ?? '').toContain('files_fts');
        expect(trigger.sql ?? '').toContain('ON `files`');
      }
    } finally {
      db.close();
    }
  });

  /** 触发器同步冒烟（行为面）：写 files → 索引立即可搜；删 files → 索引同步删除 */
  it('FTS5 触发器随 files 写/删同步索引', () => {
    const db = openSqlite(':memory:');
    try {
      ensureSchema(db);
      db.exec("INSERT INTO `projects` (`id`, `session_id`, `title`, `requirement`, `mode`, `status`, `created_at`, `updated_at`) VALUES (1, 's', 't', 'r', 'fast', 'draft', 0, 0)");
      const insert = db.prepare(
        'INSERT INTO `files` (`project_id`, `path`, `content`, `produced_by`, `last_editor`, `version`, `created_at`, `updated_at`) VALUES (1, ?, ?, ?, ?, 1, 0, 0)',
      );
      insert.run('src/api.js', 'export const api = 1\n', 'seed', 'seed');
      const search = db.prepare("SELECT rowid, `path` FROM `files_fts` WHERE `files_fts` MATCH ?");
      expect(search.all('content: "const api"')).toEqual([{ rowid: 1, path: 'src/api.js' }]);
      // 覆盖写：旧词消失、新词可搜（新内容不得包含旧查询串，否则 trigram 子串语义仍会命中）
      db.prepare('UPDATE `files` SET `content` = ? WHERE `id` = 1').run('export const widget = 2\n');
      expect(search.all('content: "const api"')).toEqual([]);
      expect(search.all('content: "const widget"')).toEqual([{ rowid: 1, path: 'src/api.js' }]);
      // 删除：索引同步清空
      db.prepare('DELETE FROM `files` WHERE `id` = 1').run();
      expect(search.all('content: "const widget"')).toEqual([]);
    } finally {
      db.close();
    }
  });

  /**
   * 全量列/外键一致性守护：ddl.ts 是手写自举 DDL，schema.ts 改列型/默认值/外键动作而没同步 DDL 时，
   * 这里必须红（否则 db:push 会再次撞上已自举的库）。covers DEFAULT true/'draft'、NOT NULL、pk、ON DELETE。
   */
  it('DDL 与 drizzle schema 的列元组、外键动作完全一致（防漂移）', () => {
    const db = openSqlite(':memory:');
    try {
      ensureSchema(db);
      expect(Object.keys(tables).length).toBe(ALL_TABLES.length);
      for (const table of Object.values(tables)) {
        const name = getTableName(table);
        const cfg = getTableConfig(table);
        expect(actualColumns(db, name), `表 ${name} 的列定义与 schema.ts 不一致`).toEqual(expectedColumns(table));
        expect(actualForeignKeys(db, name), `表 ${name} 的外键与 schema.ts 不一致`).toEqual(
          expectedForeignKeys(cfg.foreignKeys),
        );
      }
    } finally {
      db.close();
    }
  });

  /** 加列迁移兜底（fix 轮）：演进前的旧库缺 after_run_id，ensureSchema 必须 ALTER 补齐且幂等 */
  it('旧库缺 after_run_id 列时 ensureSchema 幂等补列（形态与新库一致）', () => {
    const db = openSqlite(':memory:');
    try {
      // 模拟演进前的旧表（无 after_run_id）
      db.exec(
        'CREATE TABLE `checkpoints` (`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL, `project_id` integer NOT NULL, `label` text NOT NULL, `agent_run_id` integer, `created_at` integer NOT NULL)',
      );
      ensureSchema(db);
      ensureSchema(db); // 二次执行无冲突（列已补齐）
      const columns = columnInfoRows.parse(db.pragma('table_info(checkpoints)'));
      const added = columns.find((c) => c.name === 'after_run_id');
      // pragma 对 ALTER 加列的类型返回大写（SQLite 规范化），按小写比较
      expect(added && { ...added, type: added.type.toLowerCase() }).toMatchObject({ type: 'integer', notnull: 1, dflt_value: '0', pk: 0 });
      // 新建表路径与迁移路径的列集合一致
      const fresh = openSqlite(':memory:');
      try {
        ensureSchema(fresh);
        const freshColumns = columnInfoRows.parse(fresh.pragma('table_info(checkpoints)'));
        expect(columns.map((c) => c.name).sort()).toEqual(freshColumns.map((c) => c.name).sort());
      } finally {
        fresh.close();
      }
    } finally {
      db.close();
    }
  });

  /**
   * db:push 守卫（T28 实测发现的坑）：drizzle-kit 会把不在 schema 里的 files_fts 及其 shadow 表
   * 当「未知表」清掉（且因 shadow 表依赖顺序中途报错），留下悬空触发器让 files 写路径直接报
   * no such table。唯一防线是 drizzle.config.ts 的 tablesFilter 排除——这里用文本断言钉住它。
   */
  it('drizzle-kit push 排除 FTS5 虚表（否则 push 清掉索引并留悬空触发器）', async () => {
    const config = await readFile(join(process.cwd(), 'drizzle.config.ts'), 'utf8');
    expect(config).toMatch(/tablesFilter:\s*\[[^\]]*'!\s*files_fts\*'/);
  });

  /** 文件库连接生命周期：同路径 memoize 复用同一实例，close 幂等，close 后可重开且数据仍在（WAL 落盘） */
  it('文件库按路径 memoize + close 可重开', async () => {
    const file = join(tmpdir(), `atoms-task2-${process.pid}.db`);
    try {
      const a = createSqliteStorage(file);
      const b = createSqliteStorage(file);
      expect(b).toBe(a); // 同路径复用同一连接（不叠加 WAL 写者）
      await a.createProject({ sessionId: 'm', title: 't', requirement: 'r', mode: 'full' });
      a.close();
      a.close(); // 幂等
      const c = createSqliteStorage(file); // 关闭后再取 → 重新打开
      expect(c).not.toBe(a);
      expect(await c.listProjects('m')).toHaveLength(1);
      c.close();
    } finally {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) rmSync(f, { force: true });
    }
  });

  /** ':memory:' 不参与 memoize：每次调用是全新隔离库（test-util 的测试语义） */
  it(':memory: 每次调用返回全新独立实例', async () => {
    const a = newTestStorage();
    const b = newTestStorage();
    expect(b).not.toBe(a);
    await a.createProject({ sessionId: 'x', title: 't', requirement: 'r', mode: 'fast' });
    expect(await b.listProjects('x')).toHaveLength(0);
  });
});
