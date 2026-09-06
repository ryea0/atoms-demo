/**
 * API 路由测试（Task 16，brief Step 1）。
 *
 * vitest 直调 route handler + mock Request（不启 Next server）：
 * ① POST 建项目 201 + 新会话 Set-Cookie + stream 订阅收到事件直到 done
 * ② Last-Event-ID 重放（订阅前先发几条，afterSeq 只补缺失）
 * ③ PATCH files/[fid] CAS 冲突 409 {conflict,current}（含成功/404/512KB 上限）
 * ④ preview 含 __ATOMS_BACKEND__ 与拦截器 + CSP 头（无 api.js 占位 / 缺 index 404）
 * ⑤ export zip（application/zip + PK 魔数 + Content-Disposition）
 * ⑥ stop 后 status=paused
 * ⑦ session 归属 404（他人 cookie 一律 404）
 * ⑧ regenerate 重跑单文件（mock 下 version 递增 + file 事件补发）
 * ⑨ checkpoint restore 内容回滚 + message 事件 + agent_runs 标 rolled_back
 * 补充：列表/最近会话 clamp、400 参数校验、干预入队 vs 新一轮、快照现场恢复、
 * DELETE 释放总线、心跳 `: ping`、abort 清理、重命名。
 *
 * 存储注入：vi.mock('@/lib/db') 返回 beforeEach 建好的内存库；
 * 事件总线是模块级单例，测试间按 projectId 显式 release（否则桶残留串扰）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectEventBus } from '@/lib/agents/events';
import { orchestratorStatus, startGeneration } from '@/lib/agents/orchestrator';
import { SESSION_COOKIE } from '@/lib/session';
import { PREVIEW_CSP } from '@/lib/preview/assemble';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';

const holder = vi.hoisted(() => ({ storage: null as StorageProvider | null }));
vi.mock('@/lib/db', () => ({
  createStorage: (): StorageProvider => {
    if (holder.storage === null) throw new Error('测试存储未初始化（beforeEach 未跑）');
    return holder.storage;
  },
}));

import { GET as LIST_GET, POST as PROJECTS_POST } from '@/app/api/projects/route';
import { DELETE as PROJECT_DELETE, GET as PROJECT_GET, PATCH as PROJECT_PATCH } from '@/app/api/projects/[id]/route';
import { GET as STREAM_GET } from '@/app/api/projects/[id]/stream/route';
import { POST as STOP_POST } from '@/app/api/projects/[id]/stop/route';
import { POST as MESSAGES_POST } from '@/app/api/projects/[id]/messages/route';
import { GET as PREVIEW_GET } from '@/app/api/projects/[id]/preview/route';
import { GET as EXPORT_GET } from '@/app/api/projects/[id]/export/route';
import { PATCH as FILE_PATCH } from '@/app/api/projects/[id]/files/[fid]/route';
import { POST as REGEN_POST } from '@/app/api/projects/[id]/files/[fid]/regenerate/route';
import { POST as RESTORE_POST } from '@/app/api/projects/[id]/checkpoints/[cpId]/restore/route';
import { GET as OPEN_GET } from '@/app/api/projects/[id]/open/route';

/* ------------------------------------------------------------------ */
/* 常量与工具                                                           */
/* ------------------------------------------------------------------ */

const SESSION_A = '00000000-0000-4000-8000-00000000000a';
const SESSION_B = '00000000-0000-4000-8000-00000000000b';
const REQUIREMENT = '做一个待办清单应用';

/** 每个测试用到的 projectId（afterEach 统一 release 总线桶） */
const liveProjectIds = new Set<number>();
/** 本文件出现过的全部 projectId：内存库每测重建导致 id 复用，防串桶必须全量收口 */
const seenProjectIds = new Set<number>();
let projectSeq = 0;

function storage(): StorageProvider {
  if (holder.storage === null) throw new Error('测试存储未初始化');
  return holder.storage;
}

/** 直建项目（绕过 POST 路由，聚焦被测路由本身） */
async function seedProject(
  overrides: Partial<{ sessionId: string; requirement: string; mode: 'fast' | 'full' }> = {},
): Promise<{ id: number; storage: StorageProvider }> {
  projectSeq += 1;
  const project = await storage().createProject({
    sessionId: overrides.sessionId ?? SESSION_A,
    title: `测试项目${projectSeq}`,
    requirement: overrides.requirement ?? REQUIREMENT,
    mode: overrides.mode ?? 'fast',
  });
  liveProjectIds.add(project.id);
  seenProjectIds.add(project.id);
  return { id: project.id, storage: storage() };
}

function makeRequest(url: string, init: RequestInit = {}, session?: string): Request {
  const headers = new Headers(init.headers);
  if (session !== undefined) headers.set('cookie', `${SESSION_COOKIE}=${session}`);
  return new Request(url, { ...init, headers });
}

function postJson(url: string, body: unknown, session?: string): Request {
  return makeRequest(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, session);
}

function patchJson(url: string, body: unknown, session?: string): Request {
  return makeRequest(url, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }, session);
}

const idCtx = (id: number | string): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id: String(id) }) });
const fileCtx = (id: number | string, fid: number | string): { params: Promise<{ id: string; fid: string }> } => ({
  params: Promise.resolve({ id: String(id), fid: String(fid) }),
});
const checkpointCtx = (id: number | string, cpId: number | string): { params: Promise<{ id: string; cpId: string }> } => ({
  params: Promise.resolve({ id: String(id), cpId: String(cpId) }),
});

