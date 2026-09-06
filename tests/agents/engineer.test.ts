/**
 * 工程师角色测试（Task 13，DESIGN §3.2 D1 混合模式 / §3.7 全栈契约 / §5⑤ 质量下限）：
 * brief 原文用例 ①-④ 在前，补充用例 ⑤ 模板分支 / ⑥ 自审覆写在后。
 * - mock provider：验证模板质量下限（生成物必须通过 validateFile 才算 ok）
 * - FakeProvider：脚本化响应 + 计数，验证「校验失败 → 重跑该单文件任务」的重试路径
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFastFileTree, runEngineerFile, runEngineerReview } from '@/lib/agents/roles/engineer';
import type { FileTree, FileTreeNode } from '@/lib/agents/roles/file-tree';
import type { RunnerCallbacks } from '@/lib/agents/types';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';
import type { LlmProvider, LlmRequest, LlmResult, ToolCall } from '@/lib/llm/types';

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

/** 脚本化一步（与 runner.test.ts 同款约定：脚本耗尽即抛哨兵错误） */
interface ScriptedStep {
  content?: string;
  toolCalls?: ToolCall[];
  deltas?: string[];
}

class ScriptExhaustedError extends Error {
  constructor() {
    super('FakeProvider 脚本已耗尽（provider 被多调用了一次）');
    this.name = 'ScriptExhaustedError';
  }
}

/** 测试桩 provider：按脚本依次返回，并记录每次收到的请求（供重试路径计数与上下文断言） */
class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: LlmRequest[] = [];
  private readonly script: ScriptedStep[];
  private cursor = 0;

  constructor(...steps: ScriptedStep[]) {
    this.script = steps;
  }

  async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
    this.requests.push({ ...req, messages: req.messages.map((message) => ({ ...message })) });
    const step = this.script[this.cursor];
    this.cursor += 1;
    if (step === undefined) throw new ScriptExhaustedError();
    for (const text of step.deltas ?? []) onDelta(text);
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: null };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.stream(req, () => undefined);
  }
}

/** 含 eval 的 api.js：语法合法但触发危险扫描 hard（eval）——专测重试路径 */
const BAD_API = [
  "'use strict';",
  'var data = [];',
  'var evil = eval("1 + 1");',
  'function handle(method, path, body) {',
  '  return { code: 200, data: { method: method, path: path, body: body, evil: evil } };',
  '}',
  'module.exports = { handle: handle };',
  '',
].join('\n');

/** 干净的 api.js：通过语法与危险扫描 */
const GOOD_API = [
  "'use strict';",
  'var todos = [];',
  'function handle(method, path, body) {',
  "  if (method === 'GET') return { code: 200, data: todos };",
  "  if (method === 'POST') { todos.push({ id: 1, title: body.title, done: false }); return { code: 201, data: todos[0] };",
  '}',
  '  return { code: 404, message: "not found" };',
  '}',
  'module.exports = { handle: handle };',
  '',
].join('\n');

/** 独立内存库 + 项目 + file_tree 种子 */
async function newProject(
  requirement = '做一个待办清单',
  options: { seedTree?: boolean } = {},
): Promise<{ storage: StorageProvider; projectId: number; tree: FileTree }> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's-eng', title: 't', requirement, mode: 'fast' });
  const tree = buildFastFileTree(requirement);
  if (options.seedTree !== false) {
    await storage.upsertFile({
      projectId: project.id,
      path: 'docs/file_tree.json',
      content: `${JSON.stringify(tree, null, 2)}\n`,
      editor: 'architect',
    });
  }
  return { storage, projectId: project.id, tree };
}

/** 从树里取节点（缺失即显式失败） */
function nodeOf(tree: FileTree, path: string): FileTreeNode {
  const node = tree.find((item) => item.path === path);
  if (node === undefined) throw new Error(`文件树缺少节点：${path}`);
  return node;
}

/** runEngineerFile 入参组装（requirement/designSummary 可按模板分支覆盖） */
function fileCtx(
  base: { storage: StorageProvider; projectId: number; tree: FileTree },
  target: FileTreeNode,
  provider?: LlmProvider,
  overrides: { requirement?: string; designSummary?: string } = {},
) {
  return {
    storage: base.storage,
    projectId: base.projectId,
    requirement: overrides.requirement ?? '做一个待办清单',
    target,
    fileTree: base.tree,
    designSummary: overrides.designSummary ?? '快速模式：前端单页 + 内存态后端 handle(method,path,body)，资源 /api/todos。',
    ...(provider === undefined ? {} : { provider }),
  };
}

