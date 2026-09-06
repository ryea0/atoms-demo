/**
 * 工作区物化：files 表（唯一事实源）→ 磁盘执行投影（data/workspaces/p-<id>/）。
 * - 每次执行前同步（用户终端 POST / agent bash 每次调用）：delta 不落库、file_end 才落库，
 *   任何时刻物化到的都是「已提交」的完整文件集，无半截文件
 * - 全量覆写 + stale 清理（简单 > 聪明；demo 规模 <100 文件，毫秒级）
 * - 平台内置 __atoms/server.js 随每次物化幂等覆写（runner 非生成物，不参与导出/回滚）
 * - per-project 互斥（promise 链）：防 agent 物化与用户终端物化交错写盘；跨项目并行
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StorageProvider } from '@/lib/db/provider/types';
import { normalizeProjectPath } from '@/lib/agents/tools/sandbox';

export const WORKSPACES_DIR_DEFAULT = 'data/workspaces';
const ATOMS_DIR = '__atoms';

export function workspaceDir(projectId: number, env: NodeJS.ProcessEnv = process.env): string {
  // projectId 经路由 numericIdParam + requireProject 双重校验，目录名无注入面
  return path.join(env.EXEC_WORKSPACES_DIR ?? WORKSPACES_DIR_DEFAULT, `p-${projectId}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** per-project 物化互斥（前任失败不阻塞后任） */
const locks = new Map<number, Promise<unknown>>();
function withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(projectId) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  locks.set(projectId, next.catch(() => undefined));
  return next;
}

/**
 * files 表 → 工作区目录全量同步。
 * 返回 { dir, fileCount }（fileCount 不含 __atoms/）。DB 路径防御性复检 normalizeProjectPath，
 * 失败跳过 + console.warn（不静默吞）。
 */
export async function syncWorkspace(
  storage: StorageProvider,
  projectId: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ dir: string; fileCount: number }> {
  return withProjectLock(projectId, async () => {
    const dir = workspaceDir(projectId, env);
    const rows = await storage.readAllFiles(projectId);

    const wanted = new Map<string, string>();
    for (const row of rows) {
      const checked = normalizeProjectPath(row.path);
      if (!checked.ok) {
        console.warn(`[exec] 物化跳过非法路径 ${row.path}：${checked.error}`);
        continue;
      }
      wanted.set(checked.path, row.content);
    }

    await mkdir(dir, { recursive: true });
    await pruneExtra(dir, wanted);

    for (const [relativePath, content] of wanted) {
      const absolute = path.join(dir, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf8');
    }

    // 内置 runner：幂等覆写（升级执行层时旧工作区自动跟进新版本）
    await mkdir(path.join(dir, ATOMS_DIR), { recursive: true });
    await writeFile(path.join(dir, ATOMS_DIR, 'server.js'), SERVER_JS_SOURCE, 'utf8');

    return { dir, fileCount: wanted.size };
  });
}

/** 项目删除级联清理（幂等，best-effort：失败只 warn 不抛，不阻断项目删除主流程） */
export async function removeWorkspace(projectId: number, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await rm(workspaceDir(projectId, env), { recursive: true, force: true });
  } catch (error) {
    console.warn(`[exec] 清理工作区失败（p-${projectId}）：${messageOf(error)}`);
  }
}

/** 删磁盘上不在期望集且不在 __atoms/ 内的文件；随之清空的目录一并移除（根与 __atoms 保留） */
async function pruneExtra(rootDir: string, wanted: ReadonlyMap<string, string>): Promise<void> {
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(rootDir, absolute).split(path.sep).join('/');
      if (relative.startsWith(`${ATOMS_DIR}/`) || relative === ATOMS_DIR) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        const remaining = await readdir(absolute);
        if (remaining.length === 0) await rm(absolute, { recursive: true, force: true });
        continue;
      }
      if (!wanted.has(relative)) {
        // 普通文件以外的异物（套接字/符号链接等）force 移除
        await rm(absolute, { recursive: true, force: true });
      }
    }
  }
  await walk(rootDir);
}

/**
 * 平台内置运行器（字符串常量内嵌——Next standalone 产物里读 src 资产路径不可靠，仿 preview/assemble.ts 的垫片模式）。
 * 零依赖 node:http：require 物化出的 app/backend/api.js，按预览同一信封协议 {code,data?,message?} 响应；
 * GET / 顺带静态吐 index.html（浏览器直开即真页面）。仅监听 127.0.0.1（演示姿态）。
 */
const SERVER_JS_SOURCE = `#!/usr/bin/env node
// Atoms-Demo 平台内置运行器（物化时自动注入，非生成物；升级随物化幂等覆写）
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const indexPath = path.join(root, 'app/frontend/index.html');
const apiPath = path.join(root, 'app/backend/api.js');

let backend = null;
try {
  backend = require(apiPath);
} catch (err) {
  console.error('[atoms] 加载 app/backend/api.js 失败：', err && err.message);
}

function envelope(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(indexPath, 'utf8'));
    } else {
      envelope(res, 404, { code: 404, message: '未找到 app/frontend/index.html' });
    }
    return;
  }
  if (!backend || typeof backend.handle !== 'function') {
    envelope(res, 503, { code: 503, message: '后端模块不可用（缺 app/backend/api.js 或未导出 handle）' });
    return;
  }
  const chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    let body = null;
    if (chunks.length > 0) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        envelope(res, 400, { code: 400, message: '请求体不是合法 JSON' });
        return;
      }
    }
    try {
      Promise.resolve(backend.handle(req.method, url.pathname, body)).then(function (result) {
        const payload = result && typeof result === 'object' ? result : { code: 200, data: result };
        const code = typeof payload.code === 'number' ? payload.code : 200;
        envelope(res, code, payload);
      }).catch(function (err) {
        envelope(res, 500, { code: 500, message: '后端处理出错：' + (err && err.message) });
      });
    } catch (err) {
      envelope(res, 500, { code: 500, message: '后端处理出错：' + (err && err.message) });
    }
  });
});

server.listen(0, '127.0.0.1', function () {
  const address = server.address();
  console.log('ATOMS_SERVER_URL=http://127.0.0.1:' + address.port);
});
`;
