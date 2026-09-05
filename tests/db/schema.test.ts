import { describe, it, expect } from 'vitest';
import { getTableName } from 'drizzle-orm';
import { getTableConfig, type AnySQLiteColumn, type ForeignKey } from 'drizzle-orm/sqlite-core';
import { rmSync } from 'node:fs';
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

  it('ensureSchema 幂等建出 DESIGN §7 全部 12 张表', () => {
    const db = openSqlite(':memory:');
    try {
      ensureSchema(db);
      ensureSchema(db); // 二次执行必须无害（fresh DB 自举 + 已有库不冲突）
      const rows = nameRows.parse(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all(),
      );
      expect(rows.map((r) => r.name).sort()).toEqual([...ALL_TABLES].sort());
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
