// @vitest-environment node
/**
 * engineer bash 自检工具单测：schema 边界、执行结果映射（exit 0/非 0/超时/禁用）、
 * 工作区物化鲜度（upsertFile 后 cat 读到新内容）、per-run 5 次预算的 WeakMap 语义
 * （同一 ctx 耗尽 → 新 ctx 对象重置）、长输出首尾截断。
 * 隔离关键：EXEC_WORKSPACES_DIR 指向 mkdtemp 临时目录（否则物化写真仓库 data/workspaces）。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASH_MAX_CALLS_PER_RUN, bashTool, type ToolContext } from '@/lib/agents/tools';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

let storage: StorageProvider;
let projectId: number;
let ctx: ToolContext;
let tempRoot: string;
let prevWorkspacesDir: string | undefined;

beforeEach(async () => {
  storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's-bash-test', title: 'bash 工具测试', requirement: 'r', mode: 'fast' });
  projectId = project.id;
  ctx = { storage, projectId, role: 'engineer' };
  tempRoot = await mkdtemp(path.join(tmpdir(), 'atoms-bash-tool-'));
  prevWorkspacesDir = process.env.EXEC_WORKSPACES_DIR;
  process.env.EXEC_WORKSPACES_DIR = tempRoot;
});

afterEach(async () => {
  if (prevWorkspacesDir === undefined) delete process.env.EXEC_WORKSPACES_DIR;
  else process.env.EXEC_WORKSPACES_DIR = prevWorkspacesDir;
  await rm(tempRoot, { recursive: true, force: true });
});

describe('bashTool：schema 校验', () => {
  it.each([
    ['空命令', { command: '' }],
    ['超长命令（501 字符）', { command: 'x'.repeat(501) }],
    ['timeout_seconds 超上限（60）', { command: 'true', timeout_seconds: 60 }],
    ['timeout_seconds 非整数', { command: 'true', timeout_seconds: 1.5 }],
    ['缺少 command', { timeout_seconds: 5 }],
  ])('%s → ok:false + 中文校验错误', async (_label, args) => {
    const result = await bashTool.execute(args, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('参数校验失败');
  });

  it('timeout_seconds 缺省为 15（zod default 生效，可正常执行）', async () => {
    const result = await bashTool.execute({ command: 'echo ok' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('ok');
  });
});

describe('bashTool：执行与结果映射', () => {
  it('echo ok → ok:true 且输出原样带回', async () => {
    const result = await bashTool.execute({ command: 'echo ok' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('ok');
  });

  it('exit 1 → ok:false 且含 [退出码 1]，stderr 合并带回', async () => {
    const result = await bashTool.execute({ command: 'echo boom >&2; exit 1' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('[退出码 1]');
    expect(result.output).toContain('boom');
  });

  it('物化鲜度：upsertFile 后 bash cat 读到最新落库内容', async () => {
    await storage.upsertFile({ projectId, path: 'app/backend/api.js', content: 'exports.handle = () => ({ code: 200 });\n', editor: 'engineer' });
    const first = await bashTool.execute({ command: 'cat app/backend/api.js' }, ctx);
    expect(first.ok).toBe(true);
    expect(first.output).toContain('code: 200');

    // 再次落库新版本：下一次 bash 调用前重新物化，读到的是新内容而非旧快照
    await storage.upsertFile({ projectId, path: 'app/backend/api.js', content: 'exports.handle = () => ({ code: 201 });\n', editor: 'engineer' });
    const second = await bashTool.execute({ command: 'cat app/backend/api.js' }, ctx);
    expect(second.ok).toBe(true);
    expect(second.output).toContain('code: 201');
    expect(second.output).not.toContain('code: 200');
  });

  it('超时（timeout_seconds=1 跑 sleep 5）→ ok:false 含「超时」与强制终止说明', async () => {
    const result = await bashTool.execute({ command: 'sleep 5', timeout_seconds: 1 }, ctx);
    expect(result.ok).toBe(false);
    expect(result.output).toContain('超时');
    expect(result.output).toContain('强制终止');
  }, 10_000);

  it('长输出首尾截断：40000 字符 → 16000 以内 + 省略标记，首尾内容保留', async () => {
    const result = await bashTool.execute(
      { command: `node -e "process.stdout.write('x'.repeat(40000))"` },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('……[中间输出已省略]……');
    expect(result.output.length).toBeLessThanOrEqual(16000 + 100);
    expect(result.output.startsWith('xxxx')).toBe(true);
    expect(result.output.endsWith('xxxx')).toBe(true);
  }, 20_000);
});

describe('bashTool：per-run 预算（WeakMap<ToolContext>）', () => {
  it('同一 ctx 对象第 6 次调用 → 上限提示且不再执行', async () => {
    for (let i = 0; i < BASH_MAX_CALLS_PER_RUN; i += 1) {
      const result = await bashTool.execute({ command: 'true' }, ctx);
      expect(result.ok).toBe(true);
    }
    const sixth = await bashTool.execute({ command: 'echo should-not-run' }, ctx);
    expect(sixth.ok).toBe(false);
    expect(sixth.output).toContain('上限');
    expect(sixth.output).not.toContain('should-not-run');
  });

  it('新 ctx 对象 → 预算重置（重试轮 = 新 runAgent 传新 ctx 字面量）', async () => {
    for (let i = 0; i < BASH_MAX_CALLS_PER_RUN; i += 1) {
      await bashTool.execute({ command: 'true' }, ctx);
    }
    const freshCtx: ToolContext = { storage, projectId, role: 'engineer' };
    const result = await bashTool.execute({ command: 'echo fresh' }, freshCtx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('fresh');
  });
});

describe('bashTool：EXEC_PROVIDER=disabled', () => {
  it('返回禁用提示（含引导语），不物化不执行命令', async () => {
    const prev = process.env.EXEC_PROVIDER;
    process.env.EXEC_PROVIDER = 'disabled';
    try {
      const result = await bashTool.execute({ command: 'echo should-not-run' }, ctx);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('禁用');
      expect(result.output).not.toContain('should-not-run');
    } finally {
      if (prev === undefined) delete process.env.EXEC_PROVIDER;
      else process.env.EXEC_PROVIDER = prev;
    }
  });
});
