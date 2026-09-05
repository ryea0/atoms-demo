'use client';

/**
 * 客户端会话/请求层（Task 17）。
 *
 * 匿名会话 cookie 由服务端下发（httpOnly + SameSite=Lax，见 .claude/rules/07），
 * 客户端只需同源携带，不做任何身份处理。本模块统一：JSON 解析、结构化错误（不泄漏堆栈）、
 * REST 封装（POST /api/projects、列表、重命名、删除、zip 导出、工作台快照）。
 * 另存平台自身的会话级本地偏好（公告条关闭标记；注意：localStorage 禁令针对生成的应用，
 * 平台页面不受限，但仍用 sessionStorage 保持「关一次、本次会话不再打扰」的轻语义）。
 */
import type { Project, ProjectListItem } from '@/lib/db/provider/types';
import type { WorkspaceSnapshot } from '@/lib/client/store';

/** 结构化 API 错误（message 来自服务端 code/message，可直接展示给用户） */
export class ApiError extends Error {
  readonly status: number;

  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** 解析响应体（空体 → null；非法 JSON → null，由调用方按结构化错误处理） */
async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 统一请求入口：同源携带会话 cookie，非 2xx 转 ApiError */
export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await parseBody(response);
  if (!response.ok) {
    const payload = (body ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof payload.code === 'string' ? payload.code : 'http_error';
    const message =
      typeof payload.message === 'string' && payload.message !== ''
        ? payload.message
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(response.status, code, message);
  }
  return body as T;
}

/* ------------------------------------------------------------------ */
/* REST 封装（与 T16 路由契约对齐）                                       */
/* ------------------------------------------------------------------ */

export interface CreateProjectBody {
  requirement: string;
  mode: 'fast' | 'full';
  mentions?: string[];
}

/** POST /api/projects → 201 {project} */
export function createProject(body: CreateProjectBody): Promise<{ project: Project }> {
  return requestJson<{ project: Project }>('/api/projects', { method: 'POST', body: JSON.stringify(body) });
}

/** GET /api/projects → {projects: ProjectListItem[]}（updatedAt 倒序，服务端一次聚合） */
export function listProjects(): Promise<{ projects: ProjectListItem[] }> {
  return requestJson<{ projects: ProjectListItem[] }>('/api/projects');
}

/** PATCH /api/projects/[id] → 200（标题重命名） */
export function renameProject(projectId: number, title: string): Promise<void> {
  return requestJson(`/api/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

/** DELETE /api/projects/[id] → 200（级联删除） */
export function deleteProject(projectId: number): Promise<void> {
  return requestJson(`/api/projects/${projectId}`, { method: 'DELETE' });
}

/** GET /api/projects/[id] → 工作台快照（useWorkspace 的恢复数据源） */
export function fetchWorkspaceSnapshot(projectId: number, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
  return requestJson<WorkspaceSnapshot>(`/api/projects/${projectId}`, { signal });
}

/* ------------------------------------------------------------------ */
/* 人工编辑（DESIGN §3.9 人机共编：同一写 API + CAS 乐观锁 + 声明式软锁）   */
/* ------------------------------------------------------------------ */

/** 人工保存结果：ok=新版本号；冲突时带回服务端当前内容（并排 diff / 放弃草稿用） */
export type SaveHumanFileResult = { ok: true; version: number } | { ok: false; conflict: true; current: string };

/**
 * PATCH /api/projects/[id]/files/[fid]：人工编辑保存。
 * 409 不抛错——它是 CAS 冲突的正常分支，转成 {ok:false,conflict,current} 交冲突对话框；
 * 其余失败（400/404/500）抛 ApiError，由调用方提示用户。
 */
export async function saveHumanFile(
  projectId: number,
  fileId: number,
  content: string,
  baseVersion: number,
): Promise<SaveHumanFileResult> {
  const response = await fetch(`/api/projects/${projectId}/files/${fileId}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, baseVersion }),
  });
  if (response.ok) {
    const body = (await parseBody(response)) as { version?: unknown } | null;
    return { ok: true, version: typeof body?.version === 'number' ? body.version : baseVersion + 1 };
  }
  if (response.status === 409) {
    const body = (await parseBody(response)) as { current?: unknown } | null;
    return { ok: false, conflict: true, current: typeof body?.current === 'string' ? body.current : '' };
  }
  const payload = (await parseBody(response)) as { code?: unknown; message?: unknown } | null;
  const code = typeof payload?.code === 'string' ? payload.code : 'http_error';
  const message =
    typeof payload?.message === 'string' && payload.message !== ''
      ? payload.message
      : `请求失败（HTTP ${response.status}）`;
  throw new ApiError(response.status, code, message);
}

/**
 * PUT /api/projects/[id]/files/[fid]/lock：声明/释放人工软锁（DESIGN §3.9 预防层）。
 * 进入编辑态置 on=true（agent 文件边界据此挂起并请求裁决），保存/离开置 on=false。
 */
export async function setFileSoftLock(projectId: number, fileId: number, on: boolean): Promise<void> {
  await requestJson(`/api/projects/${projectId}/files/${fileId}/lock`, {
    method: 'PUT',
    body: JSON.stringify({ on }),
  });
}

/** 导出 zip：直接交给浏览器下载（Route Handler 返回二进制，不走 JSON 封装） */
export function openProjectExport(projectId: number): void {
  window.open(`/api/projects/${projectId}/export`, '_blank');
}

/* ------------------------------------------------------------------ */
/* 会话级本地偏好（公告条）                                              */
/* ------------------------------------------------------------------ */

const ANNOUNCEMENT_KEY = 'atoms.announce.v1.dismissed';

export function isAnnouncementDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(ANNOUNCEMENT_KEY) === '1';
  } catch {
    return false; // 隐私模式等存取失败：按未关闭处理
  }
}

export function dismissAnnouncement(): void {
  try {
    window.sessionStorage.setItem(ANNOUNCEMENT_KEY, '1');
  } catch (error) {
    console.error('[session] 公告关闭标记写入失败：', error);
  }
}
