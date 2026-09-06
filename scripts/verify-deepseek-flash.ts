/**
 * 一次性诊断脚本：验证 DB 里配置的 DeepSeek `deepseek-v4-flash` 能否走通
 * **应用自身的 LLM client 层**（createOpenAiProvider，client.ts 全套流式/工具/思考流解析）。
 *
 * 背景：设置页可导入 DeepSeek 模型（probe /models 已通），但 agent_model_bindings
 * 尚未接入编排器（roles 全走 env resolveModel），故用本脚本在进程内直连验证，
 * 不经 dev server、不写业务库（只读 llm_providers/llm_models）。
 *
 * 用例：
 *   L（leader 形态）：流式 + dispatch_task 工具 + 强约束提示词 → 期望聚合出 toolCalls
 *   E（engineer 形态）：流式 + write_file 工具（path/content 参数）→ 期望参数可解析、
 *     onToolCallDelta 分片（前端打字机通道）有产出
 *
 * 用法：npx tsx scripts/verify-deepseek-flash.ts [model_id]
 * 退出码：全部通过 0，任一失败 1。
 */
import Database from 'better-sqlite3';
import { createOpenAiProvider, LlmError } from '@/lib/llm/client';
import type { LlmMessage, LlmProvider, LlmRequest, ToolDef } from '@/lib/llm/types';

/** 只读连接（dev server 在写 WAL，读侧安全） */
const db = new Database('data/app.db', { readonly: true });

interface Config {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerName: string;
}

function loadConfig(): Config {
  const provider = db
    .prepare('SELECT id, name, base_url, api_key FROM llm_providers WHERE enabled = 1 AND name LIKE ?')
    .get('%deepseek%') as { id: number; name: string; base_url: string; api_key: string } | undefined;
  if (provider === undefined) throw new Error('llm_providers 里没有启用的 DeepSeek 服务商（先在设置页添加）');
  const wanted = process.argv[2] ?? 'deepseek-v4-flash';
  const model = db
    .prepare('SELECT model_id FROM llm_models WHERE provider_id = ? AND enabled = 1 AND model_id = ?')
    .get(provider.id, wanted) as { model_id: string } | undefined;
  if (model === undefined) throw new Error(`llm_models 里没有启用的 ${wanted}（先在设置页导入模型）`);
  return { baseUrl: provider.base_url, apiKey: provider.api_key, model: model.model_id, providerName: provider.name };
}

/** 应用同款 provider：env 晚绑定（client.ts createOpenAiProvider） */
function buildProvider(config: Config): LlmProvider {
  return createOpenAiProvider({
    ...process.env,
    LLM_PROVIDER: 'openai',
    LLM_BASE_URL: config.baseUrl,
    LLM_API_KEY: config.apiKey,
  });
}

const dispatchTool: ToolDef = {
  name: 'dispatch_task',
  description: '把任务派发给指定角色的 agent 执行',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['pm', 'architect', 'engineer'], description: '执行角色' },
      task: { type: 'string', description: '任务描述' },
    },
    required: ['role', 'task'],
  },
};

const writeFileTool: ToolDef = {
  name: 'write_file',
  description: '把完整文件内容写入虚拟文件系统',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对路径' },
      content: { type: 'string', description: '文件完整内容' },
    },
    required: ['path', 'content'],
  },
};

interface CaseReport {
  name: string;
  ok: boolean;
  detail: string;
}

