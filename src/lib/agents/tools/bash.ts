/**
 * engineer bash 自检工具（受控执行层消费方，.claude/rules/07「受控执行层」节）。
 * 边界：只做一次性只读式自检（node --check 验语法 / require+handle 冒烟验行为），
 * 进程执行一律经 src/lib/exec/（唯一执行面，守卫：env 白名单/超时/输出上限/进程组杀），
 * 写文件不经过这里（虚拟 FS 的 write_file 是唯一写路径）。
 * per-run 预算：WeakMap<ToolContext> 计数——engineer 每次 runAgent 传新 ctx 字面量，
 * 键随 run 消亡、重试轮自动重置预算（期望行为：重试不该继承上轮耗尽的额度）。
 */
import { z } from 'zod';
import { getExecutionProvider } from '@/lib/exec/registry';
import { syncWorkspace } from '@/lib/exec/materialize';
import type { ExecExitReason } from '@/lib/exec/types';
import { formatZodIssues, type Tool, type ToolContext } from './fs-tools';

/** 单次 runAgent 内 bash 调用上限（防模型反复试错刷命令） */
export const BASH_MAX_CALLS_PER_RUN = 5;

/** 回喂模型的输出上限：与 read_file 的 16K 字符口径一致（上下文预算） */
const BASH_MAX_OUTPUT_CHARS = 16000;

/** per-run 调用计数：键 = ToolContext（每次 runAgent 的 ctx 是新对象字面量，随 run 消亡） */
const runCallCounts = new WeakMap<ToolContext, number>();

const bashSchema = z.object({
  command: z.string().min(1).max(500).describe('要在项目根目录执行的 bash 命令（一次性自检用，不要启动长驻服务/安装依赖）'),
  timeout_seconds: z.number().int().min(1).max(30).default(15).describe('超时秒数（上限 30，超时强杀）'),
});

/**
 * 输出首尾截断：超限时保留首尾各半，中段以一行省略标记交代。
 * 仿 fs-tools capChars 的口味，不复用是因为那边私有且上限写死（read_file 专用口径）。
 */
function headTailCap(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor(max / 2);
  return `${text.slice(0, keep)}……[中间输出已省略]……${text.slice(-keep)}`;
}

/**
 * 工具工厂（与 fs-tools 同模式：包一层「校验 + 派生 parameters」，业务只写执行逻辑；
 * fs-tools 的 defineTool 是模块私有，这里按同一契约复制一份小工厂）。
 */
function defineTool<S extends z.ZodType>(def: {
  name: string;
  description: string;
  schema: S;
  execute(args: z.infer<S>, ctx: ToolContext): Promise<{ ok: boolean; output: string }>;
}): Tool {
  const parameters: Tool['parameters'] = z.toJSONSchema(def.schema);
  delete parameters.$schema;
  return {
    name: def.name,
    description: def.description,
    schema: def.schema,
    parameters,
    async execute(args: unknown, ctx: ToolContext): Promise<{ ok: boolean; output: string }> {
      const parsed = def.schema.safeParse(args);
      if (!parsed.success) return { ok: false, output: `参数校验失败：${formatZodIssues(parsed.error)}` };
      return def.execute(parsed.data, ctx);
    },
  };
}

/** killed/blocked/disabled/spawn_error 的统一中文说明（exit/timeout 有专属文案，走前面分支） */
const REASON_TEXT: Record<Exclude<ExecExitReason, 'exit' | 'timeout'>, string> = {
  killed: '命令被外部停止（停止按钮或连接中断）。',
  blocked: '命令被防误操作拦截（防手滑 denylist）。',
  disabled: '执行能力已禁用（EXEC_PROVIDER=disabled）。',
  spawn_error: '命令进程未能启动。',
};

/**
 * bash 自检工具：files 表 → 工作区物化 → 受控执行层跑命令 → 结果映射回喂模型。
 * 绝不抛异常：所有失败（含物化失败）都转 {ok:false, output} 由 runner 回喂。
 */
export const bashTool: Tool = defineTool({
  name: 'bash',
  description:
    '一次性 bash 自检命令，在项目根目录执行。典型用法：node --check app/backend/api.js 验语法；'
    + ' node -e "const m=require(\'./app/backend/api.js\'); console.log(JSON.stringify(m.handle(\'GET\',\'/api/todos\',null)))" 冒烟验行为。'
    + ' 不要启动长驻服务、不要安装依赖；写文件一律走 write_file，不要用 bash 改文件。',
  schema: bashSchema,
  async execute(args, ctx) {
    try {
      const used = runCallCounts.get(ctx) ?? 0;
      if (used >= BASH_MAX_CALLS_PER_RUN) {
        return { ok: false, output: `本任务 bash 调用已达 ${BASH_MAX_CALLS_PER_RUN} 次上限，请直接基于已有信息继续。` };
      }
      runCallCounts.set(ctx, used + 1);

      const provider = getExecutionProvider();
      if (provider.kind === 'disabled') {
        return { ok: false, output: '执行能力已禁用（EXEC_PROVIDER=disabled），请跳过命令自检直接继续。' };
      }

      // 每次调用前物化：保证模型刚 write_file 的内容立即可见（file_end 已落库，无半截文件）
      const { dir } = await syncWorkspace(ctx.storage, ctx.projectId);
      // 不传 onChunk：非交互自检，输出只攒缓冲一次性回喂
      const result = await provider.run({
        command: args.command,
        cwd: dir,
        timeoutMs: args.timeout_seconds * 1000,
      });

      if (result.reason === 'exit') {
        return result.exitCode === 0
          ? { ok: true, output: headTailCap(result.output, BASH_MAX_OUTPUT_CHARS) }
          : { ok: false, output: `[退出码 ${result.exitCode}]\n${headTailCap(result.output, BASH_MAX_OUTPUT_CHARS)}` };
      }
      if (result.reason === 'timeout') {
        return {
          ok: false,
          output: `命令超时（${args.timeout_seconds}s）已被强制终止，部分输出：\n${headTailCap(result.output, BASH_MAX_OUTPUT_CHARS)}`,
        };
      }
      return {
        ok: false,
        output: `${REASON_TEXT[result.reason]}\n${headTailCap(result.output, BASH_MAX_OUTPUT_CHARS)}`,
      };
    } catch (error) {
      // 物化失败等意外：错误说明回喂模型（不静默吞，也不让单条自检炸掉整个 run）
      return { ok: false, output: `命令执行失败：${error instanceof Error ? error.message : String(error)}` };
    }
  },
});