beforeEach(() => {
  // mock 流式延迟置 0（模板全文 ~10KB，默认 5ms/chunk 会把用例拖超时）
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* ① buildFastFileTree                                                  */
/* ------------------------------------------------------------------ */

describe('buildFastFileTree：关键词确定性选型', () => {
  it('① 待办关键词 → CRUD 模板：含 index.html 与 api.js，且前者 depends 后者', () => {
    const tree = buildFastFileTree('做一个待办清单');
    const paths = tree.map((node) => node.path);
    expect(paths).toContain('app/frontend/index.html');
    expect(paths).toContain('app/backend/api.js');
    expect(nodeOf(tree, 'app/frontend/index.html').depends).toContain('app/backend/api.js');
    expect(tree.length).toBeGreaterThanOrEqual(4);
    expect(tree.length).toBeLessThanOrEqual(5);
  });

  it('① 三种关键词分支：todo/list（英文关键词）同样命中 CRUD', () => {
    const todo = buildFastFileTree('a simple todo app');
    const list = buildFastFileTree('shopping list 清单');
    for (const tree of [todo, list]) {
      expect(nodeOf(tree, 'app/frontend/index.html').depends).toContain('app/backend/api.js');
    }
    // CRUD 资源路由约定为 /api/todos
    expect(buildFastFileTree('做一个待办清单').map((n) => n.desc).join('\n')).toContain('/api/todos');
  });

  it('⑤ dashboard 关键词 → 仪表盘模板（/api/stats）', () => {
    const tree = buildFastFileTree('做一个数据看板 dashboard');
    const descs = tree.map((node) => node.desc).join('\n');
    expect(descs).toContain('/api/stats');
    expect(nodeOf(tree, 'app/frontend/index.html').depends).toContain('app/backend/api.js');
  });

  it('⑤ 默认分支 → 落地页模板（/api/leads）', () => {
    const tree = buildFastFileTree('个人作品集主页');
    const descs = tree.map((node) => node.desc).join('\n');
    expect(descs).toContain('/api/leads');
    expect(nodeOf(tree, 'app/frontend/index.html').depends).toContain('app/backend/api.js');
  });
});

/* ------------------------------------------------------------------ */
/* ②③④ runEngineerFile（D1 单文件任务）                                  */
/* ------------------------------------------------------------------ */

describe('runEngineerFile：mock 全链路与质量下限', () => {
  it('② mock engineer 写 api.js：落库 v1、ok=true、agent_run done、模板过校验', async () => {
    const base = await newProject();
    const result = await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/backend/api.js')));

    expect(result.path).toBe('app/backend/api.js');
    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    expect(result.softWarnings).toEqual([]);
    expect(result.runId).toBeGreaterThan(0);

    const row = await base.storage.getFile(base.projectId, 'app/backend/api.js');
    expect(row?.version).toBe(1);
    expect(row?.lastEditor).toBe('engineer');
    expect(row?.content).toContain('module.exports');
    expect(row?.content).toContain('handle');

    const runs = await base.storage.listAgentRuns(base.projectId);
    const run = runs.find((item) => item.id === result.runId);
    expect(run?.agent).toBe('engineer');
    expect(run?.status).toBe('done');
  });

  it('② mock engineer 写 index.html：模板含现代 UI 基线且通过校验（ok=true）', async () => {
    const base = await newProject();
    // 先写 api.js（index.html 的依赖文件，供上下文注入）
    await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/backend/api.js')));
    const result = await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/frontend/index.html')));

    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    const html = (await base.storage.getFile(base.projectId, 'app/frontend/index.html'))?.content ?? '';
    expect(html).toContain('https://cdn.tailwindcss.com');
    expect(html).toContain('#F7F7F8');
    expect(html).toContain('#3B82F6');
    expect(html).not.toContain('localStorage');
    // 完整 CRUD：增删改查四类交互都在（PATCH=改、DELETE=删）
    expect(html).toContain('fetch(API');
    expect(html).toContain('编辑'); // 改（内联编辑入口）
    expect(html).toContain("method: 'POST'");
    expect(html).toContain("method: 'PATCH'");
    expect(html).toContain("method: 'DELETE'");
  });

  it('② mock 生成物 fetch 只走 /api/ 契约（api.js + index.html 无软警告）', async () => {
    const base = await newProject();
    const api = await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/backend/api.js')));
    const html = await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/frontend/index.html')));
    expect(api.softWarnings).toEqual([]);
    expect(html.softWarnings).toEqual([]);
    // 通过路径不产出 errors（T15 契约：ok=true ⇒ errors 不出现）
    expect(api.errors).toBeUndefined();
    expect(html.errors).toBeUndefined();
  });

  it('F1 dashboard 分支：统计卡片只读 UI（无编辑/删除）+ 聚合后端（无创建路径）', async () => {
    const base = await newProject('做一个数据看板 dashboard');
    const overrides = { requirement: '做一个数据看板 dashboard', designSummary: '快速模式：数据仪表盘 + 聚合接口 /api/stats。' };
    const api = await runEngineerFile(
      fileCtx(base, nodeOf(base.tree, 'app/backend/api.js'), undefined, overrides),
    );
    const html = await runEngineerFile(
      fileCtx(base, nodeOf(base.tree, 'app/frontend/index.html'), undefined, overrides),
    );
    expect(api.ok).toBe(true);
    expect(html.ok).toBe(true);

    const htmlContent = (await base.storage.getFile(base.projectId, 'app/frontend/index.html'))?.content ?? '';
    expect(htmlContent).toContain("var API = '/api/stats';");
    expect(htmlContent).toContain('card-total'); // 统计卡片语义
    expect(htmlContent).toContain('card-done');
    expect(htmlContent).toContain('card-rate');
    expect(htmlContent).toContain('完成率');
    expect(htmlContent).toContain('刷新');
    // 只读仪表盘：不出现编辑/删除操作
    expect(htmlContent).not.toContain('编辑');
    expect(htmlContent).not.toContain('删除');

    const apiContent = (await base.storage.getFile(base.projectId, 'app/backend/api.js'))?.content ?? '';
    expect(apiContent).toContain('total');
    expect(apiContent).toContain('rate');
    expect(apiContent).toContain('recent');
    // 聚合只读：无创建语义（nextId）与写方法放行
    expect(apiContent).not.toContain('nextId');
    expect(apiContent).toContain('405');
  });

  it('F1 landing 分支：hero + 留资表单（POST /api/leads），无待办列表语义', async () => {
    const base = await newProject('个人作品集主页');
    const overrides = { requirement: '个人作品集主页', designSummary: '快速模式：落地页 + 留资接口 /api/leads。' };
    const api = await runEngineerFile(
      fileCtx(base, nodeOf(base.tree, 'app/backend/api.js'), undefined, overrides),
    );
    const html = await runEngineerFile(
      fileCtx(base, nodeOf(base.tree, 'app/frontend/index.html'), undefined, overrides),
    );
    expect(api.ok).toBe(true);
    expect(html.ok).toBe(true);

    const htmlContent = (await base.storage.getFile(base.projectId, 'app/frontend/index.html'))?.content ?? '';
    expect(htmlContent).toContain("var API = '/api/leads';");
    expect(htmlContent).toContain('lead-form'); // 留资表单
    expect(htmlContent).toContain("method: 'POST'");
    // 无待办 CRUD 语义
    expect(htmlContent).not.toContain('待办');
    expect(htmlContent).not.toContain('checkbox');

    const apiContent = (await base.storage.getFile(base.projectId, 'app/backend/api.js'))?.content ?? '';
    expect(apiContent).toContain('nextId'); // 留资创建
    expect(apiContent).toContain('201');
    expect(apiContent).toContain('contact 不能为空'); // 400 校验
  });
});

describe('runEngineerFile：校验失败重试（D1：重跑单文件任务）', () => {
  it('③ 第一次 hard（eval）→ 完整重试被调（FakeProvider 计数 4 次调用）→ 第二次成功 ok=true', async () => {
    const base = await newProject('做一个待办清单', { seedTree: false });
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'app/backend/api.js', content: BAD_API } }] },
      { content: '第一次完成（含危险调用）' },
      { toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'app/backend/api.js', content: GOOD_API } }] },
      { content: '已修复，重新写入' },
    );

    const seen: { name: string; ok?: boolean }[] = [];
    const callbacks: RunnerCallbacks = { onToolCall: (call) => seen.push({ name: call.name, ok: call.ok }) };
    const result = await runEngineerFile({ ...fileCtx(base, nodeOf(base.tree, 'app/backend/api.js'), provider), callbacks });

    // 两次完整 runAgent（写文件 + 收尾各一步）→ provider 恰好 4 次调用
    expect(provider.requests).toHaveLength(4);
    expect(result.ok).toBe(true);
    expect(result.errors).toBeUndefined(); // ok=true 不产出 errors（T15 契约）
    expect(result.version).toBe(2); // 第一次 BAD_API v1 被修复版覆写为 v2
    const row = await base.storage.getFile(base.projectId, 'app/backend/api.js');
    expect(row?.content).toBe(GOOD_API);

    // 重试任务的上文带上了第一次的校验错误反馈
    const secondUser = provider.requests[2]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(secondUser).toContain('eval');

    // 两次 write_file 都经 onToolCall 透出（ok 契约）
    expect(seen.filter((call) => call.name === 'write_file')).toHaveLength(2);

    // 计量：两次运行共 4 次调用，模型绑定与 llm_calls 记账一致
    const usage = await base.storage.usageByProject(base.projectId);
    const engineerRow = usage.find((item) => item.agentRole === 'engineer');
    expect(engineerRow?.calls).toBe(4);
    expect(engineerRow?.model).toBe('mock-model'); // resolveModel('engineer') 的默认值
  });

  it('③ system prompt 契约：含「工程师」标记 + 全栈契约要点（D2）', async () => {
    const base = await newProject('做一个待办清单', { seedTree: false });
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'app/backend/api.js', content: GOOD_API } }] },
      { content: '完成' },
    );
    await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/backend/api.js'), provider));

    const system = provider.requests[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('工程师');
    expect(system).toContain('write_file');
    expect(system).toContain('handle(method, path, body)');
    expect(system).toContain('localStorage');
    expect(system).toContain("fetch('/api/");
    expect(system).toContain('500'); // bash 命令长度上限必须前置告知（线上缺陷：模型不知情导致连续超限）

    // 任务指令里目标路径逐字出现，且是最后一条用户消息里最后一个路径样 token（mock 路由契约）
    const user = provider.requests[0]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(user.trimEnd().endsWith('app/backend/api.js')).toBe(true);
  });

  it('④ 两次 hard → ok=false、文件仍落库（保留 BAD 内容）、softWarnings 记录错误', async () => {
    const base = await newProject('做一个待办清单', { seedTree: false });
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'app/backend/api.js', content: BAD_API } }] },
      { content: '第一次完成' },
      { toolCalls: [{ id: 'w2', name: 'write_file', args: { path: 'app/backend/api.js', content: BAD_API.replace('1 + 1', '2 + 2') } }] },
      { content: '第二次完成' },
    );

    const result = await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/backend/api.js'), provider));

    expect(provider.requests).toHaveLength(4);
    expect(result.ok).toBe(false);
    // errors 与 softWarnings 分离：硬错误单独带回（T15 契约：ok=false ⇒ errors 非空）
    expect(result.errors?.some((item) => item.includes('eval'))).toBe(true);
    expect(result.softWarnings.some((warning) => warning.includes('eval'))).toBe(true);
    // 文件保留落库（不回滚、不删除）
    const row = await base.storage.getFile(base.projectId, 'app/backend/api.js');
    expect(row).not.toBeNull();
    expect(row?.version).toBe(2);
    expect(row?.content).toContain('eval');
  });
});

