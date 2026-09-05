/**
 * agent_runs / checkpoints / llm_calls / preferences 仓库测试（Task 5，最后一组仓库）。
 * brief 原文用例在前（checkpoint 恢复往返 + rolled_back 标记），补充回归在后
 * （updateAgentRun 作用域、usageByProject 聚合、preference upsert 往返、跨项目隔离）。
 * 直连 db 只出现在夹具（直删 files 行 / 直查 llm_calls 列）——测试可摸 db，生产代码一律走仓库层（.claude/rules/05）。
 */
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq } from 'drizzle-orm';
import { newTestStorage } from '@/lib/db/test-util';
import { openSqlite } from '@/lib/db/provider/sqlite/storage';
import { ensureSchema } from '@/lib/db/provider/sqlite/ddl';
import { createProjectsRepo } from '@/lib/db/provider/sqlite/repo-projects';
import { createFilesRepo } from '@/lib/db/provider/sqlite/repo-files';
import { createRunsRepo } from '@/lib/db/provider/sqlite/repo-runs';
import { createMiscRepo } from '@/lib/db/provider/sqlite/repo-misc';
import { checkpointFiles, checkpoints, files, llmCalls } from '@/lib/db/provider/sqlite/schema';
import * as schema from '@/lib/db/provider/sqlite/schema';
import type { StorageProvider } from '@/lib/db/provider/types';

/** 建一个空项目（sessionId/title 随意，测试只关心 id） */
function newProject(s: StorageProvider, sessionId = 's') {
  return s.createProject({ sessionId, title: 't', requirement: 'r', mode: 'fast' });
}

/** 直连装配（额外暴露 db 句柄，仅供夹具直删/直查）；与 storage.ts 的 assembleStorage 同构 */
function newRepos() {
  const client = openSqlite(':memory:');
  ensureSchema(client);
  const db = drizzle(client, { schema });
  return {
    db,
    ...createProjectsRepo(db),
    ...createFilesRepo(db),
    ...createRunsRepo(db),
    ...createMiscRepo(db),
  };
}

describe('repo runs：brief 原文用例', () => {
  it('checkpoint 恢复后 files 内容回到快照，且旧内容可再找回（file_versions）', async () => {
    const s = newTestStorage();
    const p = await newProject(s);
    const a = await s.upsertFile({ projectId: p.id, path: 'app/a.js', content: 'A1', editor: 'engineer' });
    const b = await s.upsertFile({ projectId: p.id, path: 'app/b.js', content: 'B1', editor: 'engineer' });
    const cpId = await s.createCheckpoint(p.id, 'pm 任务前基线', null);
    expect(cpId).toBeGreaterThan(0);

    // 打点之后继续演进：改 a.js、改 b.js、新增 c.js
    await s.upsertFile({ projectId: p.id, path: 'app/a.js', content: 'A2', editor: 'engineer' });
    await s.upsertFile({ projectId: p.id, path: 'app/b.js', content: 'B2', editor: 'pm' });
    await s.upsertFile({ projectId: p.id, path: 'app/c.js', content: 'C1', editor: 'engineer' });
    expect(await s.readAllFiles(p.id)).toHaveLength(3);

    const affected = await s.restoreCheckpoint(p.id, cpId);
    // 受影响 = 快照内路径（按路径升序）；c.js 是打点后新增、不在快照内 → 不动也不在返回值里
    expect(affected).toEqual([a.fileId, b.fileId]);

    const rowA = await s.getFile(p.id, 'app/a.js');
    expect(rowA?.content).toBe('A1');
    expect(rowA?.version).toBe(3); // A1(1) → A2(2) → 恢复回 A1(3)
    expect(rowA?.producedBy).toBe('engineer'); // 恢复只推进内容/版本，首产者不丢
    expect(rowA?.lastEditor).toBe('human'); // 回滚是人工拍板动作（DESIGN §3.10）
    expect((await s.getFile(p.id, 'app/b.js'))?.content).toBe('B1');
    expect((await s.getFile(p.id, 'app/c.js'))?.content).toBe('C1');

    // 旧内容可再找回：恢复动作把「覆盖前内容」按当时版本号入档 file_versions
    expect((await s.listFileVersions(p.id, a.fileId)).map((v) => [v.version, v.content])).toEqual([
      [2, 'A2'],
      [1, 'A1'],
    ]);
    // 因此回滚本身可撤销：把 A2 找回来
    const undo = await s.restoreFileVersion(p.id, a.fileId, 2);
    expect(undo).toBe(4);
    expect((await s.getFile(p.id, 'app/a.js'))?.content).toBe('A2');
  });

  it('markRunsRolledBack：id ≤ uptoRunId 的本项目任务全部标 rolled_back，其余不受影响', async () => {
    const s = newTestStorage();
    const p = await newProject(s, 'a');
    const other = await newProject(s, 'b');
    const r1 = await s.createAgentRun({ projectId: p.id, taskKey: 'pm:prd', agent: 'pm', task: '产出 PRD' });
    const r2 = await s.createAgentRun({ projectId: p.id, taskKey: 'arch:design', agent: 'architect', task: '出架构图' });
    const r3 = await s.createAgentRun({ projectId: p.id, taskKey: 'eng:app/a.js', agent: 'engineer', task: '写 app/a.js' });
    await s.createAgentRun({ projectId: other.id, taskKey: 'eng:app/b.js', agent: 'engineer', task: '写 app/b.js' });

    // 先推进到中间态，验证回滚标记会覆盖既有状态
    await s.updateAgentRun(r1.id, { status: 'done', summary: 'PRD 完成' });
    await s.updateAgentRun(r2.id, { status: 'running', startedAt: Date.now() });
    await s.updateAgentRun(r3.id, { status: 'done', endedAt: Date.now() });

    await s.markRunsRolledBack(p.id, r2.id);

    const runs = await s.listAgentRuns(p.id);
    expect(runs.map((r) => [r.id, r.status])).toEqual([
      [r1.id, 'rolled_back'],
      [r2.id, 'rolled_back'],
      [r3.id, 'done'],
    ]);
    // 回滚只改状态：summary/交接摘要保留（时间线展示与续跑交接都要用）
    expect(runs[0]?.summary).toBe('PRD 完成');
    // 别项目的任务不受影响
    expect((await s.listAgentRuns(other.id)).map((r) => r.status)).toEqual(['pending']);
  });
});

