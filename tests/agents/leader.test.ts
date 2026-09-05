/**
 * 领导角色测试（Task 11，DESIGN §3.1 意图路由/@覆盖 / §3.4 可靠性三段式第 3 步回退）。
 * brief 原文用例 ①-③ 在前，补充用例 ④ fast 回退 / ⑤ 迭代回退 / ⑥ reply 路径 /
 * ⑦ mock 领导收尾轮（本轮新增的 mock 扩展：见 src/lib/llm/mock.ts leader 分支）。
 * provider 一律显式注入：mock（正常路径）或 FakeProvider（脚本化坏输出/空转），并断言计量落库。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEADER_SYSTEM_PROMPT,
  routeLeader,
  type RouteLeaderInput,
} from '@/lib/agents/roles/leader';
import { resolveModel } from '@/lib/llm/client';
import { createMockProvider } from '@/lib/llm/mock';
import { newTestStorage } from '@/lib/db/test-util';
import type { StorageProvider } from '@/lib/db/provider/types';
import type { LlmMessage, LlmProvider, LlmRequest, LlmResult, ToolCall } from '@/lib/llm/types';

/* ------------------------------------------------------------------ */
/* 测试工具                                                             */
/* ------------------------------------------------------------------ */

/** 脚本化一步：content/toolCalls 为该次 provider 调用的最终结果 */
interface ScriptedStep {
  content?: string;
  toolCalls?: ToolCall[];
}

/** 脚本耗尽即抛错（让"不该发生的 provider 调用"显式失败，而不是静默通过） */
class ScriptExhaustedError extends Error {
  constructor() {
    super('FakeProvider 脚本已耗尽（provider 被意外调用）');
    this.name = 'ScriptExhaustedError';
  }
}

/** 测试桩 provider：按脚本依次返回，并记录每次收到的请求（供零调用断言） */
class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly requests: LlmRequest[] = [];
  /** 钩子：每次 stream 被调用时触发（用于模拟「跑到一半用户点了停止」） */
  onStream?: (req: LlmRequest) => void;
  private readonly script: ScriptedStep[];
  private cursor = 0;

  constructor(...steps: ScriptedStep[]) {
    this.script = steps;
  }

  async stream(req: LlmRequest): Promise<LlmResult> {
    this.requests.push({ ...req, messages: req.messages.map((message) => ({ ...message })) });
    this.onStream?.(req);
    const step = this.script[this.cursor];
    this.cursor += 1;
    if (step === undefined) throw new ScriptExhaustedError();
    return { content: step.content ?? '', toolCalls: step.toolCalls ?? [], usage: null };
  }

  async complete(req: LlmRequest): Promise<LlmResult> {
    return this.stream(req);
  }
}

/** 给任意 provider 套一层调用记录（mock 是工厂产物，无法直接观察调用次数） */
function spyProvider(inner: LlmProvider): { provider: LlmProvider; requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  const record = (req: LlmRequest): LlmRequest => {
    requests.push({ ...req, messages: req.messages.map((message) => ({ ...message })) });
    return req;
  };
  return {
    requests,
    provider: {
      name: inner.name,
      async complete(req: LlmRequest): Promise<LlmResult> {
        return inner.complete(record(req));
      },
      async stream(req: LlmRequest, onDelta: (text: string) => void): Promise<LlmResult> {
        return inner.stream(record(req), onDelta);
      },
    },
  };
}

/** 独立内存库 + 项目（默认 full 模式） */
async function newProject(mode: 'fast' | 'full' = 'full'): Promise<{
  storage: StorageProvider;
  projectId: number;
}> {
  const storage = newTestStorage();
  const project = await storage.createProject({
    sessionId: 's',
    title: '待办应用',
    requirement: '做一个待办事项应用',
    mode,
  });
  return { storage, projectId: project.id };
}

/** routeLeader 入参基线（可按用例覆盖） */
function baseInput(
  storage: StorageProvider,
  projectId: number,
  overrides: Partial<RouteLeaderInput> = {},
): RouteLeaderInput {
  return {
    storage,
    projectId,
    userMessage: '做一个待办事项应用',
    mode: 'full',
    mentions: [],
    hasFiles: false,
    ...overrides,
  };
}

