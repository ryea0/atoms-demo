/**
 * 软锁声明路由测试（Task 21，DESIGN §3.9 预防层）。
 *
 * 查看器进入编辑态需把「人工正在编辑」声明到 files.editing_by（TTL 10min），
 * 编排器在工程师文件边界据此挂起并请求裁决（T23 已实现消费侧）——本路由是该声明的唯一入口。
 * 直调 route handler + 内存库（不经网络），口径与 tests/api/routes.test.ts 一致。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@/lib/session';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

const holder = vi.hoisted(() => ({ storage: null as StorageProvider | null }));
vi.mock('@/lib/db', () => ({
  createStorage: (): StorageProvider => {
    if (holder.storage === null) throw new Error('测试存储未初始化（beforeEach 未跑）');
    return holder.storage;
  },
}));

import { PUT as FILE_LOCK_PUT } from '@/app/api/projects/[id]/files/[fid]/lock/route';

const SESSION_A = '00000000-0000-4000-8000-00000000000a';
const SESSION_B = '00000000-0000-4000-8000-00000000000b';

function storage(): StorageProvider {
  if (holder.storage === null) throw new Error('测试存储未初始化');
  return holder.storage;
}

function lockCtx(id: number | string, fid: number | string): { params: Promise<{ id: string; fid: string }> } {
  return { params: Promise.resolve({ id: String(id), fid: String(fid) }) };
}

function putJson(url: string, body: unknown, session?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (session !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${session}`);
  return new Request(url, { method: 'PUT', body: JSON.stringify(body), headers });
}

beforeEach(() => {
  holder.storage = newTestStorage();
});

describe('PUT /api/projects/[id]/files/[fid]/lock', () => {
  it('on=true 声明软锁（进入编辑），on=false 释放（保存/离开）', async () => {
    const project = await storage().createProject({
      sessionId: SESSION_A,
      title: '软锁项目',
      requirement: '做一个待办清单应用',
      mode: 'fast',
    });
    const { fileId } = await storage().upsertFile({
      projectId: project.id,
      path: 'app/a.js',
      content: 'v1',
      editor: 'engineer',
    });

    const on = await FILE_LOCK_PUT(
      putJson(`http://localhost/api/projects/${project.id}/files/${fileId}/lock`, { on: true }, SESSION_A),
      lockCtx(project.id, fileId),
    );
    expect(on.status).toBe(200);
    const locked = await storage().getSoftLockedFiles(project.id);
    expect(locked.map((row) => row.path)).toEqual(['app/a.js']);
    expect(locked[0]?.editingBy).toBe('human');

    const off = await FILE_LOCK_PUT(
      putJson(`http://localhost/api/projects/${project.id}/files/${fileId}/lock`, { on: false }, SESSION_A),
      lockCtx(project.id, fileId),
    );
    expect(off.status).toBe(200);
    expect(await storage().getSoftLockedFiles(project.id)).toEqual([]);
  });

  it('文件不存在 404；body 非法 400；他人 session 404（归属校验与快照路由同口径）', async () => {
    const project = await storage().createProject({
      sessionId: SESSION_A,
      title: '软锁项目2',
      requirement: '做一个待办清单应用',
      mode: 'fast',
    });

    const missing = await FILE_LOCK_PUT(
      putJson(`http://localhost/api/projects/${project.id}/files/9999/lock`, { on: true }, SESSION_A),
      lockCtx(project.id, 9999),
    );
    expect(missing.status).toBe(404);

    const { fileId } = await storage().upsertFile({
      projectId: project.id,
      path: 'app/b.js',
      content: 'v1',
      editor: 'engineer',
    });

    const badBody = await FILE_LOCK_PUT(
      putJson(`http://localhost/api/projects/${project.id}/files/${fileId}/lock`, { on: 'yes' }, SESSION_A),
      lockCtx(project.id, fileId),
    );
    expect(badBody.status).toBe(400);

    const foreign = await FILE_LOCK_PUT(
      putJson(`http://localhost/api/projects/${project.id}/files/${fileId}/lock`, { on: true }, SESSION_B),
      lockCtx(project.id, fileId),
    );
    expect(foreign.status).toBe(404);
    expect(await storage().getSoftLockedFiles(project.id)).toEqual([]);
  });
});
