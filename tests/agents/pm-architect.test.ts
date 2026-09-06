/**
 * PM / 架构师角色测试（Task 12，DESIGN §3.2「结构化单发」/ §5⑤「生成质量工程」）。
 * brief 原文用例在前：mock 下 PM 产出 docs/prd.md 落库（fast 两种 prompt 断言）；
 * 架构师产出 8 个 docs 文件且 fileTree 解析出 nodes 带 depends；输出缺图 → 缺什么少什么，不抛错。
 * 补充：runId 存在、summary 非空、llm_calls 计量、路径沙箱拒逃逸段、停止语义（stopped）、
 * 角色标记契约（mock 按标记路由，两个角色的 prompt 不得互相污染）。
 * provider 可注入：除 mock 全链路用例外一律用脚本桩，保证离线且可观察请求。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectScene, readSample } from '@/lib/llm/mock';
import { runPm, pmSystemPrompt, PRD_PATH, PM_TASK_KEY } from '@/lib/agents/roles/pm';
import {
  ARCHITECT_DOC_PATHS,
  ARCHITECT_TASK_KEY,
  FILE_TREE_SUMMARY_MARKER,
  architectSystemPrompt,
  parseFileTree,
  runArchitect,
} from '@/lib/agents/roles/architect';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';
import type { LlmProvider, LlmRequest, LlmResult } from '@/lib/llm/types';

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

/** 脚本桩 provider：按脚本依次回 content，记录收到的请求，脚本耗尽即抛错（多调一次显式失败） */
class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: LlmRequest[] = [];
  private cursor = 0;

  private readonly contents: string[];

  constructor(...contents: string[]) {
    this.contents = contents;
  }

  async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const content = this.contents[this.cursor];
    this.cursor += 1;
    if (content === undefined) throw new Error('FakeProvider 脚本已耗尽（被多调用了一次）');
    onDelta(content);
    return { content, toolCalls: [], usage: { promptTokens: 11, completionTokens: 7 } };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.stream(req, () => undefined);
  }
}

/** 抛错桩 provider：模拟 provider 层失败（网络/配置） */
class ThrowingProvider implements LlmProvider {
  readonly name = 'throwing';
  async stream(_req: LlmRequest, _onDelta: (text: string) => void): Promise<LlmResult> {
    void _req; // 形参只为对齐接口签名：行为 = 直接抛错
    void _onDelta;
    throw new Error('provider 炸了');
  }
  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.stream(req, () => undefined);
  }
}

/** 独立内存库 + 空项目 */
async function newProject(): Promise<{ storage: StorageProvider; projectId: number }> {
  const storage = newTestStorage();
  const project = await storage.createProject({ sessionId: 's', title: '待办应用', requirement: '做一个待办清单', mode: 'full' });
  return { storage, projectId: project.id };
}

/** 取 agent_runs 首行（缺失显式失败，规避 noUncheckedIndexedAccess 的可空索引访问） */
async function firstRun(storage: StorageProvider, projectId: number) {
  const runs = await storage.listAgentRuns(projectId);
  const run = runs[0];
  if (run === undefined) throw new Error('预期至少一条 agent_run');
  return run;
}

/** 设计样例的 8 个分段（mock 架构师产出 = readSample('design.md')） */
function sampleSegments(): string {
  return readSample('design.md');
}

/** 取样例中某个 `===== path =====` 分段的正文（缺失显式失败） */
function sampleSegment(path: string): string {
  const parts = sampleSegments().split(`===== ${path} =====`);
  const body = parts[1];
  if (body === undefined) throw new Error(`样例 design.md 缺少分段：${path}`);
  return body.split('\n===== ')[0]?.trim() ?? '';
}

/** 从 run.summary 提取 file_tree JSON（缺失/不可解析显式失败） */
function fileTreeFromSummary(summary: string): unknown {
  const raw = summary.split(FILE_TREE_SUMMARY_MARKER)[1];
  if (raw === undefined) throw new Error(`summary 缺少 ${FILE_TREE_SUMMARY_MARKER} 标记`);
  return JSON.parse(raw.trim()) as unknown;
}

