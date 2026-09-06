/**
 * 领导角色（Task 11，DESIGN §3.1 意图路由 + 动态分派 / §3.4 可靠性三段式）。
 *
 * 职责边界（CLAUDE.md 规则 1：LLM 只做决策，确定性代码做执行）：
 * - LLM：读用户消息决定「派哪些任务（assign_task）/直接回答（reply_to_user）/结束（finish）」
 * - 代码：@ 指定成员直派（省一次 LLM 调用）、工具结果收集，以及 LLM 失败或空手而归时的
 *   「默认流水线」回退（三段式第 3 步）。任务怎么拆是模型的事，回退到哪条链是代码的事。
 *
 * 工具是**收集器**：assign_task/reply_to_user/finish 只往内存 collector 里登记，不落库、
 * 不碰虚拟文件系统——agent_runs 落库与 DAG 调度由编排器（Task 10）接手。
 *
 * 良构 DAG 保证：重复 task_key / 自引用在收集时当场拒绝并回喂（ok=false，模型下一轮自纠）；
 * 前向引用（同轮内后登记的 task_key）合法；悬空 depends_on 在返回决策前剔除（只删边不删任务），
 * 编排器拿到的依赖恒指向本轮已登记的任务。
 *
 * 回退语义（三段式第 3 步，DESIGN §3.4）：
 * - runAgent 抛错（校验重试耗尽 / 步数超限 / provider 失败 / provider 配置缺失）
 *   或「零任务且无 reply」→ 默认流水线：
 *     full = pm-prd → arch-design → eng-code（链式 dependsOn）
 *     fast = pm-lite → eng-code
 *     迭代场景（项目已有文件且消息含 改/加/换/调整，或消息 < 12 字）→ 仅 eng-iterate（指令=用户原话）
 * - 中止（AbortError）是停止语义，原样上抛——用户叫停后不得继续烧 LLM 跑回退流水线
 *
 * 服务端专用（读 env + 计量落库），不得进入客户端 bundle。
 */
import { z } from 'zod';
import { resolveModel } from '@/lib/llm/client';
import { wrapMetered } from '@/lib/llm/metered-provider';
import type { LlmProvider } from '@/lib/llm/types';
import type { AgentRole, StorageProvider } from '@/lib/db/provider/types';
import { formatZodIssues, type JSONSchema, type Tool, type ToolContext } from '@/lib/agents/tools';
import { runAgent } from '@/lib/agents/runner';
import { AgentAbortError } from '@/lib/agents/types';

/** 可被分派的角色（DESIGN §3.1：assign_task 的 agent 枚举，不含领导自身） */
const ASSIGNABLE_ROLES = ['pm', 'architect', 'engineer', 'analyst', 'seo', 'ads'] as const;
type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** 一次任务分派（编排器据此建 agent_runs 并按 dependsOn 拓扑排序） */
export interface TaskAssignment {
  taskKey: string;
  agent: AgentRole;
  instruction: string;
  writesPaths: string[];
  dependsOn: string[];
}

/** 领导决策：任务 DAG（可附带给用户的一句话）或纯回答 */
export type LeaderDecision =
  | { kind: 'tasks'; tasks: TaskAssignment[]; reply?: string }
  | { kind: 'reply'; reply: string };

/** routeLeader 入参（provider 供测试/编排器注入，缺省 getLlmProvider()，仍经 wrapMetered 计量） */
export interface RouteLeaderInput {
  storage: StorageProvider;
  projectId: number;
  userMessage: string;
  mode: 'fast' | 'full';
  /** @ 指定成员（非空则绕过 LLM 路由直派，DESIGN §3.1） */
  mentions: AgentRole[];
  /** 项目是否已有生成文件（迭代 vs 新建的判定输入，由调用方按 files 表给出） */
  hasFiles: boolean;
  signal?: AbortSignal;
  provider?: LlmProvider;
  /** 思考流透传（编排器接 SSE reasoning 事件用，T31）；缺省不透传，行为不变 */
  onReasoning?: (text: string) => void;
}