/** 轮询等待条件成立（mock 后台轮次收口用） */
async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 20000, stepMs = 15): Promise<void> {
  const startAt = Date.now();
  while (!(await check())) {
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

/** 读流直至条件满足（默认收到 done/stopped/error）；超时兜底防挂死 */
async function readFrames(
  response: Response,
  until: (frames: SseFrame[]) => boolean = (frames) => frames.some((f) => ['done', 'stopped', 'error'].includes(f.event)),
  timeoutMs = 30000,
): Promise<SseFrame[]> {
  const body = response.body;
  if (body === null) throw new Error('SSE 响应缺少 body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  const guard = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (!until(frames)) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        // 注释帧（: connect / : ping）不是事件，跳过——只收 id/event/data 帧
        if (part.trim() !== '' && !part.startsWith(':')) frames.push(parseFrame(part));
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

beforeEach(() => {
  holder.storage = newTestStorage();
  vi.stubEnv('LLM_PROVIDER', 'mock');
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
});

afterEach(async () => {
  // 先等 fire-and-forget 轮次收口再释放桶：断言提前失败时后台轮还在跑，
  // 直接 release 会让它的事件漏进下一个用例的同号桶（内存库 id 会复用）
  for (const id of seenProjectIds) {
    if (orchestratorStatus(id) !== 'idle') {
      await waitUntil(() => orchestratorStatus(id) === 'idle', 15000).catch(() => undefined);
    }
    projectEventBus.release(id);
  }
  liveProjectIds.clear();
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* ① POST /api/projects + stream                                       */
/* ------------------------------------------------------------------ */

describe('POST /api/projects + GET stream', () => {
  it('① 建项目 201 + Set-Cookie；stream 全链路收到合法 SSE 帧直到 done', async () => {
    const response = await PROJECTS_POST(
      postJson('http://localhost/api/projects', { requirement: REQUIREMENT, mode: 'fast' }),
    );
    expect(response.status).toBe(201);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const created = (await response.json()) as { project: { id: number } };
    expect(created.project.id).toBeGreaterThan(0);
    liveProjectIds.add(created.project.id);
    seenProjectIds.add(created.project.id);
    const session = (setCookie.split(';')[0] ?? '').slice(SESSION_COOKIE.length + 1); // 只要 uuid 值

    // 无 cookie 的 GET 列表也发新会话
    const listResponse = await LIST_GET(makeRequest('http://localhost/api/projects'));
    expect(listResponse.status).toBe(200);
    expect(listResponse.headers.get('set-cookie')).toContain(SESSION_COOKIE);

    // SSE：Last-Event-ID: 0 → 全量重放 + 实时推送（消除订阅前的竞态）
    const streamResponse = await STREAM_GET(
      makeRequest(`http://localhost/api/projects/${created.project.id}/stream`, {}, session),
      idCtx(created.project.id),
    );
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get('content-type')).toContain('text/event-stream');
    expect(streamResponse.headers.get('cache-control')).toContain('no-cache');
    expect(streamResponse.headers.get('cache-control')).toContain('no-transform');
    expect(streamResponse.headers.get('connection')).toBe('keep-alive');
    expect(streamResponse.headers.get('x-accel-buffering')).toBe('no');

    const frames = await readFrames(streamResponse);
    expect(frames.length).toBeGreaterThan(0);
    let previousSeq = 0;
    for (const frame of frames) {
      // 帧格式严格：id/event/data 三行齐全，id 与 data.seq 一致
      expect(frame.id).not.toBe('');
      expect(frame.event).not.toBe('');
      const data = dataOf(frame);
      expect(data.seq).toBe(Number(frame.id));
      expect(data.projectId).toBe(created.project.id);
      expect(data.event).toBe(frame.event);
      expect(Number(data.seq)).toBeGreaterThan(previousSeq);
      previousSeq = Number(data.seq);
    }
    const events = frames.map((frame) => frame.event);
    expect(events).toContain('agent_start');
    expect(events).toContain('file_start');
    expect(events).toContain('delta');
    expect(events).toContain('file_end');
    expect(frames.at(-1)?.event).toBe('done');

    // mock 全链路确实落了文件（engineer 交付物）
    await waitUntil(async () => (await storage().listFiles(created.project.id)).length > 0);
    expect((await storage().getProject(created.project.id))?.status).toBe('done');
  }, 30000);

  it('参数校验失败返回 400（空需求 / 非法 mode）', async () => {
    const empty = await PROJECTS_POST(postJson('http://localhost/api/projects', { requirement: '  ', mode: 'fast' }));
    expect(empty.status).toBe(400);
    expect(((await empty.json()) as { error: string }).error).toContain('参数校验失败');

    const badMode = await PROJECTS_POST(postJson('http://localhost/api/projects', { requirement: 'x', mode: 'turbo' }));
    expect(badMode.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* ② Last-Event-ID 重放                                                */
/* ------------------------------------------------------------------ */

describe('GET stream：Last-Event-ID 重放', () => {
  it('② 订阅前已发 3 条 → Last-Event-ID:1 只补 seq 2、3；之后再实时', async () => {
    const { id } = await seedProject();
    projectEventBus.emit(id, { runId: null, event: 'message', content: '一' });
    projectEventBus.emit(id, { runId: null, event: 'message', content: '二' });
    projectEventBus.emit(id, { runId: null, event: 'message', content: '三' });

    const response = await STREAM_GET(
      makeRequest(`http://localhost/api/projects/${id}/stream`, { headers: { 'Last-Event-ID': '1' } }, SESSION_A),
      idCtx(id),
    );
    const frames = await readFrames(response, (list) => list.length >= 2);
    expect(frames.map((frame) => frame.id)).toEqual(['2', '3']);
    expect(frames[0]?.event).toBe('message');
    expect(dataOf(frames[0]!).content).toBe('二');
  });

  it('②b 首连无自定义头：?lastEventId= query 重放缺失事件；非法值按全新订阅（不重放）；头优先于 query', async () => {
    const { id } = await seedProject();
    projectEventBus.emit(id, { runId: null, event: 'message', content: '一' });
    projectEventBus.emit(id, { runId: null, event: 'message', content: '二' });
    projectEventBus.emit(id, { runId: null, event: 'message', content: '三' });

    // query 参数入口（原生 EventSource 首连带不了头，客户端把快照 lastSeq 放这里）：只补 seq 2、3
    const viaQuery = await STREAM_GET(
      makeRequest(`http://localhost/api/projects/${id}/stream?lastEventId=1`, {}, SESSION_A),
      idCtx(id),
    );
    const frames = await readFrames(viaQuery, (list) => list.length >= 2);
    expect(frames.map((frame) => frame.id)).toEqual(['2', '3']);

    // 非法 query：按全新订阅（与非法头同语义：不重放、只等实时），不 500 不拒连
    const invalid = await STREAM_GET(
      makeRequest(`http://localhost/api/projects/${id}/stream?lastEventId=abc`, {}, SESSION_A),
      idCtx(id),
    );
    expect(invalid.status).toBe(200);
    const invalidBody = invalid.body;
    if (invalidBody === null) throw new Error('SSE 响应缺少 body');
    const invalidReader = invalidBody.getReader();
    // 首帧是 start() 的 `: connect` 注释帧（刷响应头用，2026-09-06 /p/7 事故修复契约）
    const connectChunk = await invalidReader.read();
    expect(connectChunk.done).toBe(false);
    expect(new TextDecoder().decode(connectChunk.value)).toBe(': connect\n\n');
    // 注释帧之后、心跳之前：全新订阅不重放缓冲里的 1、2、3（只等实时）
    const secondChunk = await Promise.race([
      invalidReader.read(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 300)),
    ]);
    expect(secondChunk).toBe('timeout');
    await invalidReader.cancel().catch(() => undefined);

    // 头优先于 query：断线重连时浏览器原生 Last-Event-ID 必须压过 URL 里的旧值
    const headerWins = await STREAM_GET(
      makeRequest(`http://localhost/api/projects/${id}/stream?lastEventId=1`, { headers: { 'Last-Event-ID': '2' } }, SESSION_A),
      idCtx(id),
    );
    const tail = await readFrames(headerWins, (list) => list.length >= 1);
    expect(tail.map((frame) => frame.id)).toEqual(['3']);
  }, 10000);

  it('②c 空重放连接（lastEventId=最新 seq）首字节立即到达，不等心跳/事件（/p/7 事故回归）', async () => {
    const { id } = await seedProject();
    // 模拟首连常态：快照 lastSeq 恰好是总线最新 seq——重放为空
    projectEventBus.emit(id, { runId: null, event: 'message', content: '一' });
    const latest = projectEventBus.snapshotBuffer(id, 0).at(-1);
    if (latest === undefined) throw new Error('前置事件未入缓冲');

    const response = await STREAM_GET(
      makeRequest(`http://localhost/api/projects/${id}/stream?lastEventId=${latest.seq}`, {}, SESSION_A),
      idCtx(id),
    );
    expect(response.status).toBe(200);
    const body = response.body;
    if (body === null) throw new Error('SSE 响应缺少 body');
    const reader = body.getReader();
    // 修复前：无重放即无字节，连接无头挂起（真机要干等 20s 心跳，长跑 dev 进程里永不送达，
    // 页面冻结在挂载时快照——用户「输入任务后很久没响应」的根因）。修复后：连接帧同步可读。
    const first = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 500)),
    ]);
    expect(first).not.toBe('timeout');
    expect(new TextDecoder().decode((first as { value: Uint8Array }).value)).toBe(': connect\n\n');
    await reader.cancel().catch(() => undefined);
  }, 10000);

  it('心跳 20s 发 `: ping` 注释帧；客户端 abort 后流关闭', async () => {
    vi.useFakeTimers();
    try {
      const { id } = await seedProject();
      const controller = new AbortController();
      const response = await STREAM_GET(
        makeRequest(`http://localhost/api/projects/${id}/stream`, { signal: controller.signal }, SESSION_A),
        idCtx(id),
      );
      const body = response.body;
      if (body === null) throw new Error('SSE 响应缺少 body');
      const reader = body.getReader();

      // 连接帧不等心跳、立即可读（/p/7 事故修复：空重放连接也必须立刻有首字节刷响应头）
      const connect = await reader.read();
      expect(connect.done).toBe(false);
      expect(new TextDecoder().decode(connect.value)).toBe(': connect\n\n');

      await vi.advanceTimersByTimeAsync(20_000);
      const ping = await reader.read();
      expect(ping.done).toBe(false);
      expect(new TextDecoder().decode(ping.value)).toBe(': ping\n\n');

      controller.abort();
      const closed = await reader.read();
      expect(closed.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ------------------------------------------------------------------ */
/* ③ PATCH files/[fid]（人机共编 CAS）                                  */
/* ------------------------------------------------------------------ */

describe('PATCH /api/projects/[id]/files/[fid]', () => {
  it('③ 成功 200 {version}；过期 baseVersion → 409 {conflict,current,version}；文件不存在 404；超 512KB 400', async () => {
    const { id } = await seedProject();
    const { fileId } = await storage().upsertFile({ projectId: id, path: 'app/a.js', content: 'v1', editor: 'seed' });

    const ok = await FILE_PATCH(
      patchJson(`http://localhost/api/projects/${id}/files/${fileId}`, { content: 'v2 内容', baseVersion: 1 }, SESSION_A),
      fileCtx(id, fileId),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { version: number }).version).toBe(2);

    const conflict = await FILE_PATCH(
      patchJson(`http://localhost/api/projects/${id}/files/${fileId}`, { content: 'stale', baseVersion: 1 }, SESSION_A),
      fileCtx(id, fileId),
    );
    expect(conflict.status).toBe(409);
    // 409 体回带服务端当前版本号（T25）：SSE 断连期间「用我的版本」也能一次重发成功
    expect(await conflict.json()).toEqual({ conflict: true, current: 'v2 内容', version: 2 });

    const missing = await FILE_PATCH(
      patchJson(`http://localhost/api/projects/${id}/files/9999`, { content: 'x', baseVersion: 1 }, SESSION_A),
      fileCtx(id, 9999),
    );
    expect(missing.status).toBe(404);

    const tooBig = await FILE_PATCH(
      patchJson(`http://localhost/api/projects/${id}/files/${fileId}`, { content: 'a'.repeat(512 * 1024 + 1), baseVersion: 2 }, SESSION_A),
      fileCtx(id, fileId),
    );
    expect(tooBig.status).toBe(400);
    expect(((await tooBig.json()) as { error: string }).error).toContain('512KB');
  });
});

/* ------------------------------------------------------------------ */
/* ④ preview                                                           */
/* ------------------------------------------------------------------ */

describe('GET /api/projects/[id]/preview', () => {
  const indexHtml = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>app</title></head><body><div id="root"></div></body></html>';
  const apiJs = "const todos = []; module.exports = { handle(method, path, body) { return { code: 200, data: todos }; } };";

  it('④ 注入 __ATOMS_BACKEND__ + fetch 拦截器；CSP 头逐段一致', async () => {
    const { id } = await seedProject();
    await storage().upsertFile({ projectId: id, path: 'app/frontend/index.html', content: indexHtml, editor: 'engineer' });
    await storage().upsertFile({ projectId: id, path: 'app/backend/api.js', content: apiJs, editor: 'engineer' });

    const response = await PREVIEW_GET(makeRequest(`http://localhost/api/projects/${id}/preview`, {}, SESSION_A), idCtx(id));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toBe(PREVIEW_CSP);
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain('https://cdn.tailwindcss.com');
    expect(PREVIEW_CSP).toContain("connect-src 'none'");

    const html = await response.text();
    // 注入位置：<head> 之后、正文之前
    expect(html.indexOf('__ATOMS_BACKEND__')).toBeGreaterThan(html.indexOf('<head>'));
    expect(html.indexOf('__ATOMS_BACKEND__')).toBeLessThan(html.indexOf('<body>'));
    expect(html).toContain('module={exports:{}}');
    expect(html).toContain('return module.exports');
    expect(html).toContain(apiJs); // 后端源码整体内联
    expect(html).toContain('window.fetch'); // 拦截器在位
  });

  it('无 api.js：只注入拦截器占位（/api/ 返回后端未生成）', async () => {
    const onlyIndex = await seedProject();
    await storage().upsertFile({ projectId: onlyIndex.id, path: 'app/frontend/index.html', content: indexHtml, editor: 'engineer' });
    const placeholder = await PREVIEW_GET(makeRequest(`http://localhost/api/projects/${onlyIndex.id}/preview`, {}, SESSION_A), idCtx(onlyIndex.id));
    expect(placeholder.status).toBe(200);
    const html = await placeholder.text();
    expect(html).toContain('window.fetch');
    expect(html).not.toContain(apiJs);

    const { id } = await seedProject();
    const missing = await PREVIEW_GET(makeRequest(`http://localhost/api/projects/${id}/preview`, {}, SESSION_A), idCtx(id));
    expect(missing.status).toBe(404);
    // 缺入口页与归属不符的错误分支见下一用例（中文 HTML 提示页）
  });

  it('失败分支回中文 HTML 提示页（iframe 里不再显示裸 404 JSON，T25）', async () => {
    // 缺 index.html
    const { id } = await seedProject();
    const missing = await PREVIEW_GET(makeRequest(`http://localhost/api/projects/${id}/preview`, {}, SESSION_A), idCtx(id));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('text/html');
    const html = await missing.text();
    expect(html).toContain('预览不可用');
    expect(html).toContain('index.html');

    // 未授权 / 他人 id（归属不符同样 404）
    const foreign = await PREVIEW_GET(makeRequest(`http://localhost/api/projects/${id}/preview`, {}, SESSION_B), idCtx(id));
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get('content-type')).toContain('text/html');
    expect(await foreign.text()).toContain('预览不可用');
  });
});

/* ------------------------------------------------------------------ */
/* ⑤ export                                                            */
/* ------------------------------------------------------------------ */

describe('GET /api/projects/[id]/export', () => {
  it('⑤ 输出 application/zip（PK 魔数）+ attachment', async () => {
    const { id } = await seedProject({ requirement: '导出应用' });
    await storage().upsertFile({ projectId: id, path: 'app/frontend/index.html', content: '<html></html>', editor: 'engineer' });
    await storage().upsertFile({ projectId: id, path: 'docs/prd.md', content: '# PRD', editor: 'pm' });

    const response = await EXPORT_GET(makeRequest(`http://localhost/api/projects/${id}/export`, {}, SESSION_A), idCtx(id));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toContain('attachment');

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
  });
});

/* ------------------------------------------------------------------ */
/* ⑥ stop                                                              */
/* ------------------------------------------------------------------ */

describe('POST /api/projects/[id]/stop', () => {
  it('⑥ 生成中停止 → 轮次收口 status=paused + stopped 事件', async () => {
    vi.stubEnv('LLM_MOCK_DELAY_MS', '40');
    const { id, storage: s } = await seedProject({ requirement: '做一次 SEO 分析' });
    const events: string[] = [];
    const stopCollecting = projectEventBus.subscribe(id, (event) => events.push(event.event));

    const round = startGeneration({
      storage: s,
      projectId: id,
      userMessage: '做一次 SEO 分析',
      mode: 'fast',
      mentions: ['seo'],
      signal: new AbortController().signal,
    });
    await waitUntil(() => orchestratorStatus(id) === 'running', 5000);
    expect(orchestratorStatus(id)).toBe('running');

    const response = await STOP_POST(makeRequest(`http://localhost/api/projects/${id}/stop`, { method: 'POST' }, SESSION_A), idCtx(id));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);

    await round;
    stopCollecting();
    expect((await s.getProject(id))?.status).toBe('paused');
    expect(events).toContain('stopped');
    expect(events).not.toContain('done');
  });

  it('空闲项目 stop 幂等 200（不炸不改动）', async () => {
    const { id } = await seedProject();
    const response = await STOP_POST(makeRequest(`http://localhost/api/projects/${id}/stop`, { method: 'POST' }, SESSION_A), idCtx(id));
    expect(response.status).toBe(200);
    expect((await storage().getProject(id))?.status).toBe('draft');
  });
});

/* ------------------------------------------------------------------ */
/* ⑦ 会话归属                                                          */
/* ------------------------------------------------------------------ */

describe('会话归属（rules 07：他人 id 一律 404）', () => {
  it('⑦ 他人 cookie 访问快照/文件/停止/删除 → 全部 404', async () => {
    const { id } = await seedProject({ sessionId: SESSION_A });
    const { fileId } = await storage().upsertFile({ projectId: id, path: 'app/a.js', content: 'x', editor: 'engineer' });

    expect((await PROJECT_GET(makeRequest(`http://localhost/api/projects/${id}`, {}, SESSION_B), idCtx(id))).status).toBe(404);
    expect(
      (await FILE_PATCH(patchJson(`http://localhost/api/projects/${id}/files/${fileId}`, { content: 'y', baseVersion: 1 }, SESSION_B), fileCtx(id, fileId))).status,
    ).toBe(404);
    expect((await STOP_POST(makeRequest(`http://localhost/api/projects/${id}/stop`, { method: 'POST' }, SESSION_B), idCtx(id))).status).toBe(404);
    expect((await PREVIEW_GET(makeRequest(`http://localhost/api/projects/${id}/preview`, {}, SESSION_B), idCtx(id))).status).toBe(404);
    expect((await EXPORT_GET(makeRequest(`http://localhost/api/projects/${id}/export`, {}, SESSION_B), idCtx(id))).status).toBe(404);
    expect((await PROJECT_DELETE(makeRequest(`http://localhost/api/projects/${id}`, { method: 'DELETE' }, SESSION_B), idCtx(id))).status).toBe(404);
    expect((await STREAM_GET(makeRequest(`http://localhost/api/projects/${id}/stream`, {}, SESSION_B), idCtx(id))).status).toBe(404);

    // 本人访问正常
    expect((await PROJECT_GET(makeRequest(`http://localhost/api/projects/${id}`, {}, SESSION_A), idCtx(id))).status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/* ⑧ regenerate                                                        */
/* ------------------------------------------------------------------ */

describe('POST /api/projects/[id]/files/[fid]/regenerate', () => {
  it('⑧ 重跑单文件：mock 下 version 递增 + agent/file 事件补发 + 新 agent_run', async () => {
    const { id } = await seedProject(); // 待办清单 → crud 模板树含 app/backend/api.js
    const { fileId } = await storage().upsertFile({ projectId: id, path: 'app/backend/api.js', content: '// 旧版', editor: 'engineer' });

    const seen: Array<{ event: string; path?: string; version?: unknown }> = [];
    const stopCollecting = projectEventBus.subscribe(id, (event) => {
      if (event.agent === 'engineer') seen.push({ event: event.event, path: event.path, version: (event.meta as { version?: number } | undefined)?.version });
    });

    const response = await REGEN_POST(
      makeRequest(`http://localhost/api/projects/${id}/files/${fileId}/regenerate`, { method: 'POST' }, SESSION_A),
      fileCtx(id, fileId),
    );
    stopCollecting();
    expect(response.status).toBe(200);
    const result = (await response.json()) as { path: string; version: number; ok: boolean; runId: number };
    expect(result.path).toBe('app/backend/api.js');
    expect(result.version).toBe(2); // v1 → 重跑覆写 v2
    expect(result.ok).toBe(true);

    const row = await storage().getFile(id, 'app/backend/api.js');
    expect(row?.version).toBe(2);
    expect(row?.content).not.toBe('// 旧版');

    // 事件：agent_start → file_start → (delta) → file_end(version) → agent_end
    const kinds = seen.map((item) => item.event);
    expect(kinds).toContain('agent_start');
    expect(kinds).toContain('file_start');
    expect(kinds).toContain('file_end');
    expect(kinds).toContain('agent_end');
    expect(seen.find((item) => item.event === 'file_end')?.version).toBe(2);

    const runs = await storage().listAgentRuns(id);
    expect(runs.some((run) => run.id === result.runId && run.agent === 'engineer' && run.status === 'done')).toBe(true);
  }, 30000);

  it('文件不存在 404；生成进行中 409（串行写模型防并发）', async () => {
    const { id } = await seedProject();
    expect(
      (await REGEN_POST(makeRequest(`http://localhost/api/projects/${id}/files/9999/regenerate`, { method: 'POST' }, SESSION_A), fileCtx(id, 9999))).status,
    ).toBe(404);

    // 生成进行中：重试单文件必须让位（V1 纯串行，不与在跑轮次并发写）
    vi.stubEnv('LLM_MOCK_DELAY_MS', '40');
    const { fileId } = await storage().upsertFile({ projectId: id, path: 'app/backend/api.js', content: '// x', editor: 'engineer' });
    const round = startGeneration({
      storage: storage(),
      projectId: id,
      userMessage: '做一次 SEO 分析',
      mode: 'fast',
      mentions: ['seo'],
      signal: new AbortController().signal,
    });
    await waitUntil(() => orchestratorStatus(id) === 'running', 5000);
    const conflict = await REGEN_POST(
      makeRequest(`http://localhost/api/projects/${id}/files/${fileId}/regenerate`, { method: 'POST' }, SESSION_A),
      fileCtx(id, fileId),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toContain('生成进行中');
    await round;
  });
});

/* ------------------------------------------------------------------ */
/* ⑨ checkpoint restore                                                */
/* ------------------------------------------------------------------ */

describe('POST /api/projects/[id]/checkpoints/[cpId]/restore', () => {
  it('⑨ 内容回滚（版本推进）+ message 事件 + 检查点之后的 run 标 rolled_back（生产形状打点）；快照外文件不动', async () => {
    const { id } = await seedProject();
    // 生产形状（fix 轮）：检查点由编排器在任务**前**打——agentRunId=null、
    // afterRunId=打点时刻 latestRunId；此处手工复刻同一形状
    const before = await storage().createAgentRun({ projectId: id, taskKey: 'pm-prd', agent: 'pm', task: '产出 PRD' });
    await storage().updateAgentRun(before.id, { status: 'done', summary: 'PRD 完成' });
    await storage().upsertFile({ projectId: id, path: 'app/frontend/index.html', content: '旧内容', editor: 'engineer' });
    const cpId = await storage().createCheckpoint(id, '任务前:engineer:app/frontend/index.html', null, await storage().latestRunId(id));

    // 打点之后：新任务 run + 覆写该文件 + 新增另一个文件（快照外）
    const after = await storage().createAgentRun({ projectId: id, taskKey: 'engineer:app/frontend/index.html', agent: 'engineer', task: '实现页面' });
    await storage().updateAgentRun(after.id, { status: 'done' });
    await storage().upsertFile({ projectId: id, path: 'app/frontend/index.html', content: '新内容', editor: 'engineer' });
    await storage().upsertFile({ projectId: id, path: 'app/extra.js', content: '后加的', editor: 'engineer' });

    const messages: string[] = [];
    const stopCollecting = projectEventBus.subscribe(id, (event) => {
      if (event.event === 'message') messages.push(event.content ?? '');
    });

    const response = await RESTORE_POST(
      makeRequest(`http://localhost/api/projects/${id}/checkpoints/${cpId}/restore`, { method: 'POST' }, SESSION_A),
      checkpointCtx(id, cpId),
    );
    stopCollecting();
    expect(response.status).toBe(200);
    expect(((await response.json()) as { restoredFiles: number }).restoredFiles).toBe(1);

    const restored = await storage().getFile(id, 'app/frontend/index.html');
    expect(restored?.content).toBe('旧内容');
    expect(restored?.version).toBe(3); // v1→v2 覆写，恢复再推 v3
    expect((await storage().getFile(id, 'app/extra.js'))?.content).toBe('后加的'); // 快照外不动

    // 方向断言：打点之后（被撤销）的 run 标 rolled_back；打点之前（仍成立）的 run 保持 done
    const runs = await storage().listAgentRuns(id);
    expect(runs.find((item) => item.id === before.id)?.status).toBe('done');
    expect(runs.find((item) => item.id === after.id)?.status).toBe('rolled_back');

    expect(messages.some((text) => text.includes('回滚'))).toBe(true);
  });

  it('生成进行中 → 409（与 regenerate 同一串行守卫，运行中时间线不可回滚）', async () => {
    const { id } = await seedProject();
    await storage().upsertFile({ projectId: id, path: 'app/frontend/index.html', content: '旧内容', editor: 'engineer' });
    const cpId = await storage().createCheckpoint(id, '任务前:engineer:app/frontend/index.html', null, await storage().latestRunId(id));

    vi.stubEnv('LLM_MOCK_DELAY_MS', '40');
    const round = startGeneration({
      storage: storage(),
      projectId: id,
      userMessage: '做一次 SEO 分析',
      mode: 'fast',
      mentions: ['seo'],
      signal: new AbortController().signal,
    });
    await waitUntil(() => orchestratorStatus(id) === 'running', 5000);
    const conflict = await RESTORE_POST(
      makeRequest(`http://localhost/api/projects/${id}/checkpoints/${cpId}/restore`, { method: 'POST' }, SESSION_A),
      checkpointCtx(id, cpId),
    );
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toContain('生成进行中');
    // 回滚确实没有发生（文件未被恢复出别的版本）
    expect((await storage().getFile(id, 'app/frontend/index.html'))?.version).toBe(1);
    await round;
  }, 30000);

  it('检查点不存在或归属不符 → 404', async () => {
    const { id } = await seedProject();
    const response = await RESTORE_POST(
      makeRequest(`http://localhost/api/projects/${id}/checkpoints/424242/restore`, { method: 'POST' }, SESSION_A),
      checkpointCtx(id, 424242),
    );
    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/* 补充：列表 / 快照 / messages / DELETE / rename                        */
/* ------------------------------------------------------------------ */

describe('seed 模板画廊（T25 R1：union 可见 + 打开即克隆）', () => {
  /** 造 2 个 seed 模板 + 1 个当前会话项目；返回 { 本会话项目 id, seed 模板 ids } */
  async function seedTemplates(): Promise<{ mineId: number; seedIds: number[] }> {
    const s1 = await storage().createProject({ sessionId: 'seed', title: '待办清单应用', requirement: '做一个待办清单', mode: 'fast' });
    await storage().upsertFile({ projectId: s1.id, path: 'app/frontend/index.html', content: '<p>todo</p>', editor: 'seed' });
    const s2 = await storage().createProject({ sessionId: 'seed', title: '团队数据看板', requirement: '做一个看板', mode: 'fast' });
    const mine = await storage().createProject({ sessionId: SESSION_A, title: '我的项目', requirement: 'r', mode: 'fast' });
    liveProjectIds.add(s1.id);
    liveProjectIds.add(s2.id);
    liveProjectIds.add(mine.id);
    seenProjectIds.add(s1.id);
    seenProjectIds.add(s2.id);
    seenProjectIds.add(mine.id);
    return { mineId: mine.id, seedIds: [s1.id, s2.id] };
  }

  it('seed 卡片对所有会话可见（排在用户项目之后，带 isSeed 标记）', async () => {
    const { mineId, seedIds } = await seedTemplates();
    const response = await LIST_GET(makeRequest('http://localhost/api/projects', {}, SESSION_A));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: Array<{ id: number; isSeed?: boolean; title: string }> };
    // 用户项目在前，seed 模板行追加在末尾（模板内部仍按 updatedAt 倒序）
    expect(body.projects[0]?.id).toBe(mineId);
    expect(body.projects.slice(1).map((p) => p.id)).toEqual([...seedIds].sort((a, b) => b - a));
    expect(body.projects.slice(1).map((p) => p.isSeed)).toEqual([true, true]);
    expect(new Set(body.projects.slice(1).map((p) => p.title))).toEqual(new Set(['待办清单应用', '团队数据看板']));
  });

  it('GET open：seed 模板克隆到当前会话并 302 到副本（新访客顺带发会话 cookie）', async () => {
    const { seedIds } = await seedTemplates();
    const seedId = seedIds[0];
    if (seedId === undefined) throw new Error('seed 模板缺失');

    // 新访客：无 cookie
    const response = await OPEN_GET(makeRequest(`http://localhost/api/projects/${seedId}/open`, {}, undefined), idCtx(seedId));
    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    expect(location).toContain('/p/');
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE);

    const copyId = Number((location ?? '').split('/p/')[1]);
    expect(Number.isFinite(copyId)).toBe(true);
    const copy = await storage().getProject(copyId);
    expect(copy?.sessionId).not.toBe('seed');
    expect(copy?.title).toContain('示例副本');
    expect((await storage().readAllFiles(copyId)).map((f) => f.path)).toContain('app/frontend/index.html');
    // seed 原件不被占有
    expect((await storage().getProject(seedId))?.sessionId).toBe('seed');
  });

  it('GET open：普通项目 302 到自身（不克隆）；不存在 404', async () => {
    const { mineId } = await seedTemplates();
    const own = await OPEN_GET(makeRequest(`http://localhost/api/projects/${mineId}/open`, {}, SESSION_A), idCtx(mineId));
    expect(own.status).toBe(302);
    expect(own.headers.get('location')).toContain(`/p/${mineId}`);
    expect(await storage().countProjects()).toBe(3);

    const missing = await OPEN_GET(makeRequest('http://localhost/api/projects/424242/open', {}, SESSION_A), idCtx(424242));
    expect(missing.status).toBe(404);
  });
});

describe('GET /api/projects（列表 + 最近会话）', () => {
  it('按 session 过滤；recent 参数 clamp 上限 50；非法 recent 400', async () => {
    const { id } = await seedProject({ sessionId: SESSION_A });
    await seedProject({ sessionId: SESSION_A });
    await seedProject({ sessionId: SESSION_B }); // 他人项目不可见

    const response = await LIST_GET(makeRequest('http://localhost/api/projects?recent=3', {}, SESSION_A));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { projects: Array<{ id: number }>; recentSessions: Array<{ id: number }> };
    expect(body.projects.length).toBe(2);
    expect(body.projects.every((project) => project.id !== id || project.id === id)).toBe(true);
    expect(body.recentSessions.map((project) => project.id).sort((a, b) => a - b)).toEqual(body.projects.map((p) => p.id).sort((a, b) => a - b));

    const foreign = await LIST_GET(makeRequest('http://localhost/api/projects', {}, SESSION_B));
    expect(((await foreign.json()) as { projects: unknown[] }).projects.length).toBe(1);

    const clamped = await LIST_GET(makeRequest('http://localhost/api/projects?recent=9999', {}, SESSION_A));
    expect(clamped.status).toBe(200);
    const bad = await LIST_GET(makeRequest('http://localhost/api/projects?recent=abc', {}, SESSION_A));
    expect(bad.status).toBe(400);
  });
});

describe('GET /api/projects/[id]（现场恢复快照）', () => {
  it('快照字段齐全：files 全文 / streamingFiles（liveBuffer）/ softLockedFiles / usage / checkpoints / lastSeq', async () => {
    const { id } = await seedProject();
    await storage().upsertFile({ projectId: id, path: 'app/a.js', content: 'console.log(1)', editor: 'engineer' });
    await storage().setSoftLock(id, (await storage().getFile(id, 'app/a.js'))!.id, true);
    await storage().addMessage({ projectId: id, role: 'user', content: REQUIREMENT });
    await storage().createAgentRun({ projectId: id, taskKey: 'pm-prd', agent: 'pm', task: 'PRD' });
    await storage().createCheckpoint(id, '任务前:pm-prd', null, await storage().latestRunId(id));
    // 正在流式生成中的文件：file_start + delta（尚未 file_end）
    projectEventBus.emit(id, { runId: null, event: 'file_start', agent: 'engineer', path: 'app/b.js' });
    projectEventBus.emit(id, { runId: null, event: 'delta', agent: 'engineer', path: 'app/b.js', content: '部分内容' });

    const response = await PROJECT_GET(makeRequest(`http://localhost/api/projects/${id}`, {}, SESSION_A), idCtx(id));
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      project: { id: number };
      lastSeq: number;
      messages: unknown[];
      files: Array<{ path: string; content: string; version: number }>;
      agentRuns: unknown[];
      checkpoints: unknown[];
      usage: unknown[];
      streamingFiles: Array<{ path: string; content: string }>;
      softLockedFiles: Array<{ path: string }>;
    };
    expect(snapshot.project.id).toBe(id);
    expect(snapshot.lastSeq).toBeGreaterThanOrEqual(2);
    expect(snapshot.messages.length).toBe(1);
    expect(snapshot.files.map((file) => file.path)).toContain('app/a.js');
    expect(snapshot.files[0]?.content).toBe('console.log(1)');
    expect(snapshot.agentRuns.length).toBe(1);
    expect(snapshot.checkpoints.length).toBe(1);
    expect(Array.isArray(snapshot.usage)).toBe(true);
    expect(snapshot.streamingFiles).toEqual([{ path: 'app/b.js', content: '部分内容' }]);
    expect(snapshot.softLockedFiles.map((file) => file.path)).toEqual(['app/a.js']);
  });

  it('不存在的项目 404；非法 id 400', async () => {
    expect((await PROJECT_GET(makeRequest('http://localhost/api/projects/99999', {}, SESSION_A), idCtx(99999))).status).toBe(404);
    expect((await PROJECT_GET(makeRequest('http://localhost/api/projects/abc', {}, SESSION_A), idCtx('abc'))).status).toBe(400);
  });
});

describe('POST /api/projects/[id]/messages', () => {
  it('空闲时 → 新一轮生成（fire-and-forget，最终 done + assistant 汇报）', async () => {
    const { id } = await seedProject();
    const response = await MESSAGES_POST(
      postJson(`http://localhost/api/projects/${id}/messages`, { content: REQUIREMENT }, SESSION_A),
      idCtx(id),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { delivered: string }).delivered).toBe('round');

    await waitUntil(async () => (await storage().getProject(id))?.status === 'done');
    const messages = await storage().listMessages(id);
    expect(messages.some((message) => message.role === 'user' && message.content === REQUIREMENT)).toBe(true);
    expect(messages.some((message) => message.role === 'assistant')).toBe(true);
  }, 30000);

  it('运行中 → role=intervention 入队并在步骤边界投递（deliveredAt 打戳）', async () => {
    vi.stubEnv('LLM_MOCK_DELAY_MS', '40');
    const { id, storage: s } = await seedProject({ requirement: '做一次 SEO 分析' });
    const round = startGeneration({
      storage: s,
      projectId: id,
      userMessage: '做一次 SEO 分析',
      mode: 'fast',
      mentions: ['seo'],
      signal: new AbortController().signal,
    });
    await waitUntil(() => orchestratorStatus(id) === 'running', 5000);

    const response = await MESSAGES_POST(
      postJson(`http://localhost/api/projects/${id}/messages`, { content: '补充长尾关键词', mentions: ['seo'] }, SESSION_A),
      idCtx(id),
    );
    expect(((await response.json()) as { delivered: string }).delivered).toBe('intervention');
    await round;

    const messages = await storage().listMessages(id);
    const intervention = messages.find((message) => message.role === 'intervention');
    expect(intervention?.content).toBe('补充长尾关键词');
    expect(intervention?.deliveredAt).not.toBeNull();
  });

  it('空内容 400', async () => {
    const { id } = await seedProject();
    expect((await MESSAGES_POST(postJson(`http://localhost/api/projects/${id}/messages`, { content: '' }, SESSION_A), idCtx(id))).status).toBe(400);
  });
});

describe('PATCH/DELETE /api/projects/[id]', () => {
  it('重命名 200 返回新 title；空 title 400', async () => {
    const { id } = await seedProject();
    const response = await PROJECT_PATCH(patchJson(`http://localhost/api/projects/${id}`, { title: '新名字' }, SESSION_A), idCtx(id));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { project: { title: string } }).project.title).toBe('新名字');
    expect((await storage().getProject(id))?.title).toBe('新名字');
    expect((await PROJECT_PATCH(patchJson(`http://localhost/api/projects/${id}`, { title: ' ' }, SESSION_A), idCtx(id))).status).toBe(400);
  });

  it('DELETE 200 → 项目消失 + 总线桶释放（重放窗口清空）', async () => {
    const { id } = await seedProject();
    projectEventBus.emit(id, { runId: null, event: 'message', content: 'x' });
    expect(projectEventBus.snapshotBuffer(id, 0).length).toBe(1);

    const response = await PROJECT_DELETE(makeRequest(`http://localhost/api/projects/${id}`, { method: 'DELETE' }, SESSION_A), idCtx(id));
    expect(response.status).toBe(200);
    expect(await storage().getProject(id)).toBeNull();
    expect(projectEventBus.snapshotBuffer(id, 0)).toEqual([]); // release 生效
    liveProjectIds.delete(id);
  });
});