/** 统一收窄 decisions（测试内避免可空索引/联合类型判别噪音） */
function taskKeys(decision: Awaited<ReturnType<typeof routeLeader>>): string[] {
  if (decision.kind !== 'tasks') throw new Error(`预期 kind='tasks'，实际 ${decision.kind}`);
  return decision.tasks.map((task) => task.taskKey);
}

/** 同上，取完整任务列表（供 dependsOn 断言） */
function tasksOf(decision: Awaited<ReturnType<typeof routeLeader>>) {
  if (decision.kind !== 'tasks') throw new Error(`预期 kind='tasks'，实际 ${decision.kind}`);
  return decision.tasks;
}

/** 第 index 次请求里回喂给模型的 tool 结果文本（断言「拒绝说明」有没有进历史） */
function toolFeedbackAt(provider: FakeProvider, index: number): string {
  const req = provider.requests[index];
  if (req === undefined) throw new Error(`预期 provider 至少被调用 ${index + 1} 次，实际 ${provider.requests.length}`);
  return req.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content)
    .join('\n');
}

/** 统一捕获：unknown → Error（断言用） */
async function catchError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error('预期 routeLeader 抛错，但正常返回了决策');
}

/* ------------------------------------------------------------------ */
/* brief 原文用例 ①-③                                                  */
/* ------------------------------------------------------------------ */

describe('routeLeader：@ 指定成员直派（绕过 LLM）', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_MOCK_DELAY_MS', '0'); // mock 流式延迟置 0，离线快速
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('① mentions=[engineer] → 不调 LLM 直出任务（provider 零调用、零计量）', async () => {
    const { storage, projectId } = await newProject();
    const provider = new FakeProvider(); // 空脚本：一旦被调用立即抛 ScriptExhaustedError
    const decision = await routeLeader(baseInput(storage, projectId, { mentions: ['engineer'], provider }));

    expect(decision).toEqual({
      kind: 'tasks',
      tasks: [
        {
          taskKey: 'user-engineer-0',
          agent: 'engineer',
          instruction: '做一个待办事项应用',
          writesPaths: ['docs/', 'app/'],
          dependsOn: [],
        },
      ],
    });
    expect(provider.requests).toHaveLength(0);
    expect(await storage.usageByProject(projectId)).toEqual([]);
  });

  it('① 多个 mentions 按序直派（dependsOn 留空，串行接力交给编排器）', async () => {
    const { storage, projectId } = await newProject();
    const decision = await routeLeader(
      baseInput(storage, projectId, { mentions: ['pm', 'engineer'], provider: new FakeProvider() }),
    );
    expect(taskKeys(decision)).toEqual(['user-pm-0', 'user-engineer-1']);
    if (decision.kind === 'tasks') {
      expect(decision.tasks.map((task) => task.agent)).toEqual(['pm', 'engineer']);
      expect(decision.tasks.every((task) => task.dependsOn.length === 0)).toBe(true);
    }
  });

  it('① mentions 里的 leader 被过滤：过滤后非空按剩余直派，全为 leader 则走 LLM 路由', async () => {
    const { storage, projectId } = await newProject();
    // 只 @ 了领导自己 → 领导不派活给自己，退回 LLM 路由（mock → 3 任务链）
    const spy = spyProvider(createMockProvider());
    const selfMention = await routeLeader(
      baseInput(storage, projectId, { mentions: ['leader'], provider: spy.provider }),
    );
    expect(taskKeys(selfMention)).toEqual(['pm-prd', 'architect-design', 'engineer-app']);

    // 混合 @ → 只保留可分派角色，索引按过滤后的顺序生成
    const mixed = await routeLeader(
      baseInput(storage, projectId, { mentions: ['leader', 'seo'], provider: new FakeProvider() }),
    );
    expect(taskKeys(mixed)).toEqual(['user-seo-0']);
  });
});

