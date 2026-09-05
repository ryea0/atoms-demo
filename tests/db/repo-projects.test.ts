import { describe, it, expect } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { newTestStorage } from '@/lib/db/test-util';
import { openSqlite } from '@/lib/db/provider/sqlite/storage';
import { ensureSchema } from '@/lib/db/provider/sqlite/ddl';
import { createProjectsRepo } from '@/lib/db/provider/sqlite/repo-projects';
import { createMessagesRepo } from '@/lib/db/provider/sqlite/repo-messages';
import { files, llmCalls, projects } from '@/lib/db/provider/sqlite/schema';
import * as schema from '@/lib/db/provider/sqlite/schema';

describe('repo projects/messages', () => {
  it('删除项目级联消息；干预队列取后标记', async () => {
    const s = newTestStorage();
    const p = await s.createProject({ sessionId:'s1', title:'t', requirement:'r', mode:'fast' });
    await s.addMessage({ projectId:p.id, role:'intervention', content:'按钮改蓝色' });
    const pend = await s.takePendingInterventions(p.id);
    expect(pend.length).toBe(1);
    // @ts-expect-error 测试样例按 brief 原文保留，未对 pend[0] 判空（noUncheckedIndexedAccess 语义）
    await s.markDelivered([pend[0].id]);
    expect((await s.takePendingInterventions(p.id)).length).toBe(0);
    await s.deleteProject(p.id);
    expect(await s.getProject(p.id)).toBeNull();
    expect((await s.listMessages(p.id)).length).toBe(0);
  });
  it('跨 session 隔离', async () => {
    const s = newTestStorage();
    await s.createProject({ sessionId:'a', title:'t', requirement:'r', mode:'fast' });
    expect((await s.listProjects('b')).length).toBe(0);
  });
});

/**
 * 补充回归（brief 两用例未覆盖的接口面）：聚合 DTO、重命名/状态、最近会话、meta JSON 回读。
 * 直接装配仓库（与 storage.ts 的 assembleStorage 同构），并经同一连接造 files/llm_calls 数
 * （测试夹具可摸 db；生产代码一律走仓库层——.claude/rules/05）。
 */