describe('repo runs：agent_runs CRUD 与作用域补充回归', () => {
  it('createAgentRun 默认 pending；updateAgentRun 只推进出现的字段；listAgentRuns 时间正序', async () => {
    const s = newTestStorage();
    const p = await newProject(s);
    const run = await s.createAgentRun({ projectId: p.id, taskKey: 'leader:route', agent: 'leader', task: '路由分派' });
    expect(run).toMatchObject({
      projectId: p.id,
      taskKey: 'leader:route',
      agent: 'leader',
      status: 'pending',
      summary: null,
      startedAt: null,
      endedAt: null,
      error: null,
    });

    await s.updateAgentRun(run.id, { status: 'running', startedAt: 1000 });
    expect((await s.listAgentRuns(p.id))[0]).toMatchObject({ status: 'running', startedAt: 1000, endedAt: null });

    await s.updateAgentRun(run.id, { status: 'done', summary: '交接摘要 v1' });
    // 只传 summary/error：status/started_at 不被冲掉；summary 传 null = 显式清空（中断后重算降级摘要）
    await s.updateAgentRun(run.id, { summary: null, error: '下游校验失败' });
    expect((await s.listAgentRuns(p.id))[0]).toMatchObject({
      status: 'done',
      startedAt: 1000,
      summary: null,
      error: '下游校验失败',
    });

    // 空 patch 不发 SQL 也不报错
    await expect(s.updateAgentRun(run.id, {})).resolves.toBeUndefined();

    await s.createAgentRun({ projectId: p.id, taskKey: 'eng:app/a.js', agent: 'engineer', task: '写 app/a.js' });
    const list = await s.listAgentRuns(p.id);
    expect(list).toHaveLength(2);
    expect(list[0]?.taskKey).toBe('leader:route'); // created_at 并列时按 id 稳定排序
    expect(list[1]?.taskKey).toBe('eng:app/a.js');
  });

  it('updateAgentRun 带 projectId 只动本项目任务（混入他项目 id 也不误伤）；缺省仍按裸 id', async () => {
    const s = newTestStorage();
    const a = await newProject(s, 'a');
    const b = await newProject(s, 'b');
    const ra = await s.createAgentRun({ projectId: a.id, taskKey: 'eng:a.js', agent: 'engineer', task: 'A 的任务' });
    const rb = await s.createAgentRun({ projectId: b.id, taskKey: 'eng:b.js', agent: 'engineer', task: 'B 的任务' });

    // 作用域路径：id 是 B 的任务、projectId 是 A → 什么都没改（规则 9）
    await s.updateAgentRun(rb.id, { status: 'failed', error: '不应写入' }, a.id);
    expect(await s.listAgentRuns(b.id)).toMatchObject([{ status: 'pending', error: null }]);
    expect(await s.listAgentRuns(a.id)).toMatchObject([{ status: 'pending', error: null }]);

    // 作用域命中：正常推进
    await s.updateAgentRun(ra.id, { status: 'running', startedAt: 1 }, a.id);
    expect(await s.listAgentRuns(a.id)).toMatchObject([{ status: 'running', startedAt: 1 }]);

    // 缺省 projectId：向后兼容的裸 id 路径（调用方须已自行校验归属）
    await s.updateAgentRun(rb.id, { status: 'done', summary: 'B 完成' });
    expect(await s.listAgentRuns(b.id)).toMatchObject([{ status: 'done', summary: 'B 完成' }]);
  });
});