describe('routeLeader：LLM 路由与回退（DESIGN §3.4）', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('② mock 领导正常分派：3 任务串行链（dependsOn 链正确），收尾轮后收敛', async () => {
    const { storage, projectId } = await newProject('full');
    const spy = spyProvider(createMockProvider());
    const decision = await routeLeader(baseInput(storage, projectId, { provider: spy.provider }));

    // 两轮：分派轮（assign_task×3）+ 收尾轮（mock 对 tool 结果回喂返回纯文本，runner 终止）
    expect(spy.requests).toHaveLength(2);
    expect(decision).toEqual({
      kind: 'tasks',
      tasks: [
        { taskKey: 'pm-prd', agent: 'pm', instruction: expect.any(String), writesPaths: ['docs/'], dependsOn: [] },
        {
          taskKey: 'architect-design',
          agent: 'architect',
          instruction: expect.any(String),
          writesPaths: ['docs/'],
          dependsOn: ['pm-prd'],
        },
        {
          taskKey: 'engineer-app',
          agent: 'engineer',
          instruction: expect.any(String),
          writesPaths: ['app/', 'start_app.sh'],
          dependsOn: ['architect-design'],
        },
      ],
    });

    // 首轮请求：工具声明齐全，system prompt 带领导标识
    const first = spy.requests[0];
    expect(first?.tools?.map((tool) => tool.name)).toEqual(['assign_task', 'reply_to_user', 'finish']);
    expect(first?.messages[0]?.role).toBe('system');
    expect(first?.messages[0]?.content).toContain('团队领导');

    // 计量契约：model 与 runAgent 同源（resolveModel('leader')），两次调用各落一条 llm_calls
    expect(await storage.usageByProject(projectId)).toEqual([
      { agentRole: 'leader', model: resolveModel('leader'), tokens: expect.any(Number), calls: 2 },
    ]);
  });

  it('③ 模型持续坏输出（校验重试耗尽）→ 三段式第 3 步：回退 full 默认流水线 3 任务', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'assign_task', args: { task_key: '', agent: 'ceo', instruction: '' } }] },
      { toolCalls: [{ id: 'c2', name: 'assign_task', args: { task_key: 'x' } }] },
    );
    const decision = await routeLeader(baseInput(storage, projectId, { provider }));

    expect(taskKeys(decision)).toEqual(['pm-prd', 'arch-design', 'eng-code']);
    if (decision.kind === 'tasks') {
      expect(decision.tasks.map((task) => task.agent)).toEqual(['pm', 'architect', 'engineer']);
      expect(decision.tasks.map((task) => task.dependsOn)).toEqual([[], ['pm-prd'], ['arch-design']]);
    }
    expect(provider.requests).toHaveLength(2); // 一次回喂重试后终止，未继续烧 token
  });

  it('③ provider 工厂配置错误（env 指向未知 provider）→ 同样回退默认流水线', async () => {
    vi.stubEnv('LLM_PROVIDER', 'nope');
    const { storage, projectId } = await newProject('full');
    const decision = await routeLeader(baseInput(storage, projectId));
    expect(taskKeys(decision)).toEqual(['pm-prd', 'arch-design', 'eng-code']);
  });
});

/* ------------------------------------------------------------------ */
/* 补充用例 ④-⑦                                                        */
/* ------------------------------------------------------------------ */

