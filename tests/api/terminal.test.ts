/**
 * 终端 exec/stop 路由测试（受控执行层消费方，Task 2）。
 *
 * vitest 直调 route handler + mock Request（不启 Next server，照抄 routes.test.ts 模式）：
 * ① 会话归属 404（他人 cookie）
 * ② 参数校验 400（空命令 / 超长命令）
 * ③ EXEC_PROVIDER=disabled → 503 {code:'EXEC_DISABLED'}
 * ④ 防手滑 denylist 同步预检 → 400 {code:'EXEC_COMMAND_BLOCKED'}
 * ⑤ echo：200 + SSE 四件套头 + 帧序列 start→stdout→exit(code:0)
 * ⑥ 运行中二次提交 → 409 {code:'TERMINAL_BUSY', runningCommand}
 * ⑦ stop → {stopped:true}，杀组后 exec 流上报 exit(killed) 且槽释放（可再 exec）
 * ⑧ 空闲 stop 幂等 → {stopped:false}
 * ⑨ 客户端断开（request.signal abort）→ 流终止（exit killed + done）且槽最终释放
 *
 * 隔离：EXEC_WORKSPACES_DIR 指向 mkdtemp 临时目录（否则物化写真仓库 data/workspaces），
 * afterEach 删目录并恢复 env；改 EXEC_PROVIDER 的用例由 afterEach unstubAllEnvs 收口。
 * 存储注入：vi.mock('@/lib/db') 返回 beforeEach 建好的内存库。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE } from '@/lib/session';
import { newTestStorage } from '@/lib/db/test-util';
import { activeTerminalRun } from '@/lib/exec/slots';
import type { StorageProvider } from '@/lib/db/provider/types';

const holder = vi.hoisted(() => ({ storage: null as StorageProvider | null }));
vi.mock('@/lib/db', () => ({
  createStorage: (): StorageProvider => {
    if (holder.storage === null) throw new Error('测试存储未初始化（beforeEach 未跑）');
    return holder.storage;
  },
}));

import { POST as TERMINAL_EXEC_POST } from '@/app/api/projects/[id]/terminal/exec/route';
import { POST as TERMINAL_STOP_POST } from '@/app/api/projects/[id]/terminal/stop/route';

/* ------------------------------------------------------------------ */
/* 常量与工具                                                           */
/* ------------------------------------------------------------------ */

const SESSION_A = '00000000-0000-4000-8000-00000000000a';
const SESSION_B = '00000000-0000-4000-8000-00000000000b';

/** 原始 env（afterEach 恢复；测试机上通常未设置） */
const originalWorkspacesDir = process.env.EXEC_WORKSPACES_DIR;
let workspaceRoot = '';

let projectSeq = 0;
/** 本文件出现过的全部 projectId：内存库每测重建导致 id 复用，槽残留串扰必须全量收口 */
const seenProjectIds = new Set<number>();

function storage(): StorageProvider {
  if (holder.storage === null) throw new Error('测试存储未初始化');
  return holder.storage;
}

/** 直建项目（绕过 POST 路由，聚焦被测路由本身） */
async function seedProject(overrides: Partial<{ sessionId: string }> = {}): Promise<number> {
  projectSeq += 1;
  const project = await storage().createProject({
    sessionId: overrides.sessionId ?? SESSION_A,
    title: `终端测试项目${projectSeq}`,
    requirement: '做一个待办清单应用',
    mode: 'fast',
  });
  seenProjectIds.add(project.id);
  return project.id;
}

function makeRequest(url: string, init: RequestInit = {}, session?: string): Request {
  const headers = new Headers(init.headers);
  if (session !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${session}`);
  return new Request(url, { ...init, headers });
}

function postCommand(id: number, command: string, init: RequestInit = {}, session = SESSION_A): Request {
  return makeRequest(
    `http://localhost/api/projects/${id}/terminal/exec`,
    { method: 'POST', body: JSON.stringify({ command }), headers: { 'content-type': 'application/json' }, ...init },
    session,
  );
}

function postStop(id: number, session = SESSION_A): Request {
  return makeRequest(`http://localhost/api/projects/${id}/terminal/stop`, { method: 'POST' }, session);
}

const idCtx = (id: number | string): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id: String(id) }) });