describe('repo projects 聚合与状态', () => {
  function newRepos() {
    const client = openSqlite(':memory:');
    ensureSchema(client);
    const db = drizzle(client, { schema });
    return { db, ...createProjectsRepo(db), ...createMessagesRepo(db) };
  }

  function seedFile(projectId: number, path: string) {
    return { projectId, path, content: 'export {}', producedBy: 'seed' as const, lastEditor: 'seed' as const };
  }

  function seedCall(projectId: number, promptTokens: number, completionTokens: number) {
    return { projectId, agentRole: 'pm' as const, model: 'mock', promptTokens, completionTokens, latencyMs: 1 };
  }

  it('listProjects 一次查询聚合 文件数/token 汇总/最后消息（无 N+1）', async () => {
    const r = newRepos();
    const p = await r.createProject({ sessionId: 's', title: '卡片', requirement: '做个 TODO', mode: 'fast' });
    const empty = await r.createProject({ sessionId: 's', title: '空项目', requirement: 'r', mode: 'full' });
    await r.db.insert(files).values([seedFile(p.id, 'app/page.tsx'), seedFile(p.id, 'app/api.ts')]);
    await r.db.insert(llmCalls).values([seedCall(p.id, 10, 5), seedCall(p.id, 7, 3)]);
    await r.addMessage({ projectId: p.id, role: 'user', content: '第一条' });
    await r.addMessage({ projectId: p.id, role: 'assistant', content: '最后一条' });

    const rows = await r.listProjects('s');
    expect(rows).toHaveLength(2);
    const full = rows.find((row) => row.id === p.id);
    expect(full?.fileCount).toBe(2);
    expect(full?.totalTokens).toBe(25); // (10+5)+(7+3)，不被 join 笛卡尔积放大
    expect(full?.lastMessage).toBe('最后一条');
    const blank = rows.find((row) => row.id === empty.id);
    expect(blank?.fileCount).toBe(0);
    expect(blank?.totalTokens).toBe(0);
    expect(blank?.lastMessage).toBeNull();
  });

  it('重命名/状态更新；getRecentSessions 按 updatedAt 倒序且默认 8 条', async () => {
    const r = newRepos();
    const ids: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const created = await r.createProject({ sessionId: 's', title: `p${i}`, requirement: 'r', mode: 'fast' });
      ids.push(created.id);
    }
    // updated_at 是毫秒精度：同一毫秒批量建项目会让全部行并列，orderBy 退化成 id 兜底 → 断言非确定
    // （原用例的 flake）。夹具先把基线拨成彼此不同的过去值，让排序断言只考察 updatedAt。
    const base = Date.now() - 10_000;
    let offset = 0;
    for (const id of ids) {
      if (id === ids[0]) continue; // 首个创建的项目留给 renameProject 推进
      await r.db.update(projects).set({ updatedAt: base + offset }).where(eq(projects.id, id));
      offset += 1;
    }
    const oldestId = ids[0];
    if (oldestId === undefined) throw new Error('应已创建 10 个项目');
    await r.renameProject(oldestId, '改名了');
    await r.updateProjectStatus(oldestId, 'running');

    const after = await r.getProject(oldestId);
    expect(after?.title).toBe('改名了');
    expect(after?.status).toBe('running');

    const recent = await r.getRecentSessions('s');
    expect(recent).toHaveLength(8); // 默认 limit=8
    expect(recent[0]?.id).toBe(oldestId); // 刚更新的项目排最前
    let prevUpdatedAt: number | undefined;
    for (const row of recent) {
      if (prevUpdatedAt !== undefined) expect(prevUpdatedAt).toBeGreaterThanOrEqual(row.updatedAt);
      prevUpdatedAt = row.updatedAt;
    }
    expect(await r.getRecentSessions('s', 3)).toHaveLength(3);
  });

  it('meta JSON 对象回读；非干预消息落库即视为已送达', async () => {
    const r = newRepos();
    const p = await r.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'fast' });
    await r.addMessage({ projectId: p.id, role: 'user', content: '找工程师改', meta: { mentions: ['engineer'] } });
    const msgs = await r.listMessages(p.id);
    expect(msgs[0]?.meta).toEqual({ mentions: ['engineer'] });
    expect(msgs[0]?.deliveredAt).not.toBeNull();
  });

  it('markDelivered 带 projectId 只标记本项目；缺省 projectId 仍按裸 ids 标记', async () => {
    const s = newTestStorage();
    const a = await s.createProject({ sessionId: 's', title: 'A', requirement: 'r', mode: 'fast' });
    const b = await s.createProject({ sessionId: 's', title: 'B', requirement: 'r', mode: 'fast' });
    const ia = await s.addMessage({ projectId: a.id, role: 'intervention', content: 'A 的干预' });
    const ib = await s.addMessage({ projectId: b.id, role: 'intervention', content: 'B 的干预' });

    // 作用域路径：即使批量里混入了他项目 id，也只能动本项目（规则 9）
    await s.markDelivered([ia.id, ib.id], a.id);
    expect((await s.takePendingInterventions(a.id)).length).toBe(0);
    expect((await s.takePendingInterventions(b.id)).length).toBe(1); // B 不被误伤
    const after = await s.listMessages(a.id);
    expect(after[0]?.deliveredAt).not.toBeNull();
    expect((await s.listMessages(b.id))[0]?.deliveredAt).toBeNull();

    // 缺省 projectId：向后兼容的裸 ids 路径
    await s.markDelivered([ib.id]);
    expect((await s.takePendingInterventions(b.id)).length).toBe(0);
  });
});