/* ------------------------------------------------------------------ */
/* 系统提示词（含 mock 路由依赖的「团队领导」角色标识）                    */
/* ------------------------------------------------------------------ */

/**
 * 领导 system prompt：7 角色职责表 + 四类意图 + assign_task 契约 + 模式说明。
 * 注意：角色标识「团队领导」必须原样出现（mock provider 按角色标记路由）；
 * 不写收尾/总结类措辞，避免被 mock 误判成「领导收尾汇报」场景。
 */
export const LEADER_SYSTEM_PROMPT = [
  '你是「团队领导」（leader），多智能体团队的总调度：只做意图路由与任务分派，不亲自产出文档或代码。',
  '',
  '【团队职责表】',
  '- 团队领导（leader，你自身）：理解需求、拆解任务、用 depends_on 编排执行顺序',
  '- 产品经理（pm）：产出 PRD（背景目标、功能清单、用户故事、验收标准），写入 docs/',
  '- 架构师（architect）：产出系统设计、mermaid 架构图与 file_tree（docs/file_tree.json），写入 docs/',
  '- 工程师（engineer）：按 file_tree 逐文件实现全栈应用（app/backend/api.js 同构 handle + 单页前端），写入 app/',
  '- 数据分析师（analyst）：埋点方案与数据洞察',
  '- SEO 专家（seo）：关键词与搜索优化建议',
  '- 广告投放专家（ads）：投放策略与转化目标',
  '',
  '【四类意图 → 路由】',
  '1. 新建需求 → 任务 DAG：pm → architect → engineer 串行接力（多次 assign_task + depends_on）',
  '2. 迭代修改（项目已有文件的小改动）→ 只派 engineer，指令写清改动点',
  '3. 咨询问答（不需要产出文件）→ reply_to_user 直接回答，本轮结束',
  '4. 单领域专项 → 只派对应专家（analyst / seo / ads）',
  '',
  '【assign_task 契约】一次调用 = 一个任务，可多次调用：',
  '- task_key：你自拟的短标识（如 "pm-prd"），全轮唯一，供 depends_on 引用',
  '- agent：pm | architect | engineer | analyst | seo | ads（不能是 leader 自身）',
  '- instruction：该角色的目标与边界。任务之间不共享历史，指令必须自包含（含必要的用户需求细节）',
  '- writes_paths：预估写路径前缀数组（如 ["docs/"]、["app/frontend/"]），仅用于校验与展示',
  '- depends_on：前置任务的 task_key 列表（可省略）；被依赖的任务会先执行',
  '',
  '【模式说明】快速模式走精简链路（pm 出半页精简 PRD → 工程师按内置模板直接实现）；',
  '完整模式走完整文档链（PRD → 系统设计与 file_tree → 工程师逐文件实现）。',
  '按当前模式控制任务粒度与 instruction 的详略。',
  '',
  '【结束】分派完毕（或无需分派）时调用 finish()；不需要产出文件的问题用 reply_to_user()。',
  '语言路由：用户明确要求 TypeScript/Python 时，在交接 summary 写明「后端语言=typescript|python」，架构师据此定后端入口后缀；未写明默认 JavaScript。',
].join('\n');

/* ------------------------------------------------------------------ */
/* 工具协议（zod schema 与 DESIGN §3.1 一致）                           */
/* ------------------------------------------------------------------ */

const assignTaskSchema = z.object({
  task_key: z.string().min(1).max(64).describe('任务短标识（自拟，如 "pm-prd"），全轮唯一，供 depends_on 引用'),
  agent: z.enum(ASSIGNABLE_ROLES).describe('承接角色（不含领导自身）'),
  instruction: z
    .string()
    .min(1)
    .max(4000)
    .describe('任务指令：该角色的目标与边界；任务间不共享历史，必须自包含'),
  writes_paths: z.array(z.string().min(1)).max(24).describe('预估写路径前缀，如 ["docs/"]、["app/frontend/"]'),
  depends_on: z.array(z.string().min(1)).max(24).optional().describe('前置任务的 task_key 列表，可省略'),
});