describe('repo misc：检查点补充回归', () => {
  it('listCheckpoints 新→旧且项目隔离；空项目打点/恢复为空操作；越权与不存在均拒绝', async () => {
    const s = newTestStorage();
    const p = await newProject(s, 'a');
    const other = await newProject(s, 'b');

    const emptyCp = await s.createCheckpoint(p.id, '空项目基线', null);
    expect(await s.restoreCheckpoint(p.id, emptyCp)).toEqual([]);

    const run = await s.createAgentRun({ projectId: p.id, taskKey: 'eng:a.js', agent: 'engineer', task: '写 a.js' });
    const cp1 = await s.createCheckpoint(p.id, '任务前基线', run.id);
    const cp2 = await s.createCheckpoint(p.id, '人工保存前', null);
    await s.createCheckpoint(other.id, 'B 项目的打点', null);

    const list = await s.listCheckpoints(p.id);
    expect(list.map((c) => [c.id, c.label, c.agentRunId])).toEqual([
      [cp2, '人工保存前', null],
      [cp1, '任务前基线', run.id],
      [emptyCp, '空项目基线', null],
    ]);
    expect(list.every((c) => c.projectId === p.id)).toBe(true);

    // 跨项目 / 不存在的检查点 → 显式报错，不静默返回
    await expect(s.restoreCheckpoint(other.id, cp1)).rejects.toThrow();
    await expect(s.restoreCheckpoint(p.id, cp1 + 10_000)).rejects.toThrow();
  });

  it('恢复返回的 fileId 按快照路径升序，不受 checkpoint_files 插入顺序影响（夹具直造乱序快照）', async () => {
    const r = newRepos();
    const p = await r.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'fast' });
    // 故意按非字母序建文件：z.js 先建、a.js 后建
    const z = await r.upsertFile({ projectId: p.id, path: 'app/z.js', content: 'Z1', editor: 'engineer' });
    const a = await r.upsertFile({ projectId: p.id, path: 'app/a.js', content: 'A1', editor: 'engineer' });
    await r.upsertFile({ projectId: p.id, path: 'app/z.js', content: 'Z2', editor: 'engineer' });

    // 夹具直造检查点 + 乱序快照行（绕过打点时的路径排序，模拟未来插入顺序变更）：
    // 快照行 id 序 = z.js 在前、a.js 在后，与路径序相反
    const cpRows = await r.db
      .insert(checkpoints)
      .values({ projectId: p.id, label: '乱序快照', agentRunId: null })
      .returning();
    const cp = cpRows[0];
    if (!cp) throw new Error('夹具检查点写入失败');
    await r.db.insert(checkpointFiles).values([
      { checkpointId: cp.id, path: 'app/z.js', content: 'Z1' },
      { checkpointId: cp.id, path: 'app/a.js', content: 'A1' },
    ]);

    const affected = await r.restoreCheckpoint(p.id, cp.id);
    expect(affected).toEqual([a.fileId, z.fileId]); // 按路径升序，而非快照行插入序
    expect((await r.getFile(p.id, 'app/a.js'))?.content).toBe('A1');
    expect((await r.getFile(p.id, 'app/z.js'))?.content).toBe('Z1');
  });

  it('快照中已不存在的文件行，恢复时重建（files 无删除 API，夹具直删模拟行消失）', async () => {
    const r = newRepos();
    const p = await r.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'fast' });
    const a = await r.upsertFile({ projectId: p.id, path: 'app/a.js', content: 'A1', editor: 'engineer' });
    const b = await r.upsertFile({ projectId: p.id, path: 'app/b.js', content: 'B1', editor: 'engineer' });
    const cp = await r.createCheckpoint(p.id, '任务前', null);

    await r.db.delete(files).where(eq(files.id, b.fileId));
    expect(await r.getFileById(p.id, b.fileId)).toBeNull();

    const affected = await r.restoreCheckpoint(p.id, cp);
    expect(affected).toHaveLength(2);
    expect(affected[0]).toBe(a.fileId); // 仍在的文件沿用原 fileId
    const reborn = await r.getFile(p.id, 'app/b.js');
    expect(reborn?.content).toBe('B1');
    expect(reborn?.version).toBe(1);
    expect(affected[1]).toBe(reborn?.id); // 重建行拿到新 fileId
    // 旧行级联删除带走历史：重建行不带旧版本
    expect(await r.listFileVersions(p.id, b.fileId)).toHaveLength(0);
    expect(await r.getFileById(p.id, b.fileId)).toBeNull(); // 旧行不会被复活
  });
});

