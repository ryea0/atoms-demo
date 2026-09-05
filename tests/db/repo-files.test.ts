/**
 * files 虚拟 FS 仓库测试（Task 4）。
 * brief 原文用例在前（CAS 冲突 + 软锁过期），补充回归在后（版本递进入档/恢复往返/跨项目隔离）。
 * 直连 db 只出现在"把软锁过期时间拨到过去"这类夹具操作上——测试可摸 db，生产代码一律走仓库层（.claude/rules/05）。
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { newTestStorage } from '@/lib/db/test-util';
import { openSqlite } from '@/lib/db/provider/sqlite/storage';
import { ensureSchema } from '@/lib/db/provider/sqlite/ddl';
import { createFilesRepo } from '@/lib/db/provider/sqlite/repo-files';
import { createProjectsRepo } from '@/lib/db/provider/sqlite/repo-projects';
import { files } from '@/lib/db/provider/sqlite/schema';
import * as schema from '@/lib/db/provider/sqlite/schema';
import type { StorageProvider } from '@/lib/db/provider/types';

/** 直连装配（额外暴露 db 句柄，仅供夹具直改 editing_expires_at）；与 storage.ts 装配同构 */
function newRepos() {
  const client = openSqlite(':memory:');
  ensureSchema(client);
  const db = drizzle(client, { schema });
  return { db, ...createProjectsRepo(db), ...createFilesRepo(db) };
}

/** 建一个空项目（sessionId/title 随意，测试只关心 id） */
function newProject(s: StorageProvider, sessionId = 's') {
  return s.createProject({ sessionId, title: 't', requirement: 'r', mode: 'fast' });
}

describe('repo files：brief 原文用例', () => {
  it('CAS：并发写一个成功一个冲突', async () => {
    const s = newTestStorage();
    const p = await s.createProject({ sessionId:'s', title:'t', requirement:'r', mode:'fast' });
    const f = await s.upsertFile({ projectId:p.id, path:'app/a.js', content:'v1', editor:'engineer' });
    const a = await s.saveHuman({ projectId:p.id, fileId:f.fileId, content:'human', baseVersion:1 });
    const b = await s.saveHuman({ projectId:p.id, fileId:f.fileId, content:'human2', baseVersion:1 });
    expect(a).toEqual({ ok:true, version:2 });
    expect(b.ok).toBe(false);
    const vers = await s.listFileVersions(p.id, f.fileId);
    expect(vers.length).toBeGreaterThanOrEqual(1); // 旧版本已存
  });

  it('软锁过期不计入', async () => {
    const r = newRepos();
    const p = await r.createProject({ sessionId:'s', title:'t', requirement:'r', mode:'fast' });
    const f = await r.upsertFile({ projectId:p.id, path:'app/b.js', content:'v1', editor:'engineer' });

    await r.setSoftLock(p.id, f.fileId, true);
    const locked = await r.getSoftLockedFiles(p.id);
    expect(locked.map((row) => row.id)).toEqual([f.fileId]);
    expect(locked[0]?.editingBy).toBe('human');

    // 夹具直改：把过期时间拨到过去 → 视为无人持有锁
    await r.db.update(files).set({ editingExpiresAt: Date.now() - 1 }).where(eq(files.id, f.fileId));
    expect(await r.getSoftLockedFiles(p.id)).toHaveLength(0);

    // 手动释放：editing_by / editing_expires_at 双双清空
    await r.setSoftLock(p.id, f.fileId, false);
    const row = await r.getFileById(p.id, f.fileId);
    expect(row?.editingBy).toBeNull();
    expect(row?.editingExpiresAt).toBeNull();
  });
});

