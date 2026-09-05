import { describe, it, expect } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { z } from 'zod';
import { newTestStorage } from '@/lib/db/test-util';
import { openSqlite } from '@/lib/db/provider/sqlite/storage';
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

/** better-sqlite3 的 pragma()/all() 返回 unknown，这里用 zod 收窄（规则 01/07） */
const nameRows = z.array(z.object({ name: z.string() }));

describe('schema', () => {
  it('建表并可插入项目', async () => {
    const s = newTestStorage();
    const p = await s.createProject({ sessionId: 'sx', title: 't', requirement: 'r', mode: 'fast' });
    expect(p.id).toBeGreaterThan(0);
    expect((await s.listProjects('sx')).length).toBe(1);
  });

  it('ensureSchema 幂等建出 DESIGN §7 全部 12 张表', () => {
    const db = openSqlite(':memory:');
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
  });

  it('DDL 列集合与 drizzle schema 一致（防手写 DDL 漂移）', () => {
    const db = openSqlite(':memory:');
    ensureSchema(db);
    expect(Object.keys(tables).length).toBe(ALL_TABLES.length);
    for (const table of Object.values(tables)) {
      const name = getTableName(table);
      const actual = nameRows.parse(db.pragma(`table_info(${name})`)).map((r) => r.name).sort();
      const expected = Object.values(getTableColumns(table)).map((c) => c.name).sort();
      expect(actual, `表 ${name} 的列与 schema.ts 不一致`).toEqual(expected);
    }
  });
});