/* ------------------------------------------------------------------ */
/* ⑦ 工具协议失误降级（AgentValidationError 的调用方回退，三段式第 3 步） */
/* ------------------------------------------------------------------ */

describe('runEngineerFile：bash 自检超限等工具协议失误不再炸任务', () => {
  // 复现线上缺陷（projectId=7）：写完 api.js 后 bash 自检命令 >500 字符，
  // 回喂重试仍超限 → runner 抛 AgentValidationError → 整个文件任务 failed（文件白写）。
  const LONG_CMD = 'x'.repeat(601);

  it('⑦ 文件已写好 + bash 连续超限 → 按已落盘产物收口：ok=true、run done', async () => {
    const base = await newProject('做一个待办清单', { seedTree: false });
    const provider = new FakeProvider(
      {
        toolCalls: [
          { id: 'w1', name: 'write_file', args: { path: 'app/backend/api.js', content: GOOD_API } },
          { id: 'b1', name: 'bash', args: { command: LONG_CMD } },
        ],
      },
      // 第二轮仍发超长命令：连续两次校验失败 → runner 抛 AgentValidationError
      { toolCalls: [{ id: 'b2', name: 'bash', args: { command: LONG_CMD } }] },
    );

    const result = await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/backend/api.js'), provider));

    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    const row = await base.storage.getFile(base.projectId, 'app/backend/api.js');
    expect(row?.content).toBe(GOOD_API);
    const runs = await base.storage.listAgentRuns(base.projectId);
    const run = runs.find((item) => item.id === result.runId);
    expect(run?.status).toBe('done');
    expect(run?.summary).toContain('工具校验失误'); // 失误可见，不静默吞
  });

  it('⑦ 失误且未写文件 → 带真实原因反馈重跑，第二次写对 → ok=true', async () => {
    const base = await newProject('做一个待办清单', { seedTree: false });
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'b1', name: 'bash', args: { command: LONG_CMD } }] },
      { toolCalls: [{ id: 'b2', name: 'bash', args: { command: 'y'.repeat(700) } }] },
      { toolCalls: [{ id: 'w1', name: 'write_file', args: { path: 'app/backend/api.js', content: GOOD_API } }] },
      { content: '完成' },
    );

    const result = await runEngineerFile(fileCtx(base, nodeOf(base.tree, 'app/backend/api.js'), provider));

    expect(result.ok).toBe(true);
    expect(result.version).toBe(1);
    // 重跑的任务文本带上真实失误原因与 500 上限指引（而非误导性的「没有调用 write_file」）
    const retryUser = provider.requests[2]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(retryUser).toContain('工具 bash');
    expect(retryUser).toContain('500');
  });
});