const replyToUserSchema = z.object({
  content: z.string().min(1).max(8000).describe('给用户的直接回答'),
});

const finishSchema = z.object({}).describe('无需参数：宣告本轮分派结束');

/** 工具结果收集器（工具不落库，登记结果由本模块返回给编排器） */
interface LeaderCollector {
  tasks: TaskAssignment[];
  reply: string | null;
  /** reply_to_user / finish 之后本轮收口，后续任务不再登记 */
  closed: boolean;
}

/**
 * 收集型工具工厂：包一层「zod 校验 + parameters 派生」，实现只写登记逻辑。
 * 与 fs-tools 的 defineTool 同构但本地保留——领导工具不触存储，不为此扩宽 T7 的公共出口。
 */
function defineCollectorTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  execute(args: z.infer<S>): Promise<{ ok: boolean; output: string }>;
}): Tool {
  const parameters: JSONSchema = z.toJSONSchema(def.schema);
  delete parameters.$schema;
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    parameters,
    async execute(args: unknown): Promise<{ ok: boolean; output: string }> {
      const parsed = def.schema.safeParse(args);
      if (!parsed.success) return { ok: false, output: `参数校验失败：${formatZodIssues(parsed.error)}` };
      return def.execute(parsed.data);
    },
  };
}

/** 领导本轮的三个工具：登记任务 / 回答用户 / 宣告结束（全部写内存 collector） */
function createLeaderTools(collector: LeaderCollector): Tool[] {
  const assignTask = defineCollectorTool({
    name: 'assign_task',
    description: '分派一个子任务给团队成员（一次调用 = 一个任务，可多次调用）',
    schema: assignTaskSchema,
    async execute(args) {
      if (collector.closed) {
        return { ok: false, output: '本轮已收口（已回答用户或已宣告结束），该任务不再登记；如需追加请留给下一轮' };
      }
      // task_key 是 depends_on 的引用锚点，重复会让 DAG 歧义——当场拒绝并回喂，模型下一轮自纠
      if (collector.tasks.some((task) => task.taskKey === args.task_key)) {
        return { ok: false, output: `重复的 task_key：${args.task_key}（本轮内必须唯一），请换一个 task_key 重新分派` };
      }
      const deps = args.depends_on ?? [];
      if (deps.includes(args.task_key)) {
        return { ok: false, output: `任务 ${args.task_key} 的 depends_on 含自身引用：任务不能依赖自己，请去掉后重新分派` };
      }
      const assignment: TaskAssignment = {
        taskKey: args.task_key,
        agent: args.agent,
        instruction: args.instruction,
        writesPaths: args.writes_paths,
        dependsOn: deps,
      };
      collector.tasks.push(assignment);
      const depNote = assignment.dependsOn.length > 0 ? `，依赖 ${assignment.dependsOn.join('、')}` : '';
      return {
        ok: true,
        output: `已登记任务 ${assignment.taskKey}（角色：${assignment.agent}，写路径：${assignment.writesPaths.join('、')}${depNote}）`,
      };
    },
  });

  const replyToUser = defineCollectorTool({
    name: 'reply_to_user',
    description: '不需要产出文件时直接回答用户（回答后本轮结束）',
    schema: replyToUserSchema,
    async execute(args) {
      collector.reply = args.content;
      collector.closed = true;
      return { ok: true, output: '已把回答转达用户，本轮结束' };
    },
  });

  const finish = defineCollectorTool({
    name: 'finish',
    description: '宣告任务分派结束（无更多任务）',
    schema: finishSchema,
    async execute() {
      collector.closed = true;
      return { ok: true, output: '已确认任务分派结束' };
    },
  });

  return [assignTask, replyToUser, finish];
}