describe('repo misc：llm_calls 计量', () => {
  const call = (projectId: number, agentRole: 'pm' | 'engineer', model: string) =>
    ({ projectId, agentRole, model, promptTokens: 0, completionTokens: 0, estimated: 0, cost: 0, latencyMs: 1 });

  it('usageByProject 按 agentRole+model 聚合 tokens/calls（一条 SQL），且跨项目隔离', async () => {
    const s = newTestStorage();
    const p = await newProject(s);
    const other = await newProject(s, 'other');
    const blank = await newProject(s, 'blank');

    const rows = [
      { ...call(p.id, 'pm', 'mock'), promptTokens: 10, completionTokens: 5 },
      { ...call(p.id, 'pm', 'mock'), promptTokens: 7, completionTokens: 3, estimated: 1 }, // 估算值同样计入
      { ...call(p.id, 'pm', 'qwen-max'), promptTokens: 100, completionTokens: 50 },
      { ...call(p.id, 'engineer', 'mock'), promptTokens: 1, completionTokens: 2 },
      { ...call(other.id, 'pm', 'mock'), promptTokens: 999, completionTokens: 999 }, // 别项目
    ];
    for (const row of rows) await s.recordLlmCall(row);

    expect(await s.usageByProject(blank.id)).toEqual([]);
    expect(await s.usageByProject(p.id)).toEqual([
      { agentRole: 'engineer', model: 'mock', tokens: 3, calls: 1 },
      { agentRole: 'pm', model: 'mock', tokens: 25, calls: 2 }, // (10+5)+(7+3)，不被估算标记拆行
      { agentRole: 'pm', model: 'qwen-max', tokens: 150, calls: 1 },
    ]);
    expect(await s.usageByProject(other.id)).toEqual([
      { agentRole: 'pm', model: 'mock', tokens: 1998, calls: 1 },
    ]);
  });

  it('recordLlmCall 列级形状原样落库（estimated/cost/latency 驱动 UI 提示，钉死映射）', async () => {
    const r = newRepos();
    const p = await r.createProject({ sessionId: 's', title: 't', requirement: 'r', mode: 'fast' });
    await r.recordLlmCall({
      projectId: p.id,
      agentRole: 'engineer',
      model: 'qwen-coder',
      promptTokens: 3,
      completionTokens: 4,
      estimated: 1,
      cost: 0.25,
      latencyMs: 77,
    });
    const rows = await r.db.select().from(llmCalls).where(eq(llmCalls.projectId, p.id)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      projectId: p.id,
      agentRole: 'engineer',
      model: 'qwen-coder',
      promptTokens: 3,
      completionTokens: 4,
      estimated: 1,
      cost: 0.25,
      latencyMs: 77,
    });
  });
});

describe('repo misc：preferences', () => {
  it('setPreference/getPreference：upsert 覆盖 + scope/target 隔离 + 未命中返回 null', async () => {
    const s = newTestStorage();
    expect(await s.getPreference('session', 'sess-1')).toBeNull();

    await s.setPreference('session', 'sess-1', { editingEnabled: true });
    expect(await s.getPreference('session', 'sess-1')).toEqual({ editingEnabled: true });

    // 同键二次写 = 覆盖（preferences_scope_target 唯一约束走 onConflictDoUpdate，不撞索引）
    await s.setPreference('session', 'sess-1', { editingEnabled: false });
    expect(await s.getPreference('session', 'sess-1')).toEqual({ editingEnabled: false });

    // 不同 target / 不同 scope 互不影响（编辑开关按 session 存，user 级是 schema 预留）
    await s.setPreference('session', 'sess-2', { editingEnabled: true });
    await s.setPreference('user', 'sess-1', { theme: 'dark' });
    expect(await s.getPreference('session', 'sess-1')).toEqual({ editingEnabled: false });
    expect(await s.getPreference('session', 'sess-2')).toEqual({ editingEnabled: true });
    expect(await s.getPreference('user', 'sess-1')).toEqual({ theme: 'dark' });
    expect(await s.getPreference('user', 'sess-3')).toBeNull();
  });
});