describe('routeLeader：回退流水线变体', () => {
  beforeEach(() => {
    vi.stubEnv('LLM_MOCK_DELAY_MS', '0');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('④ fast 模式回退 2 任务：pm-lite → eng-code', async () => {
    const { storage, projectId } = await newProject('fast');
    const provider = new FakeProvider({ content: '（模型没派任务也没回答）' }); // 零任务且无 reply → 回退
    const decision = await routeLeader(baseInput(storage, projectId, { mode: 'fast', provider }));

    expect(taskKeys(decision)).toEqual(['pm-lite', 'eng-code']);
    if (decision.kind === 'tasks') {
      expect(decision.tasks.map((task) => task.dependsOn)).toEqual([[], ['pm-lite']]);
    }
  });

  it('⑤ 迭代场景回退 eng-iterate：已有文件 + 消息含"改"/消息很短 → 只派工程师且指令=用户原话', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider({ content: '（模型没派任务也没回答）' });

    const byKeyword = await routeLeader(
      baseInput(storage, projectId, { hasFiles: true, userMessage: '把提交按钮改成绿色', provider }),
    );
    expect(byKeyword).toEqual({
      kind: 'tasks',
      tasks: [
        { taskKey: 'eng-iterate', agent: 'engineer', instruction: '把提交按钮改成绿色', writesPaths: ['app/'], dependsOn: [] },
      ],
    });

    // 短消息分支（< 12 字）同样视为迭代
    const short = await routeLeader(
      baseInput(storage, projectId, { hasFiles: true, userMessage: '微调一下', provider }),
    );
    expect(taskKeys(short)).toEqual(['eng-iterate']);

    // 反例：项目还没有文件时，同样的消息按新建需求走完整流水线
    const fresh = await routeLeader(
      baseInput(storage, projectId, { hasFiles: false, userMessage: '把提交按钮改成绿色', provider }),
    );
    expect(taskKeys(fresh)).toEqual(['pm-prd', 'arch-design', 'eng-code']);
  });

  it('⑥ reply_to_user → 直接回答（咨询意图不产任务、不回退）', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'reply_to_user', args: { content: '待办应用通常按「收件箱/今天/本周」组织。' } }] },
      { content: '已回答用户' },
    );
    const decision = await routeLeader(baseInput(storage, projectId, { provider }));

    expect(decision).toEqual({ kind: 'reply', reply: '待办应用通常按「收件箱/今天/本周」组织。' });
    expect(provider.requests).toHaveLength(2);
  });

  it('⑥ 任务与回复并存 → kind=tasks 且带 reply（分派为主、回复为辅）', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider(
      {
        toolCalls: [
          { id: 'c1', name: 'assign_task', args: { task_key: 'eng-fix', agent: 'engineer', instruction: '修复列表滚动', writes_paths: ['app/'] } },
          { id: 'c2', name: 'reply_to_user', args: { content: '已派工程师修复，稍后汇报。' } },
        ],
      },
      { content: '分派完成' },
    );
    const decision = await routeLeader(baseInput(storage, projectId, { provider }));
    expect(decision).toEqual({
      kind: 'tasks',
      tasks: [{ taskKey: 'eng-fix', agent: 'engineer', instruction: '修复列表滚动', writesPaths: ['app/'], dependsOn: [] }],
      reply: '已派工程师修复，稍后汇报。',
    });
  });

  it('⑦ mock 领导收尾轮：消息已含 tool 结果 → 纯文本无工具调用（runner 得以终止）', async () => {
    const provider = createMockProvider();
    const messages: LlmMessage[] = [
      { role: 'system', content: LEADER_SYSTEM_PROMPT },
      { role: 'user', content: '做一个待办事项应用' },
      {
        role: 'assistant',
        content: '拆成 3 个任务',
        toolCalls: [{ id: 'c1', name: 'assign_task', args: { task_key: 'pm-prd' } }],
      },
      { role: 'tool', toolCallId: 'c1', content: '已登记任务 pm-prd（角色：pm）' },
    ];
    const result = await provider.complete({
      model: 'mock-model',
      messages,
      tools: [{ name: 'assign_task', description: '分派子任务', parameters: { type: 'object' } }],
    });
    expect(result.toolCalls).toEqual([]);
    expect(result.content.length).toBeGreaterThan(0);
  });
});

describe('领导 system prompt 契约', () => {
  it('含团队领导标识、7 角色职责、四类意图、assign_task 契约与模式说明', () => {
    expect(LEADER_SYSTEM_PROMPT).toContain('团队领导');
    for (const role of ['产品经理', '架构师', '工程师', '数据分析师', 'SEO', '广告投放']) {
      expect(LEADER_SYSTEM_PROMPT).toContain(role);
    }
    for (const keyword of ['assign_task', 'reply_to_user', 'finish', 'task_key', 'depends_on', '快速模式', '完整模式']) {
      expect(LEADER_SYSTEM_PROMPT).toContain(keyword);
    }
  });
});

/* ------------------------------------------------------------------ */
/* fix round 1：收集器 DAG 校验 + 停止语义不回退                          */
/* ------------------------------------------------------------------ */