/* ------------------------------------------------------------------ */
/* 回退默认流水线（三段式第 3 步）                                       */
/* ------------------------------------------------------------------ */

/** 迭代消息判定：含改/加/换/调整，或短到不足以描述一个新需求 */
const ITERATION_PATTERN = /改|加|换|调整/;
const ITERATION_MAX_SHORT_LEN = 12;

function isIterationScenario(input: RouteLeaderInput): boolean {
  if (!input.hasFiles) return false;
  const text = input.userMessage.trim();
  return text.length < ITERATION_MAX_SHORT_LEN || ITERATION_PATTERN.test(text);
}

interface PipelineStep {
  taskKey: string;
  agent: AssignableRole;
  instruction: string;
  writesPaths: string[];
  dependsOn: string[];
}

/** full 模式默认链：pm-prd → arch-design → eng-code（链式 dependsOn） */
const FULL_PIPELINE: PipelineStep[] = [
  {
    taskKey: 'pm-prd',
    agent: 'pm',
    instruction: '基于用户需求产出完整 PRD（背景与目标、功能清单、用户故事、验收标准），写入 docs/prd.md',
    writesPaths: ['docs/'],
    dependsOn: [],
  },
  {
    taskKey: 'arch-design',
    agent: 'architect',
    instruction: '依据 docs/prd.md 产出系统设计与架构图，并给出 docs/file_tree.json（含每个文件的 depends 声明），写入 docs/system_design.md',
    writesPaths: ['docs/'],
    dependsOn: ['pm-prd'],
  },
  {
    taskKey: 'eng-code',
    agent: 'engineer',
    instruction: '按 docs/file_tree.json 逐文件实现全栈应用：后端是无框架同构模块 handle(method, path, body)，前端单页经 fetch 调用 /api/*，内存存态、禁用 localStorage',
    writesPaths: ['app/'],
    dependsOn: ['arch-design'],
  },
];

/** fast 模式默认链：pm-lite → eng-code（跳过完整文档链，DESIGN §3.8 快速模式） */
const FAST_PIPELINE: PipelineStep[] = [
  {
    taskKey: 'pm-lite',
    agent: 'pm',
    instruction: '用半页篇幅产出精简 PRD：只写功能清单与验收标准，写入 docs/prd.md',
    writesPaths: ['docs/'],
    dependsOn: [],
  },
  {
    taskKey: 'eng-code',
    agent: 'engineer',
    instruction: '按内置应用模板骨架直接生成单文件全栈应用（浏览器内后端 handle + 单页前端），跳过完整文档链',
    writesPaths: ['app/'],
    dependsOn: ['pm-lite'],
  },
];

/** 迭代默认：只派工程师，指令即用户原话（模型没说清就别替它编造需求） */
function iteratePipeline(input: RouteLeaderInput): TaskAssignment[] {
  return [
    {
      taskKey: 'eng-iterate',
      agent: 'engineer',
      instruction: input.userMessage,
      writesPaths: ['app/'],
      dependsOn: [],
    },
  ];
}