/** 轮询等待条件成立（杀组/收口是异步的） */
async function waitUntil(check: () => boolean, timeoutMs = 10_000, stepMs = 15): Promise<void> {
  const startAt = Date.now();
  while (!check()) {
    if (Date.now() - startAt > timeoutMs) throw new Error('waitUntil 超时');
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/* ------------------------------------------------------------------ */
/* SSE 帧                                                              */
/* ------------------------------------------------------------------ */

interface SseFrame { id: string; event: string; data: string }

function parseFrame(raw: string): SseFrame {
  const frame: SseFrame = { id: '', event: '', data: '' };
  for (const line of raw.split('\n')) {
    if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('data: ')) frame.data = line.slice(6);
  }
  return frame;
}

/** 读流直至收到 exit 帧（单命令单流，exit 即终点）；超时兜底防挂死 */
async function readUntilExit(response: Response, timeoutMs = 30_000): Promise<SseFrame[]> {
  const body = response.body;
  if (body === null) throw new Error('SSE 响应缺少 body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  const guard = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (!frames.some((frame) => frame.event === 'exit')) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        if (part.trim() !== '') frames.push(parseFrame(part));
      }
    }
  } finally {
    clearTimeout(guard);
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

const dataOf = (frame: SseFrame): Record<string, unknown> => JSON.parse(frame.data) as Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* 生命周期                                                             */
/* ------------------------------------------------------------------ */

beforeEach(async () => {
  holder.storage = newTestStorage();
  // 物化目录隔离：不写真仓库 data/workspaces
  workspaceRoot = await mkdtemp(path.join(tmpdir(), 'atoms-terminal-test-'));
  process.env.EXEC_WORKSPACES_DIR = workspaceRoot;
});

afterEach(async () => {
  // 收口可能残留的终端槽（断言提前失败时命令还在跑）：先发杀信号再等释放
  for (const id of seenProjectIds) activeTerminalRun(id)?.stop();
  for (const id of seenProjectIds) {
    if (activeTerminalRun(id) !== null) {
      await waitUntil(() => activeTerminalRun(id) === null, 10_000).catch(() => undefined);
    }
  }
  seenProjectIds.clear();
  vi.unstubAllEnvs();
  if (originalWorkspacesDir === undefined) delete process.env.EXEC_WORKSPACES_DIR;
  else process.env.EXEC_WORKSPACES_DIR = originalWorkspacesDir;
  if (workspaceRoot !== '') await rm(workspaceRoot, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* ①② 会话归属 + 参数校验                                               */
/* ------------------------------------------------------------------ */

describe('POST terminal/exec：归属与校验', () => {
  it('① 他人 session → 404（exec 与 stop 同口径）', async () => {
    const id = await seedProject({ sessionId: SESSION_A });
    expect((await TERMINAL_EXEC_POST(postCommand(id, 'echo hi', {}, SESSION_B), idCtx(id))).status).toBe(404);
    expect((await TERMINAL_STOP_POST(postStop(id, SESSION_B), idCtx(id))).status).toBe(404);
  });

  it('② 空命令 / 超 500 字符 → 400 参数校验失败', async () => {
    const id = await seedProject();
    const empty = await TERMINAL_EXEC_POST(postCommand(id, ''), idCtx(id));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain('参数校验失败');

    const tooLong = await TERMINAL_EXEC_POST(postCommand(id, 'a'.repeat(501)), idCtx(id));
    expect(tooLong.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* ③④ 能力开关 + 防手滑预检                                             */
/* ------------------------------------------------------------------ */

describe('POST terminal/exec：provider 与命令守卫', () => {
  it('③ EXEC_PROVIDER=disabled → 503 {code:"EXEC_DISABLED"}', async () => {
    vi.stubEnv('EXEC_PROVIDER', 'disabled');
    try {
      const id = await seedProject();
      const response = await TERMINAL_EXEC_POST(postCommand(id, 'echo hi'), idCtx(id));
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe('EXEC_DISABLED');
      // 未占槽（后续命令同因 disabled 被拒，而非 409）
      expect(activeTerminalRun(id)).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('④ rm -rf / → 400 {code:"EXEC_COMMAND_BLOCKED"}（同步预检，不占槽）', async () => {
    const id = await seedProject();
    const response = await TERMINAL_EXEC_POST(postCommand(id, 'rm -rf /'), idCtx(id));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('EXEC_COMMAND_BLOCKED');
    expect(body.error).toContain('拦截');
    expect(activeTerminalRun(id)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* ⑤ 正常执行流                                                         */
/* ------------------------------------------------------------------ */

describe('POST terminal/exec：SSE 流式执行', () => {
  it('⑤ echo hello：200 + 四件套头 + start→stdout→exit(code:0) 帧序列', async () => {
    const id = await seedProject();

    const response = await TERMINAL_EXEC_POST(postCommand(id, 'echo hello'), idCtx(id));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    expect(response.headers.get('cache-control')).toContain('no-transform');
    expect(response.headers.get('connection')).toBe('keep-alive');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const frames = await readUntilExit(response);
    const events = frames.map((frame) => frame.event);
    expect(events[0]).toBe('start');
    expect(events.at(-1)).toBe('exit');
    expect(events.slice(1, -1).every((event) => event === 'stdout' || event === 'stderr')).toBe(true);

    // start 帧带命令；stdout 帧拼回完整输出；exit 帧带退出码与原因
    expect(dataOf(frames[0]!)).toEqual({ command: 'echo hello' });
    const output = frames.filter((frame) => frame.event === 'stdout').map((frame) => dataOf(frame).data).join('');
    expect(output).toContain('hello');
    expect(dataOf(frames.at(-1)!)).toMatchObject({ code: 0, reason: 'exit' });

    // 帧格式：id 递增且非空
    frames.forEach((frame, index) => expect(Number(frame.id)).toBe(index + 1));

    // 流收口后槽释放
    expect(activeTerminalRun(id)).toBeNull();
  });

  it('⑤b stderr 分流：exit 帧带非零退出码', async () => {
    const id = await seedProject();
    const response = await TERMINAL_EXEC_POST(postCommand(id, 'echo oops >&2; exit 7'), idCtx(id));
    expect(response.status).toBe(200);
    const frames = await readUntilExit(response);
    const events = frames.map((frame) => frame.event);
    expect(events).toContain('stderr');
    expect(dataOf(frames.at(-1)!)).toMatchObject({ code: 7, reason: 'exit' });
  });
});

/* ------------------------------------------------------------------ */
/* ⑥⑦⑧⑨ 单槽互斥 + 停止                                                */
/* ------------------------------------------------------------------ */

describe('终端单槽与停止', () => {
  it('⑥ sleep 30 运行中二次提交 → 409 TERMINAL_BUSY + runningCommand', async () => {
    const id = await seedProject();
    const controller = new AbortController();
    const first = await TERMINAL_EXEC_POST(postCommand(id, 'sleep 30', { signal: controller.signal }), idCtx(id));
    expect(first.status).toBe(200);

    const second = await TERMINAL_EXEC_POST(postCommand(id, 'echo hi'), idCtx(id));
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string; runningCommand: string; error: string };
    expect(body.code).toBe('TERMINAL_BUSY');
    expect(body.runningCommand).toBe('sleep 30');
    expect(body.error).toContain('终端正忙');

    // 收口：断开第一条（客户端 abort 杀进程组）并等槽释放
    controller.abort();
    await waitUntil(() => activeTerminalRun(id) === null);
  });

  it('⑦ stop → {stopped:true}；exit(killed) 由 exec 流上报；槽释放后可再 exec', async () => {
    const id = await seedProject();
    const first = await TERMINAL_EXEC_POST(postCommand(id, 'sleep 30'), idCtx(id));
    expect(first.status).toBe(200);
    expect(activeTerminalRun(id)?.command).toBe('sleep 30');

    const stopResponse = await TERMINAL_STOP_POST(postStop(id), idCtx(id));
    expect(stopResponse.status).toBe(200);
    expect(await stopResponse.json()).toEqual({ ok: true, stopped: true });

    // 杀组后 exec 流侧收口：上报 exit(killed) 帧并释放槽
    const frames = await readUntilExit(first);
    expect(dataOf(frames.at(-1)!)).toMatchObject({ code: null, reason: 'killed' });
    expect(activeTerminalRun(id)).toBeNull();

    // 槽确实可用：再 exec 成功跑完
    const again = await TERMINAL_EXEC_POST(postCommand(id, 'echo again'), idCtx(id));
    expect(again.status).toBe(200);
    const againFrames = await readUntilExit(again);
    expect(dataOf(againFrames.at(-1)!)).toMatchObject({ code: 0, reason: 'exit' });
  });

  it('⑧ 空闲 stop 幂等 → {stopped:false}', async () => {
    const id = await seedProject();
    const response = await TERMINAL_STOP_POST(postStop(id), idCtx(id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, stopped: false });
  });

  it('⑨ 客户端断开（request.signal abort）→ 流终止（exit killed + done）且槽最终释放', async () => {
    const id = await seedProject();
    const controller = new AbortController();
    const response = await TERMINAL_EXEC_POST(postCommand(id, 'sleep 30', { signal: controller.signal }), idCtx(id));
    expect(response.status).toBe(200);

    controller.abort();
    await waitUntil(() => activeTerminalRun(id) === null);

    // 流终止：exit(killed) 帧之后 read 返回 done
    const body = response.body;
    if (body === null) throw new Error('SSE 响应缺少 body');
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const frames: SseFrame[] = [];
    let buffer = '';
    const guard = setTimeout(() => void reader.cancel(), 10_000);
    try {
      while (!frames.some((frame) => frame.event === 'exit')) {
        const { done, value } = await reader.read();
        if (done) throw new Error('流提前关闭：未见 exit 帧');
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          if (part.trim() !== '') frames.push(parseFrame(part));
        }
      }
      const tail = await reader.read();
      expect(tail.done).toBe(true);
    } finally {
      clearTimeout(guard);
      await reader.cancel().catch(() => undefined);
    }
    expect(dataOf(frames.at(-1)!)).toMatchObject({ code: null, reason: 'killed' });

    // 槽释放的端到端验证：新命令可直接执行
    const after = await TERMINAL_EXEC_POST(postCommand(id, 'echo ok'), idCtx(id));
    expect(after.status).toBe(200);
    expect(dataOf((await readUntilExit(after)).at(-1)!)).toMatchObject({ code: 0, reason: 'exit' });
  });
});
