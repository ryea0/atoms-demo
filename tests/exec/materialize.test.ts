// @vitest-environment node
/**
 * 工作区物化单测（Task 1）：
 * files 表逐字节落盘 + __atoms/server.js 注入、stale 清理（保留 __atoms）、
 * 非法路径防御性跳过、per-project 并发互斥、removeWorkspace 幂等。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';
import { removeWorkspace, syncWorkspace, workspaceDir } from '@/lib/exec/materialize';

let storage: StorageProvider;
let projectId: number;
let root: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's-exec-test', title: '物化测试', requirement: 'r', mode: 'fast' });
  projectId = project.id;
  root = await mkdtemp(path.join(tmpdir(), 'atoms-exec-mat-'));
  env = { EXEC_WORKSPACES_DIR: root };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('syncWorkspace', () => {
  it('files 表逐字节落盘 + 注入 __atoms/server.js', async () => {
    await storage.upsertFile({ projectId, path: 'app/frontend/index.html', content: '<html>页面</html>', editor: 'seed' });
    await storage.upsertFile({ projectId, path: 'app/backend/api.js', content: 'exports.handle = () => ({ code: 200 });\n', editor: 'seed' });
    await storage.upsertFile({ projectId, path: 'README.md', content: '# 说明', editor: 'seed' });

    const result = await syncWorkspace(storage, projectId, env);
    expect(result.fileCount).toBe(3);
    expect(result.dir).toBe(path.join(root, `p-${projectId}`));

    const html = await readFile(path.join(result.dir, 'app/frontend/index.html'), 'utf8');
    expect(html).toBe('<html>页面</html>');
    const api = await readFile(path.join(result.dir, 'app/backend/api.js'), 'utf8');
    expect(api).toBe('exports.handle = () => ({ code: 200 });\n');

    const serverJs = await readFile(path.join(result.dir, '__atoms/server.js'), 'utf8');
    expect(serverJs).toContain('ATOMS_SERVER_URL');
    expect(serverJs).toContain('127.0.0.1');
  });

  it('stale 清理：删磁盘多余文件与空目录，__atoms 保留', async () => {
    await storage.upsertFile({ projectId, path: 'keep.txt', content: '保留', editor: 'seed' });
    const dir = workspaceDir(projectId, env);
    await mkdir(path.join(dir, 'stale/deep'), { recursive: true });
    await writeFile(path.join(dir, 'extra.txt'), '多余', 'utf8');
    await writeFile(path.join(dir, 'stale/deep/old.txt'), '旧文件', 'utf8');

    await syncWorkspace(storage, projectId, env);

    const entries = await readdir(dir);
    expect(entries.sort()).toEqual(['__atoms', 'keep.txt']);
    expect(await readFile(path.join(dir, 'keep.txt'), 'utf8')).toBe('保留');
    // __atoms 内容不受 stale 清理影响
    expect((await readdir(path.join(dir, '__atoms'))).includes('server.js')).toBe(true);
  });

  it('非法路径防御性跳过并告警（不落盘）', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await storage.upsertFile({ projectId, path: '../evil.txt', content: '逃逸', editor: 'seed' });
      const result = await syncWorkspace(storage, projectId, env);
      expect(result.fileCount).toBe(0);
      const entries = await readdir(result.dir);
      expect(entries).toEqual(['__atoms']);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('同项目并发物化互斥完成（不交错）', async () => {
    await storage.upsertFile({ projectId, path: 'a.txt', content: 'A', editor: 'seed' });
    const [first, second] = await Promise.all([
      syncWorkspace(storage, projectId, env),
      syncWorkspace(storage, projectId, env),
    ]);
    expect(first.dir).toBe(second.dir);
    expect(await readFile(path.join(first.dir, 'a.txt'), 'utf8')).toBe('A');
  });
});

describe('removeWorkspace', () => {
  it('幂等清理：二次调用不抛', async () => {
    await storage.upsertFile({ projectId, path: 'x.txt', content: 'X', editor: 'seed' });
    const { dir } = await syncWorkspace(storage, projectId, env);
    await removeWorkspace(projectId, env);
    await expect(removeWorkspace(projectId, env)).resolves.toBeUndefined();
    await expect(readdir(dir)).rejects.toThrow();
  });
});