/** 回退决策（深拷贝常量链，避免调用方改到共享常量） */
function fallbackDecision(input: RouteLeaderInput): LeaderDecision {
  if (isIterationScenario(input)) return { kind: 'tasks', tasks: iteratePipeline(input) };
  const chain = input.mode === 'fast' ? FAST_PIPELINE : FULL_PIPELINE;
  return {
    kind: 'tasks',
    tasks: chain.map((step) => ({
      taskKey: step.taskKey,
      agent: step.agent,
      instruction: step.instruction,
      writesPaths: [...step.writesPaths],
      dependsOn: [...step.dependsOn],
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

/** user prompt：用户原话 + 模式与项目现状（迭代/新建的判定线索） */
function buildUserPrompt(input: RouteLeaderInput): string {
  const mode =
    input.mode === 'fast'
      ? '快速模式：精简 PRD → 工程师按内置模板直接实现'
      : '完整模式：PRD → 系统设计与 file_tree → 工程师逐文件实现';
  const state = input.hasFiles ? '项目已有生成文件（更可能是迭代修改）' : '项目还没有任何文件（更可能是新建需求）';
  return [
    '【用户消息】',
    input.userMessage,
    '',
    `【运行模式】${mode}`,
    `【项目现状】${state}`,
    '',
    '请决定：分派任务（assign_task，可多次）或直接回答（reply_to_user）。',
  ].join('\n');
}

/** 中止 = 停止语义（不回退）；其余失败 = 走三段式第 3 步 */
function isAbort(error: unknown): boolean {
  return error instanceof AgentAbortError || (error instanceof Error && error.name === 'AbortError');
}

/**
 * 依赖收口：只保留指向本轮已登记 task_key 的依赖，悬空引用剔除——保证返回给编排器的 DAG 良构
 * （前向引用合法：同轮内后登记的 task_key 也算已登记；剔除只删边不删任务，任务本身照常分派）。
 */
function stripDanglingDeps(tasks: TaskAssignment[]): TaskAssignment[] {
  const keys = new Set(tasks.map((task) => task.taskKey));
  return tasks.map((task) =>
    task.dependsOn.every((dep) => keys.has(dep)) ? task : { ...task, dependsOn: task.dependsOn.filter((dep) => keys.has(dep)) },
  );
}

/**
 * 领导路由：@ 覆盖直派 → LLM 工具循环收集 → 失败/空手而归时回退默认流水线。
 * 返回的 TaskAssignment 只描述分派意图，落库与调度由编排器负责。
 */
export async function routeLeader(input: RouteLeaderInput): Promise<LeaderDecision> {
  // @ 指定成员（DESIGN §3.1）：绕过领导 LLM 路由直接建任务，省一次调用；leader 不能派活给自己
  const mentions = input.mentions.filter((role): role is AssignableRole => role !== 'leader');
  if (mentions.length > 0) {
    return {
      kind: 'tasks',
      tasks: mentions.map((agent, index) => ({
        taskKey: `user-${agent}-${index}`,
        agent,
        instruction: input.userMessage,
        writesPaths: ['docs/', 'app/'],
        dependsOn: [],
      })),
    };
  }

  const collector: LeaderCollector = { tasks: [], reply: null, closed: false };
  try {
    // model 单一来源：runAgent 实际使用与 llm_calls 记账必须是同一个值（CLAUDE.md 规则 10）
    const model = resolveModel('leader');
    const provider = wrapMetered({
      storage: input.storage,
      projectId: input.projectId,
      agentRole: 'leader',
      model,
      provider: input.provider,
    });

    const ctx: ToolContext = { storage: input.storage, projectId: input.projectId, role: 'leader' };
    await runAgent({
      role: 'leader',
      systemPrompt: LEADER_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(input),
      tools: createLeaderTools(collector),
      model,
      provider,
      callbacks: input.onReasoning === undefined ? undefined : { onReasoning: input.onReasoning },
      ctx,
      signal: input.signal,
    });
  } catch (error) {
    if (isAbort(error)) throw error;
    // 不静默吞：留痕后回退（错误本身由编排器决定是否再进 agent_runs.error）
    console.error(`[leader] 路由失败，回退默认流水线：${error instanceof Error ? error.message : String(error)}`);
    return fallbackDecision(input);
  }

  if (collector.tasks.length > 0) {
    const tasks = stripDanglingDeps(collector.tasks);
    return collector.reply === null
      ? { kind: 'tasks', tasks }
      : { kind: 'tasks', tasks, reply: collector.reply };
  }
  if (collector.reply !== null) return { kind: 'reply', reply: collector.reply };

  // 模型既没派任务也没回答（如只调了 finish、或纯文本敷衍）→ 同样回退
  console.error('[leader] 领导未分派任何任务也未回答，回退默认流水线');
  return fallbackDecision(input);
}