describe('routeLeader：收集器 DAG 校验', () => {
  it('重复 task_key 当场拒绝并回喂，模型下一轮换 key 自纠', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider(
      {
        toolCalls: [
          { id: 'c1', name: 'assign_task', args: { task_key: 'eng-fix', agent: 'engineer', instruction: 'A', writes_paths: ['app/'] } },
          { id: 'c2', name: 'assign_task', args: { task_key: 'eng-fix', agent: 'engineer', instruction: 'B', writes_paths: ['app/'] } },
        ],
      },
      {
        toolCalls: [
          { id: 'c3', name: 'assign_task', args: { task_key: 'eng-fix-2', agent: 'engineer', instruction: 'B 改个标识重派', writes_paths: ['app/'] } },
        ],
      },
      { content: '分派完成' },
    );
    const decision = await routeLeader(baseInput(storage, projectId, { provider }));

    // 重名的第二次调用未登记；模型换 key 后成功
    expect(taskKeys(decision)).toEqual(['eng-fix', 'eng-fix-2']);
    expect(toolFeedbackAt(provider, 1)).toContain('重复的 task_key：eng-fix');
  });

  it('自引用当场拒绝；前向引用（同轮稍后登记）保留', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider(
      {
        toolCalls: [
          { id: 'c1', name: 'assign_task', args: { task_key: 'a', agent: 'pm', instruction: 'x', writes_paths: ['docs/'], depends_on: ['a'] } },
          { id: 'c2', name: 'assign_task', args: { task_key: 'eng', agent: 'engineer', instruction: 'y', writes_paths: ['app/'], depends_on: ['arch'] } },
        ],
      },
      {
        toolCalls: [
          { id: 'c3', name: 'assign_task', args: { task_key: 'arch', agent: 'architect', instruction: 'z', writes_paths: ['docs/'] } },
        ],
      },
      { content: '分派完成' },
    );
    const decision = await routeLeader(baseInput(storage, projectId, { provider }));

    // 自引用的调用整条不登记；eng → arch 的前向引用在 arch 登记后成立
    expect(tasksOf(decision).map((task) => [task.taskKey, task.dependsOn])).toEqual([
      ['eng', ['arch']],
      ['arch', []],
    ]);
    expect(toolFeedbackAt(provider, 1)).toContain('不能依赖自己');
  });

  it('真正未知的依赖在返回前剔除（只删边不删任务，返回的 DAG 恒良构）', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider(
      {
        toolCalls: [
          { id: 'c1', name: 'assign_task', args: { task_key: 'x', agent: 'engineer', instruction: 'y', writes_paths: ['app/'], depends_on: ['ghost'] } },
        ],
      },
      { content: '分派完成' },
    );
    const decision = await routeLeader(baseInput(storage, projectId, { provider }));

    expect(tasksOf(decision)).toEqual([
      { taskKey: 'x', agent: 'engineer', instruction: 'y', writesPaths: ['app/'], dependsOn: [] },
    ]);
  });
});

describe('routeLeader：停止语义不回退', () => {
  it('预中止的 signal → 抛 name=AbortError，provider 零调用、决策从不产出', async () => {
    const { storage, projectId } = await newProject('full');
    const provider = new FakeProvider(); // 空脚本：一旦被调用立即抛错
    const controller = new AbortController();
    controller.abort();

    const error = await catchError(routeLeader(baseInput(storage, projectId, { signal: controller.signal, provider })));

    expect(error.name).toBe('AbortError');
    expect(provider.requests).toHaveLength(0);
    expect(await storage.usageByProject(projectId)).toEqual([]);
  });

  it('跑到一半中止 → 抛 AbortError 且不再发起下一次 provider 调用（不烧回退流水线）', async () => {
    const { storage, projectId } = await newProject('full');
    const controller = new AbortController();
    const provider = new FakeProvider(
      { toolCalls: [{ id: 'c1', name: 'assign_task', args: { task_key: 'eng', agent: 'engineer', instruction: 'y', writes_paths: ['app/'] } }] },
      { content: '不应到达' },
    );
    provider.onStream = () => controller.abort(); // 首次调用返回后立即中止

    const error = await catchError(
      routeLeader(baseInput(storage, projectId, { signal: controller.signal, provider })),
    );

    expect(error.name).toBe('AbortError');
    expect(provider.requests).toHaveLength(1);
    // 只有一次成功调用的计量，中止后没有为回退再烧 LLM
    expect(await storage.usageByProject(projectId)).toEqual([
      { agentRole: 'leader', model: resolveModel('leader'), tokens: expect.any(Number), calls: 1 },
    ]);
  });
});