beforeEach(() => {
  // 离线快速：mock 流式延迟置 0（DESIGN §5⑥ 延迟可配）
  vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/* ------------------------------------------------------------------ */
/* 1. PM：结构化单发产出 docs/prd.md                                     */
/* ------------------------------------------------------------------ */
describe('runPm（mock）', () => {
  it('产出 docs/prd.md 落库：内容=黄金样例、editor=pm，runId/summary/时间戳齐备', async () => {
    const { storage, projectId } = await newProject();
    const result = await runPm({ storage, projectId, requirement: '做一个待办清单', fast: false });

    expect(result.runId).toBeGreaterThan(0);
    expect(result.files).toEqual([PRD_PATH]);

    const row = await storage.getFile(projectId, PRD_PATH);
    // 角色侧统一 trim 后落库（模型输出的首尾空白不入库），故与样例原文比 trim 后内容
    expect(row?.content).toBe(readSample('prd.md').trim());
    expect(row?.lastEditor).toBe('pm');
    expect(row?.producedBy).toBe('pm');
    expect(row?.version).toBe(1);

    const run = await firstRun(storage, projectId);
    expect(run.id).toBe(result.runId);
    expect(run.taskKey).toBe(PM_TASK_KEY);
    expect(run.agent).toBe('pm');
    expect(run.status).toBe('done');
    expect(run.summary).not.toBe('');
    expect(run.summary).not.toBeNull();
    expect(run.startedAt).not.toBeNull();
    expect(run.endedAt).not.toBeNull();
    expect(run.error).toBeNull();
  });

  it('llm_calls 计量：落一条 pm 记录（tokens>0，模型与请求一致）', async () => {
    const { storage, projectId } = await newProject();
    await runPm({ storage, projectId, requirement: '做一个待办清单', fast: false });

    const usage = await storage.usageByProject(projectId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.agentRole).toBe('pm');
    expect(usage[0]?.calls).toBe(1);
    expect((usage[0]?.tokens ?? 0)).toBeGreaterThan(0);
  });

  it('fast=true → system prompt 要求半页精简版；fast=false → 要求完整版', async () => {
    const fast = pmSystemPrompt(true);
    const full = pmSystemPrompt(false);
    expect(fast).toContain('产品经理');
    expect(full).toContain('产品经理');
    expect(fast).toContain('半页');
    expect(fast).not.toBe(full);
    expect(full).toContain('验收标准');
  });

  it('fast 标志真实进入请求（捕获 provider 收到的 system 消息）', async () => {
    const { storage, projectId } = await newProject();
    const provider = new FakeProvider(readSample('prd.md'));
    await runPm({ storage, projectId, requirement: '做一个待办清单', fast: true, provider });

    const system = provider.requests[0]?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('半页');
    expect(system).toContain('产品经理');
  });

  it('模型输出带 markdown 围栏 → 落库前剥掉一对围栏（不进文档正文）', async () => {
    const { storage, projectId } = await newProject();
    const fenced = ['', '```markdown', '# PRD：待办事项应用', '', '## 功能清单', '', '- F1 新增待办', '```', '', ''].join('\n');
    await runPm({ storage, projectId, requirement: '做一个待办清单', fast: false, provider: new FakeProvider(fenced) });

    const row = await storage.getFile(projectId, PRD_PATH);
    expect(row?.content.startsWith('```')).toBe(false);
    expect(row?.content.endsWith('```')).toBe(false);
    expect(row?.content).not.toContain('```');
    expect(row?.content).toContain('# PRD：待办事项应用');
  });

  it('无围栏输出 → 原样落库（仅 trim），mock 产出不受影响', async () => {
    const { storage, projectId } = await newProject();
    const plain = '# PRD：待办事项应用\n\n## 功能清单\n- F1 新增待办';
    await runPm({ storage, projectId, requirement: '做一个待办清单', fast: false, provider: new FakeProvider(plain) });
    expect((await storage.getFile(projectId, PRD_PATH))?.content).toBe(plain);
  });

  it('只有开头围栏（不成对）→ 原样保留不猜（围栏留在正文，宁可可见也不误删）', async () => {
    const { storage, projectId } = await newProject();
    const malformed = ['```markdown', '# PRD：待办事项应用', '', '- F1 新增待办'].join('\n');
    await runPm({ storage, projectId, requirement: '做一个待办清单', fast: false, provider: new FakeProvider(malformed) });
    expect((await storage.getFile(projectId, PRD_PATH))?.content).toBe(malformed);
  });

  it('角色标记契约：PM prompt 命中 mock 的 pm 场景（不被样例正文带偏）', () => {
    const scene = detectScene({
      model: 'mock-model',
      messages: [
        { role: 'system', content: pmSystemPrompt(false) },
        { role: 'user', content: '做一个待办清单应用' },
      ],
      tools: [],
    });
    expect(scene).toBe('pm');
  });

  it('模型返回空内容 → 上抛且 agent_runs 标 failed + error', async () => {
    const { storage, projectId } = await newProject();
    const provider = new FakeProvider('   ');
    const error = await runPm({ storage, projectId, requirement: '做一个待办清单', fast: false, provider }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const run = await firstRun(storage, projectId);
    expect(run.status).toBe('failed');
    expect(run.error).not.toBeNull();
    expect(run.endedAt).not.toBeNull();
    // 失败不落半成品文件
    expect(await storage.getFile(projectId, PRD_PATH)).toBeNull();
  });

  it('provider 抛错 → 原样上抛且 agent_runs 标 failed', async () => {
    const { storage, projectId } = await newProject();
    const error = await runPm({
      storage,
      projectId,
      requirement: '做一个待办清单',
      fast: false,
      provider: new ThrowingProvider(),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((await firstRun(storage, projectId)).status).toBe('failed');
  });

  it('已中止的 signal → 上抛 AbortError 且 agent_runs 标 stopped（停止语义，非失败）', async () => {
    const { storage, projectId } = await newProject();
    const controller = new AbortController();
    controller.abort();
    const error = await runPm({
      storage,
      projectId,
      requirement: '做一个待办清单',
      fast: false,
      signal: controller.signal,
    }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect((await firstRun(storage, projectId)).status).toBe('stopped');
  });
});

/* ------------------------------------------------------------------ */
/* 2. 架构师：8 段结构化单发 + file_tree 解析                            */
/* ------------------------------------------------------------------ */
describe('runArchitect（mock）', () => {
  it('产出 8 个 docs 文件（system_design + 5 张 .mmd + file_tree.md/json），fileTree 解析出 nodes 带 depends', async () => {
    const { storage, projectId } = await newProject();
    // 上游交接物：先落 PRD（架构师按需重读文件，规则 7）
    await storage.upsertFile({ projectId, path: PRD_PATH, content: readSample('prd.md'), editor: 'pm' });

    const result = await runArchitect({ storage, projectId });

    expect(result.runId).toBeGreaterThan(0);
    expect([...result.files].sort()).toEqual([...ARCHITECT_DOC_PATHS].sort());
    expect(result.files).toHaveLength(8);

    // 逐文件落库且 editor=architect
    for (const path of result.files) {
      const row = await storage.getFile(projectId, path);
      expect(row?.lastEditor).toBe('architect');
      expect(row?.content.length).toBeGreaterThan(0);
    }
    // system_design 段正文与样例一致（mock 端到端：分段切分正确）
    expect((await storage.getFile(projectId, 'docs/system_design.md'))?.content).toBe(sampleSegment('docs/system_design.md'));
    // 机读 file_tree.json 与返回的 fileTree 一致
    const jsonRow = await storage.getFile(projectId, 'docs/file_tree.json');
    expect(JSON.parse(jsonRow?.content ?? 'null')).toEqual(result.fileTree);

    // fileTree：5 节点，index.html 依赖 api.js
    expect(result.fileTree).toHaveLength(5);
    const index = result.fileTree.find((n) => n.path === 'app/frontend/index.html');
    expect(index?.depends).toContain('app/backend/api.js');
    for (const node of result.fileTree) {
      expect(typeof node.path).toBe('string');
      expect(typeof node.desc).toBe('string');
      expect(Array.isArray(node.depends)).toBe(true);
    }

    const run = await firstRun(storage, projectId);
    expect(run.id).toBe(result.runId);
    expect(run.taskKey).toBe(ARCHITECT_TASK_KEY);
    expect(run.agent).toBe('architect');
    expect(run.status).toBe('done');
    expect(run.summary ?? '').not.toBe('');
    expect(run.error).toBeNull();
  });

  it('run.summary 序列化 FileTree，可经 parseFileTree 还原（编排器断点续跑的交接物）', async () => {
    const { storage, projectId } = await newProject();
    await storage.upsertFile({ projectId, path: PRD_PATH, content: readSample('prd.md'), editor: 'pm' });
    const result = await runArchitect({ storage, projectId });

    const run = await firstRun(storage, projectId);
    expect(fileTreeFromSummary(run.summary ?? '')).toEqual(result.fileTree);
    const raw = JSON.stringify(fileTreeFromSummary(run.summary ?? ''));
    const parsed = parseFileTree(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.tree).toEqual(result.fileTree);
  });

  it('架构师角色标记契约：prompt + PRD 正文命中 mock 的 architect 场景（不被 PRD 用词带偏）', () => {
    const scene = detectScene({
      model: 'mock-model',
      messages: [
        { role: 'system', content: architectSystemPrompt() },
        { role: 'user', content: `【上游 PRD】\n${readSample('prd.md')}\n【任务】产出系统设计与 file_tree。` },
      ],
      tools: [],
    });
    expect(scene).toBe('architect');
  });

  it('输出缺图（只有 system_design/file_tree 三段）→ 不抛错，缺什么少什么，warning 进 summary', async () => {
    const { storage, projectId } = await newProject();
    await storage.upsertFile({ projectId, path: PRD_PATH, content: readSample('prd.md'), editor: 'pm' });

    const partial = [
      `===== docs/system_design.md =====`,
      sampleSegment('docs/system_design.md'),
      `===== docs/file_tree.md =====`,
      sampleSegment('docs/file_tree.md'),
      `===== docs/file_tree.json =====`,
      JSON.stringify(JSON.parse(readSample('filetree.json')), null, 2),
      '',
    ].join('\n');

    const result = await runArchitect({ storage, projectId, provider: new FakeProvider(partial) });
    expect(result.files).toEqual(['docs/system_design.md', 'docs/file_tree.md', 'docs/file_tree.json']);
    expect(result.fileTree).toHaveLength(5); // file_tree.json 在 → 树照常解析

    const run = await firstRun(storage, projectId);
    expect(run.status).toBe('done');
    expect(run.summary ?? '').toContain('缺失');
    expect(run.summary ?? '').toContain('docs/architecture.mmd');
  });

  it('输出完全为空 → 补发也空手而归 → 不抛错：0 文件、fileTree 空数组、warning 记录', async () => {
    const { storage, projectId } = await newProject();
    const result = await runArchitect({ storage, projectId, provider: new FakeProvider('  \n\n ', '还是什么都没有') });
    expect(result.files).toEqual([]);
    expect(result.fileTree).toEqual([]);
    const run = await firstRun(storage, projectId);
    expect(run.status).toBe('done');
    expect(run.summary ?? '').toContain('缺失');
  });

  it('分段路径过沙箱：`docs/../escape.md` 段被拒（不落库）且记录 warning，其余段照常', async () => {
    const { storage, projectId } = await newProject();
    const evil = [
      '===== docs/../escape.md =====',
      '# 越权内容',
      `===== docs/file_tree.json =====`,
      JSON.stringify(
        [
          { path: 'app/frontend/index.html', desc: '待办单页', depends: ['app/backend/api.js'] },
          { path: 'app/backend/api.js', desc: '内存态后端', depends: [] },
        ],
        null,
        2,
      ),
      '',
    ].join('\n');

    const result = await runArchitect({ storage, projectId, provider: new FakeProvider(evil) });
    expect(result.files).toEqual(['docs/file_tree.json']);
    expect(await storage.getFile(projectId, 'escape.md')).toBeNull();
    expect(await storage.getFile(projectId, 'docs/../escape.md')).toBeNull();
    expect(result.fileTree).toHaveLength(2);
    const run = await firstRun(storage, projectId);
    expect(run.summary ?? '').toContain('docs/../escape.md');
  });

  it('点开头的伪段头（../x.md）不再是段头：不落库，且以可追溯片段进告警', async () => {
    const { storage, projectId } = await newProject();
    const output = ['===== ../escape.md =====', '# 越权内容', ''].join('\n');
    const result = await runArchitect({ storage, projectId, provider: new FakeProvider(output) });

    expect(result.files).toEqual([]);
    expect(await storage.getFile(projectId, 'escape.md')).toBeNull();
    const summary = (await firstRun(storage, projectId)).summary ?? '';
    expect(summary).toContain('未归属任何交付物');
    expect(summary).toContain('../escape.md');
  });

  it('file_tree.json 段非法 JSON → fileTree 为空数组 + warning，仍不抛错', async () => {
    const { storage, projectId } = await newProject();
    const broken = ['===== docs/file_tree.json =====', '{ 不是 JSON', ''].join('\n');
    const result = await runArchitect({ storage, projectId, provider: new FakeProvider(broken) });
    expect(result.files).toEqual(['docs/file_tree.json']);
    expect(result.fileTree).toEqual([]);
    expect((await firstRun(storage, projectId)).summary ?? '').toContain('docs/file_tree.json');
  });

  it('契约外路径段（docs/random.md）→ 跳过并记录 warning（确定性代码锁定交付物清单）', async () => {
    const { storage, projectId } = await newProject();
    const extra = ['===== docs/random.md =====', '# 计划外', ''].join('\n');
    const result = await runArchitect({ storage, projectId, provider: new FakeProvider(extra) });
    expect(result.files).toEqual([]);
    expect(await storage.getFile(projectId, 'docs/random.md')).toBeNull();
    expect((await firstRun(storage, projectId)).summary ?? '').toContain('docs/random.md');
  });

  it('分隔头误报防护：裸等号线与中文标题行不切分，正文归属上一段（不丢内容、无误报警告）', async () => {
    const { storage, projectId } = await newProject();
    const output = [
      '===== docs/file_tree.md =====',
      '# 文件树（人读版）',
      '',
      '=======',
      '分隔说明（真实模型常见的裸等号线，旧实现会被当成路径 =）',
      '',
      '===== 小结 =====',
      '本节是正文小节，不是文件分段。',
      '',
      '===== docs/file_tree.json =====',
      JSON.stringify([{ path: 'app/frontend/index.html', desc: '待办单页', depends: ['app/backend/api.js'] }], null, 2),
      '',
    ].join('\n');

    const result = await runArchitect({ storage, projectId, provider: new FakeProvider(output) });
    expect(result.files).toEqual(['docs/file_tree.md', 'docs/file_tree.json']);

    const md = await storage.getFile(projectId, 'docs/file_tree.md');
    expect(md?.content).toContain('=======');
    expect(md?.content).toContain('===== 小结 =====');
    expect(md?.content).toContain('本节是正文小节，不是文件分段。');
    // 两行都留在上一段正文里 → 既没有内容被丢，也没有“契约外路径被拒”的误导告警
    expect((await firstRun(storage, projectId)).summary ?? '').not.toContain('契约外');
  });
});

/* ------------------------------------------------------------------ */
/* 3. 架构师：机读树补发修复（三段式第 2 步，2026-09-06 线上案例）        */
/* ------------------------------------------------------------------ */

/** 首调返回截断产出、第二次（补发）直接抛错的桩：验证补发失败不炸 run */
class FlakyOnSecondProvider implements LlmProvider {
  readonly name = 'flaky';
  readonly requests: LlmRequest[] = [];
  private calls = 0;

  constructor(private readonly first: string) {}

  async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
    this.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    this.calls += 1;
    if (this.calls > 1) throw new Error('补发调用网络炸了');
    onDelta(this.first);
    return { content: this.first, toolCalls: [], usage: null };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.stream(req, () => undefined);
  }
}

describe('runArchitect：单发截断缺机读树 → 补发窄调用修复', () => {
  /** 线上案例形态：前几段完整、末尾的 file_tree.md/json 双缺（输出预算被图与设计文档吃光） */
  const TRUNCATED = [
    '===== docs/system_design.md =====',
    sampleSegment('docs/system_design.md'),
    '===== docs/architecture.mmd =====',
    sampleSegment('docs/architecture.mmd'),
    '',
  ].join('\n');

  const TREE_JSON = JSON.stringify(JSON.parse(readSample('filetree.json')), null, 2);

  it('补发成功：树落库（editor=architect）、fileTree 非空、summary 留修复痕（不静默吞）', async () => {
    const { storage, projectId } = await newProject();
    await storage.upsertFile({ projectId, path: PRD_PATH, content: readSample('prd.md'), editor: 'pm' });
    const provider = new FakeProvider(TRUNCATED, `\`\`\`json\n${TREE_JSON}\n\`\`\``);

    const result = await runArchitect({ storage, projectId, provider });

    expect(result.fileTree).toHaveLength(5);
    expect(result.files).toContain('docs/file_tree.json');
    const row = await storage.getFile(projectId, 'docs/file_tree.json');
    expect(row?.lastEditor).toBe('architect');
    expect(JSON.parse(row?.content ?? 'null')).toEqual(result.fileTree);

    const run = await firstRun(storage, projectId);
    expect(run.status).toBe('done');
    expect(run.summary ?? '').toContain('补发');
    expect(run.summary ?? '').not.toContain('空数组');

    // 补发是窄契约：只谈树、不带 8 段分段协议；user 带已落库设计与 PRD 作依据
    const repairSystem = provider.requests[1]?.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(repairSystem).toContain('file_tree');
    expect(repairSystem).toContain('只输出');
    expect(repairSystem).not.toContain('8 段');
    const repairUser = provider.requests[1]?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(repairUser).toContain('PRD');
  });

  it('补发返回垃圾 → 维持降级：fileTree 空数组、warning 记补发失败与空数组提示、run 仍 done', async () => {
    const { storage, projectId } = await newProject();
    const provider = new FakeProvider(TRUNCATED, '抱歉，这一轮我给不出树。');
    const result = await runArchitect({ storage, projectId, provider });

    expect(result.fileTree).toEqual([]);
    expect(result.files).not.toContain('docs/file_tree.json');
    const run = await firstRun(storage, projectId);
    expect(run.status).toBe('done');
    expect(run.summary ?? '').toContain('补发');
    expect(run.summary ?? '').toContain('空数组');
  });

  it('补发 provider 抛错 → 不炸 run：吞成 warning（停止语义除外），降级契约不变', async () => {
    const { storage, projectId } = await newProject();
    const provider = new FlakyOnSecondProvider(TRUNCATED);
    const result = await runArchitect({ storage, projectId, provider });

    expect(result.fileTree).toEqual([]);
    const run = await firstRun(storage, projectId);
    expect(run.status).toBe('done');
    expect(run.summary ?? '').toContain('补发');
    expect(run.summary ?? '').toContain('空数组');
  });
});
