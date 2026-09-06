// @vitest-environment node
/**
 * 受控执行层 local Provider 单测（Task 1）：
 * 正常执行/退出码、硬超时强杀、外部 abort、输出上限保尾、stderr 分流、
 * env 白名单（密钥不透传）、防手滑 denylist、UTF-8 跨 chunk 多字节安全。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalExecutionProvider } from '@/lib/exec/local';
import type { ExecChunk } from '@/lib/exec/types';

const provider = createLocalExecutionProvider();
let cwd: string;

beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'atoms-exec-local-'));
});
afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('LocalExecutionProvider', () => {
  it('正常执行：echo 输出与退出码', async () => {
    const result = await provider.run({ command: 'echo hi', cwd, timeoutMs: 10_000 });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.reason).toBe('exit');
    expect(result.output).toContain('hi');
  });

  it('非零退出码：ok=false 且带回退出码', async () => {
    const result = await provider.run({ command: 'exit 3', cwd, timeoutMs: 10_000 });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.reason).toBe('exit');
  });

  it('硬超时：到点杀进程组，reason=timeout', async () => {
    const result = await provider.run({ command: 'sleep 5', cwd, timeoutMs: 150 });
    expect(result.reason).toBe('timeout');
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it('外部 abort：reason=killed（停止按钮/断连同路径）', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const result = await provider.run({ command: 'sleep 5', cwd, timeoutMs: 10_000, signal: controller.signal });
    expect(result.reason).toBe('killed');
    expect(result.durationMs).toBeLessThan(3_000);
  });

  it('预中止信号：不启动进程直接 killed', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await provider.run({ command: 'echo hi', cwd, timeoutMs: 10_000, signal: controller.signal });
    expect(result.reason).toBe('killed');
    expect(result.output).toContain('尚未启动');
  });

  it('输出上限：超限保尾丢头并前置截断标记', async () => {
    const result = await provider.run({
      command: `node -e "process.stdout.write('x'.repeat(400000))"`,
      cwd,
      timeoutMs: 20_000,
    });
    expect(result.output.startsWith('……[输出超上限')).toBe(true);
    expect(result.output.length).toBeGreaterThanOrEqual(262_144);
    expect(result.output.length).toBeLessThanOrEqual(262_144 + 200);
  });

  it('stderr 分流：onChunk 收到 stream=stderr，合并进输出', async () => {
    const chunks: ExecChunk[] = [];
    const result = await provider.run({
      command: `node -e "process.stderr.write('boom')"`,
      cwd,
      timeoutMs: 10_000,
      onChunk: (chunk) => chunks.push(chunk),
    });
    expect(chunks.some((chunk) => chunk.stream === 'stderr' && chunk.data.includes('boom'))).toBe(true);
    expect(result.output).toContain('boom');
  });

  it('env 白名单：密钥不透传，PATH 透传', async () => {
    process.env.ATOMS_TEST_SECRET = 'super-secret-value';
    try {
      const result = await provider.run({ command: 'env', cwd, timeoutMs: 10_000 });
      expect(result.output).not.toContain('super-secret-value');
      expect(result.output).not.toContain('ATOMS_TEST_SECRET');
      expect(result.output).toContain('PATH=');
    } finally {
      delete process.env.ATOMS_TEST_SECRET;
    }
  });

  it('防手滑 denylist：rm -rf / 与关机命令被拦截且不 spawn', async () => {
    const rmResult = await provider.run({ command: 'rm -rf /', cwd, timeoutMs: 10_000 });
    expect(rmResult.reason).toBe('blocked');
    expect(rmResult.output).toContain('防误操作拦截');

    const shutdownResult = await provider.run({ command: 'echo hello; shutdown now', cwd, timeoutMs: 10_000 });
    expect(shutdownResult.reason).toBe('blocked');
    expect(shutdownResult.output).toContain('关机');
  });

  it('UTF-8 跨 chunk 多字节安全：无替换字符', async () => {
    const result = await provider.run({
      command: `node -e "process.stdout.write('中文测试'.repeat(10000))"`,
      cwd,
      timeoutMs: 20_000,
    });
    expect(result.output).toContain('中文测试中文测试');
    expect(result.output).not.toContain('�');
  });
});