/* ------------------------------------------------------------------ */
/* ⑥ runEngineerReview（写后自审）                                       */
/* ------------------------------------------------------------------ */

describe('runEngineerReview：一次廉价自审', () => {
  it('⑥ mock 发现问题 → 覆写 write_file → 返回 true 且版本递增', async () => {
    const base = await newProject();
    const target = nodeOf(base.tree, 'app/backend/api.js');
    const first = await runEngineerFile(fileCtx(base, target));
    expect(first.ok).toBe(true);

    const changed = await runEngineerReview({
      storage: base.storage,
      projectId: base.projectId,
      requirement: '做一个待办清单',
      target,
      fileTree: base.tree,
      designSummary: '快速模式：资源 /api/todos。',
      path: 'app/backend/api.js',
    });

    expect(changed).toBe(true);
    const row = await base.storage.getFile(base.projectId, 'app/backend/api.js');
    expect(row?.version).toBe(2);
    expect(row?.lastEditor).toBe('engineer');
    // 自审也留 run 记录（时间线可见）
    const runs = await base.storage.listAgentRuns(base.projectId);
    expect(runs.some((run) => run.taskKey === 'engineer-review:app/backend/api.js')).toBe(true);
  });

  it('F2 自审改写引入语法错误 → 校验失败回滚原内容、返回 false、错误落 agent_runs.error', async () => {
    const base = await newProject('做一个待办清单', { seedTree: false });
    const target = nodeOf(base.tree, 'app/backend/api.js');
    const seeded = await base.storage.upsertFile({
      projectId: base.projectId,
      path: 'app/backend/api.js',
      content: GOOD_API,
      editor: 'engineer',
    });
    expect(seeded.version).toBe(1);

    const GARBAGE = 'function handle(method, path, body { return {}; }'; // acorn 必报语法错误
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'r1', name: 'write_file', args: { path: 'app/backend/api.js', content: GARBAGE } }] },
      { content: '已重写修复' },
    );

    const changed = await runEngineerReview({
      storage: base.storage,
      projectId: base.projectId,
      requirement: '做一个待办清单',
      target,
      fileTree: base.tree,
      designSummary: '',
      path: 'app/backend/api.js',
      provider,
    });

    expect(changed).toBe(false); // 改写未通过复检 → 视为未改进，回滚
    const row = await base.storage.getFile(base.projectId, 'app/backend/api.js');
    expect(row?.content).toBe(GOOD_API); // 内容回到自审前（restoreFileVersion 生成新版本）
    expect(row?.version).toBe(3); // v1 原文 → v2 垃圾改写 → v3 恢复
    // 校验错误被记录（不静默吞）
    const runs = await base.storage.listAgentRuns(base.projectId);
    const reviewRun = runs.find((run) => run.taskKey === 'engineer-review:app/backend/api.js');
    expect(reviewRun?.error).toContain('语法');
    expect(reviewRun?.summary).toContain('回滚');
  });

  it('⑥ 无问题（FakeProvider 不写文件）→ 返回 false、版本不变', async () => {
    const base = await newProject('做一个待办清单', { seedTree: false });
    const target = nodeOf(base.tree, 'app/backend/api.js');
    await base.storage.upsertFile({
      projectId: base.projectId,
      path: 'app/backend/api.js',
      content: GOOD_API,
      editor: 'engineer',
    });
    const provider = new FakeProvider({ content: '检查通过，无需修改。' });

    const changed = await runEngineerReview({
      storage: base.storage,
      projectId: base.projectId,
      requirement: '做一个待办清单',
      target,
      fileTree: base.tree,
      designSummary: '',
      path: 'app/backend/api.js',
      provider,
    });

    expect(changed).toBe(false);
    expect(provider.requests).toHaveLength(1);
    const row = await base.storage.getFile(base.projectId, 'app/backend/api.js');
    expect(row?.version).toBe(1);
  });
});
