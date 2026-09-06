import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StorageProvider } from '@/lib/db/provider/types';
import { syncWorkspace } from '@/lib/exec/materialize';

const root = await mkdtemp(path.join(tmpdir(), 'atoms-ts-proj-'));
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

function fakeStorage(files: Record<string, string>): StorageProvider {
  return { readAllFiles: async () => Object.entries(files).map(([p, content]) => ({ path: p, content })) } as unknown as StorageProvider;
}

describe('TS 物化投影', () => {
  it('api.ts → __atoms/backend.js 为转译产物；server.js 候选链就位', async () => {
    const env = { EXEC_WORKSPACES_DIR: root };
    const ts = 'export function handle(m: string, p: string, b: unknown) { return { code: 200 }; }';
    const { dir } = await syncWorkspace(fakeStorage({ 'app/backend/api.ts': ts }), 901, env);
    const projected = await readFile(path.join(dir, '__atoms', 'backend.js'), 'utf8');
    expect(projected).toContain('exports.handle');
    expect(projected).not.toContain(': string');
    const server = await readFile(path.join(dir, '__atoms', 'server.js'), 'utf8');
    expect(server).toContain("path.join(__dirname, 'backend.js')");
    expect(server).toContain("path.join(root, 'app/backend/api.js')");
  });

  it('js 项目：投影为空串（server.js 回退 app/backend/api.js 不变）', async () => {
    const env = { EXEC_WORKSPACES_DIR: root };
    const { dir } = await syncWorkspace(fakeStorage({ 'app/backend/api.js': 'module.exports={handle(){}}' }), 902, env);
    const projected = await readFile(path.join(dir, '__atoms', 'backend.js'), 'utf8');
    expect(projected).toBe('');
  });
});