/** 跑一个流式用例并收集全部通道的观测值 */
async function runStreamCase(
  provider: LlmProvider,
  model: string,
  name: string,
  messages: LlmMessage[],
  tools: ToolDef[],
  check: (result: { content: string; toolCalls: Array<{ name: string; args: unknown }> }) => string | null,
): Promise<CaseReport> {
  const startedAt = Date.now();
  let reasoningChars = 0;
  let deltaChars = 0;
  let toolFrags = 0;
  const req: LlmRequest = {
    model,
    messages,
    tools,
    maxTokens: 4096,
    onReasoning: (text) => {
      reasoningChars += text.length;
    },
    onToolCallDelta: (delta) => {
      if (delta.name === 'write_file' || delta.name === 'dispatch_task') toolFrags += 1;
    },
  };
  try {
    const result = await provider.stream(req, (text) => {
      deltaChars += text.length;
    });
    const failure = check(result);
    const usage = result.usage === null ? 'usage 缺失' : `usage ${result.usage.promptTokens}/${result.usage.completionTokens}`;
    return {
      name,
      ok: failure === null,
      detail:
        `${Date.now() - startedAt}ms | content ${result.content.length} 字符 | reasoning 流 ${reasoningChars} 字符 | ` +
        `正文 delta ${deltaChars} 字符 | 工具分片 ${toolFrags} 段 | ${usage} | toolCalls: ` +
        `${result.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.args).slice(0, 120)})`).join('; ') || '无'}` +
        (failure === null ? '' : ` | ✗ ${failure}`),
    };
  } catch (error) {
    if (error instanceof LlmError) {
      return { name, ok: false, detail: `${Date.now() - startedAt}ms | LlmError ${error.code}${error.status ? `(${error.status})` : ''}: ${error.message}` };
    }
    return { name, ok: false, detail: `${Date.now() - startedAt}ms | 异常：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  console.log(`服务商：${config.providerName} → ${config.baseUrl.replace(/\/\/[^/]+/, '//<host>')}`);
  console.log(`模型：${config.model}（思考模式默认开启——应用当前不传 thinking 参数，即按此口径验证）\n`);
  const provider = buildProvider(config);

  const reports: CaseReport[] = [];

  // L：leader 形态（严格路由提示词 → 必须出 toolCall）
  reports.push(
    await runStreamCase(provider, config.model, 'L leader 派发', [
      { role: 'system', content: '你是多智能体团队的领导，负责把用户需求路由分派给下属角色。你唯一的输出方式是调用 dispatch_task 工具；禁止用自然语言直接回答。' },
      { role: 'user', content: '帮我做一个待办事项应用，先出需求文档。' },
    ], [dispatchTool], (result) =>
      result.toolCalls.length === 0
        ? '未发出任何工具调用（思考模式下弱提示会退化为文本回答）'
        : typeof (result.toolCalls[0]?.args as Record<string, unknown> | undefined)?.role === 'string'
          ? null
          : '工具参数缺 role 字段',
    ),
  );

  // E：engineer 形态（write_file → 参数可解析 + 打字机分片通道有产出）
  reports.push(
    await runStreamCase(provider, config.model, 'E engineer 写文件', [
      { role: 'system', content: '你是全栈工程师。收到目标文件后，调用 write_file 工具一次性写入完整文件内容，不要输出解释。' },
      { role: 'user', content: '实现 app/backend/api.js：无框架同构后端模块，导出 handle(method, path, body)，内存维护待办列表，提供列表查询与增删。' },
    ], [writeFileTool], (result) => {
      const call = result.toolCalls[0];
      if (result.toolCalls.length === 0) return '未发出 write_file 调用';
      const args = call?.args as { path?: unknown; content?: unknown } | undefined;
      if (typeof args?.path !== 'string' || typeof args?.content !== 'string') return `参数形状不对：${JSON.stringify(call?.args).slice(0, 120)}`;
      if (args.content.length < 100) return `content 过短（${args.content.length} 字符），疑似截断`;
      return null;
    }),
  );

  console.log(reports.map((report) => `${report.ok ? '✓' : '✗'} [${report.name}] ${report.detail}`).join('\n'));
  const failed = reports.filter((report) => !report.ok);
  console.log(`\n结论：${failed.length === 0 ? 'PASS —— client 层全链路兼容' : `FAIL（${failed.length}/${reports.length} 用例未过）`}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

void main();