describe('repo files：版本历史与作用域补充回归', () => {
  it('upsert：新建 v1（produced_by=editor），覆盖写版本递进且旧版本入档', async () => {
    const s = newTestStorage();
    const p = await newProject(s);
    const first = await s.upsertFile({ projectId:p.id, path:'app/page.js', content:'v1', editor:'engineer' });
    expect(first.version).toBe(1);

    const second = await s.upsertFile({ projectId:p.id, path:'app/page.js', content:'v2', editor:'pm' });
    expect(second.fileId).toBe(first.fileId); // 同一路径 = 同一文件行，不新增
    expect(second.version).toBe(2);

    const row = await s.getFile(p.id, 'app/page.js');
    expect(row?.content).toBe('v2');
    expect(row?.producedBy).toBe('engineer'); // 首次产出者不变
    expect(row?.lastEditor).toBe('pm'); // 最后编辑者跟随本次写入
    expect(row?.version).toBe(2);

    const vers = await s.listFileVersions(p.id, first.fileId);
    expect(vers).toHaveLength(1);
    expect(vers[0]).toMatchObject({ version:1, content:'v1', editor:'engineer' });
  });

  it('restore：恢复=以历史内容写新版本，且可再撤销', async () => {
    const s = newTestStorage();
    const p = await newProject(s);
    const f = await s.upsertFile({ projectId:p.id, path:'app/api.js', content:'v1', editor:'engineer' });
    await s.upsertFile({ projectId:p.id, path:'app/api.js', content:'v2', editor:'engineer' });
    await s.upsertFile({ projectId:p.id, path:'app/api.js', content:'v3', editor:'engineer' });

    const restored = await s.restoreFileVersion(p.id, f.fileId, 1);
    expect(restored).toBe(4);
    expect((await s.getFile(p.id, 'app/api.js'))?.content).toBe('v1');

    // 恢复产生的是新版本，历史仍在 → 可再撤销（回到 v3）
    const undo = await s.restoreFileVersion(p.id, f.fileId, 3);
    expect(undo).toBe(5);
    expect((await s.getFile(p.id, 'app/api.js'))?.content).toBe('v3');

    // 恢复动作本身同样入档：被替换内容按当时版本号进 file_versions
    const vers = await s.listFileVersions(p.id, f.fileId);
    expect(vers.map((v) => [v.version, v.content])).toEqual([[4, 'v1'], [3, 'v3'], [2, 'v2'], [1, 'v1']]);
    expect((await s.getFile(p.id, 'app/api.js'))?.version).toBe(5);

    // 不存在的历史版本 → 显式报错，不静默返回
    await expect(s.restoreFileVersion(p.id, f.fileId, 99)).rejects.toThrow();
  });

  it('saveHuman 成功也入档旧版本，last_editor 记 human', async () => {
    const s = newTestStorage();
    const p = await newProject(s);
    const f = await s.upsertFile({ projectId:p.id, path:'app/page.js', content:'agent 版', editor:'engineer' });
    const saved = await s.saveHuman({ projectId:p.id, fileId:f.fileId, content:'人改版', baseVersion:1 });
    expect(saved).toEqual({ ok:true, version:2 });

    const row = await s.getFile(p.id, 'app/page.js');
    expect(row?.content).toBe('人改版');
    expect(row?.lastEditor).toBe('human');
    expect(row?.producedBy).toBe('engineer');

    const vers = await s.listFileVersions(p.id, f.fileId);
    expect(vers).toHaveLength(1);
    expect(vers[0]).toMatchObject({ version:1, content:'agent 版', editor:'engineer' });
  });

  it('跨项目隔离：B 项目读不到也动不到 A 的文件', async () => {
    const s = newTestStorage();
    const a = await newProject(s, 'a');
    const b = await newProject(s, 'b');
    const f = await s.upsertFile({ projectId:a.id, path:'app/only-a.js', content:'A 的内容', editor:'engineer' });

    expect(await s.getFile(b.id, 'app/only-a.js')).toBeNull();
    expect(await s.getFileById(b.id, f.fileId)).toBeNull();
    expect(await s.listFiles(b.id)).toHaveLength(0);
    expect(await s.readAllFiles(b.id)).toHaveLength(0);
    expect(await s.listFileVersions(b.id, f.fileId)).toHaveLength(0);

    // 保存/恢复/加锁同样被 project_id 作用域挡住
    await expect(
      s.saveHuman({ projectId:b.id, fileId:f.fileId, content:'越权写入', baseVersion:1 }),
    ).resolves.toEqual({ ok:false, conflict:true, current:'' });
    await expect(s.restoreFileVersion(b.id, f.fileId, 1)).rejects.toThrow();
    await s.setSoftLock(b.id, f.fileId, true);
    expect(await s.getSoftLockedFiles(a.id)).toHaveLength(0);
    expect((await s.readAllFiles(a.id))[0]?.editingBy).toBeNull();
  });

  it('listFiles/readAllFiles 形状（file_tree 与快照/导出用）', async () => {
    const s = newTestStorage();
    const p = await newProject(s);
    await s.upsertFile({ projectId:p.id, path:'app/b.js', content:'B', editor:'engineer' });
    const fa = await s.upsertFile({ projectId:p.id, path:'app/a.js', content:'A', editor:'engineer' });
    await s.saveHuman({ projectId:p.id, fileId:fa.fileId, content:'A-human', baseVersion:1 });

    expect(await s.listFiles(p.id)).toEqual([
      { path:'app/a.js', version:2, lastEditor:'human' },
      { path:'app/b.js', version:1, lastEditor:'engineer' },
    ]);

    const all = await s.readAllFiles(p.id);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ path:'app/a.js', content:'A-human', version:2, lastEditor:'human', producedBy:'engineer' });
    // 人工保存与 agent 写同一入口、同样落 file_versions（DESIGN §3.9）
    expect((await s.listFileVersions(p.id, fa.fileId)).map((v) => v.editor)).toEqual(['engineer']);
  });
});
