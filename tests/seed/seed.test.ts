/**
 * Task 25 seed 测试：预置演示项目（D3「快速模式 + 预置项目」的演示保底）。
 *
 * - projects 表为空 → 插 2 个 seed 项目（sessionId='seed'、status=done），
 *   文件树直接用 samples 渲染落库（docs 交付物 + app 全栈骨架 + start_app.sh）
 * - 幂等：重复执行不重复插（表非空即跳过）
 * - 产物形态与真实链路一致：预览入口 app/frontend/index.html + 后端 app/backend/api.js
 *   可被 assemblePreview 装配，lastEditor/producedBy = 'seed'（文件树绿角标「预置文件」）
 */
import { describe, expect, it } from 'vitest';
import { openProjectOrTemplate, seedDemoProjects, SEED_SESSION_ID } from '@/lib/seed';
import { assemblePreview } from '@/lib/preview/assemble';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

describe('seedDemoProjects', () => {
  it('空库插入 2 个演示项目：done + sessionId=seed，samples 渲染文件树落库', async () => {
    const storage = newTestStorage();
    const result = await seedDemoProjects(storage);

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toBe(false);
    expect(await storage.countProjects()).toBe(2);

    for (const project of result.created) {
      expect(project.sessionId).toBe(SEED_SESSION_ID);
      expect(project.status).toBe('done');
      expect(project.mode).toBe('fast');
      expect(project.requirement.trim()).not.toBe('');

      const paths = (await storage.listFiles(project.id)).map((row) => row.path);
      // docs 交付物 + 全栈骨架 + 启动说明（与真实生成链路的产物形态一致）
      expect(paths).toContain('docs/prd.md');
      expect(paths).toContain('docs/system_design.md');
      expect(paths).toContain('docs/file_tree.json');
      expect(paths).toContain('app/frontend/index.html');
      expect(paths).toContain('app/backend/api.js');
      expect(paths).toContain('app/start_app.sh');
      // 全部按 seed 编辑者落库（文件树绿角标 = 预置文件）
      const rows = await storage.readAllFiles(project.id);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.lastEditor).toBe('seed');
        expect(row.producedBy).toBe('seed');
        expect(row.version).toBe(1);
      }
    }
  });

  it('两个演示项目差异化：待办（crud 模板）与数据看板（dashboard 模板）', async () => {
    const storage = newTestStorage();
    const { created } = await seedDemoProjects(storage);
    const [first, second] = created;
    if (first === undefined || second === undefined) throw new Error('seed 项目不足 2 个');

    const a = await storage.getFile(first.id, 'app/backend/api.js');
    const b = await storage.getFile(second.id, 'app/backend/api.js');
    expect(a?.content).toContain('/api/todos');
    expect(b?.content).toContain('/api/stats');
    expect(a?.content).not.toBe(b?.content);
  });

  it('预览契约成立：seed 项目直接可装配（index.html + api.js 注入垫片）', async () => {
    const storage = newTestStorage();
    const { created } = await seedDemoProjects(storage);
    const first = created[0];
    if (first === undefined) throw new Error('seed 项目缺失');

    const assembly = await assemblePreview(storage, first.id);
    expect(assembly.ok).toBe(true);
    if (!assembly.ok) return;
    expect(assembly.html).toContain('__ATOMS_BACKEND__');
    expect(assembly.html).toContain('window.fetch');
  });

  it('幂等：projects 表非空（已有 seed）时跳过，不重复插', async () => {
    const storage = newTestStorage();
    const first = await seedDemoProjects(storage);
    const second = await seedDemoProjects(storage);

    expect(second.skipped).toBe(true);
    expect(second.created).toHaveLength(0);
    expect(await storage.countProjects()).toBe(first.created.length);
  });

  it('幂等边界：库里已有其他会话的项目同样跳过（守卫口径=整表非空）', async () => {
    const storage: StorageProvider = newTestStorage();
    await storage.createProject({ sessionId: 'someone', title: '用户项目', requirement: 'r', mode: 'fast' });

    const result = await seedDemoProjects(storage);
    expect(result.skipped).toBe(true);
    expect(result.created).toHaveLength(0);
    expect(await storage.countProjects()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 模板画廊：打开即克隆（T25 R1，评审 Finding 1）                          */
/* ------------------------------------------------------------------ */

describe('openProjectOrTemplate', () => {
  it('seed 模板 → 克隆到当前会话：新 id、sessionId=调用方、标题带后缀、文件齐全、原 seed 不动', async () => {
    const storage = newTestStorage();
    const [seed] = (await seedDemoProjects(storage)).created;
    if (seed === undefined) throw new Error('seed 项目缺失');

    const outcome = await openProjectOrTemplate(storage, 'session-a', seed.id);
    if (outcome === null) throw new Error('openProjectOrTemplate 返回 null');
    expect(outcome.cloned).toBe(true);
    expect(outcome.projectId).not.toBe(seed.id);

    const copy = await storage.getProject(outcome.projectId);
    expect(copy?.sessionId).toBe('session-a');
    expect(copy?.status).toBe('done');
    expect(copy?.title).toBe(`${seed.title}（示例副本）`);
    expect(copy?.requirement).toBe(seed.requirement);

    // 文件逐份对齐（内容与编辑者标记一致），且原 seed 项目完全不被占用
    const seedFiles = await storage.readAllFiles(seed.id);
    const copyFiles = await storage.readAllFiles(outcome.projectId);
    expect(copyFiles.map((f) => [f.path, f.content, f.lastEditor])).toEqual(
      seedFiles.map((f) => [f.path, f.content, f.lastEditor]),
    );
    expect((await storage.getProject(seed.id))?.sessionId).toBe(SEED_SESSION_ID);
    expect((await storage.readAllFiles(seed.id)).map((f) => f.content)).toEqual(seedFiles.map((f) => f.content));
  });

  it('同会话重复打开同一模板 → 复用已有副本（不堆积）', async () => {
    const storage = newTestStorage();
    const [seed] = (await seedDemoProjects(storage)).created;
    if (seed === undefined) throw new Error('seed 项目缺失');

    const first = await openProjectOrTemplate(storage, 'session-a', seed.id);
    const second = await openProjectOrTemplate(storage, 'session-a', seed.id);
    // 同一副本（cloned 只在真正克隆的那次为 true），库里不新增行
    expect(second?.projectId).toBe(first?.projectId);
    expect(second?.cloned).toBe(false);
    expect(await storage.countProjects()).toBe(3); // 2 seed + 1 副本
  });

  it('其他会话打开同一模板 → 各得一份副本', async () => {
    const storage = newTestStorage();
    const [seed] = (await seedDemoProjects(storage)).created;
    if (seed === undefined) throw new Error('seed 项目缺失');

    const a = await openProjectOrTemplate(storage, 'session-a', seed.id);
    const b = await openProjectOrTemplate(storage, 'session-b', seed.id);
    if (a === null || b === null) throw new Error('openProjectOrTemplate 返回 null');
    expect(a.projectId).not.toBe(b.projectId);
    expect((await storage.getProject(a.projectId))?.sessionId).toBe('session-a');
    expect((await storage.getProject(b.projectId))?.sessionId).toBe('session-b');
  });

  it('普通项目原样返回（不克隆不写库）；项目不存在返回 null', async () => {
    const storage = newTestStorage();
    const mine = await storage.createProject({ sessionId: 'session-a', title: '我的项目', requirement: 'r', mode: 'fast' });
    const before = await storage.countProjects();

    await expect(openProjectOrTemplate(storage, 'session-b', mine.id)).resolves.toEqual({
      projectId: mine.id,
      cloned: false,
    });
    expect(await storage.countProjects()).toBe(before);

    await expect(openProjectOrTemplate(storage, 'session-a', 424242)).resolves.toBeNull();
  });
});
