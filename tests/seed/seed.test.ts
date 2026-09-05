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
import { seedDemoProjects, SEED_SESSION_ID } from '@/lib/seed';
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
