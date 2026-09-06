/**
 * 用户终端执行（受控执行层消费方，Task 2）：POST {command} → SSE 流式回传。
 *
 * 帧协议（rules 06 严格格式 `id: <seq>\nevent: <type>\ndata: <单行JSON>\n\n`）：
 * - start：{command}；stdout/stderr：{data: '<chunk>'}；exit：{code, reason, durationMs}
 * - exit 发完即关流（单命令单流，无跨轮次常驻）；每 20s `: ping` 心跳防中间层掐空闲
 *
 * 生命周期：占槽（运行中再提交 → 409 TERMINAL_BUSY）→ 物化工作区 → 流内执行 →
 * run settle 后 finally 收口（release 恰一次 + 清心跳 + 关流）。
 * 杀路径收敛：request.signal（客户端断开）与 stop 路由（activeTerminalRun().stop()）
 * 都汇入本路由的 runAbort（provider 内部统一收敛为进程组 SIGKILL）。
 *
 * 仅限本机/内网演示姿态（rules 07「受控执行层」）：这是受托执行不是沙箱。
 */
import { z } from 'zod';
import { commandGuardLabel } from '@/lib/exec/local';
import { getExecutionProvider } from '@/lib/exec/registry';
import { syncWorkspace } from '@/lib/exec/materialize';
import { activeTerminalRun, acquireTerminalSlot, releaseTerminalSlot } from '@/lib/exec/slots';
import type { ExecResult } from '@/lib/exec/types';
import {
  applySessionCookie,
  badRequest,
  conflict,
  idParamsSchema,
  internalError,
  invalidBody,
  parseRouteParams,
  requireProject,
  serviceUnavailable,
} from '@/lib/api/route-support';

export const dynamic = 'force-dynamic';
// child_process 必须 Node runtime（Edge 无进程概念）
export const runtime = 'nodejs';

/** 心跳间隔（rules 06 建议区间 15-25s 内取 20s） */
const HEARTBEAT_INTERVAL_MS = 20_000;
/** 用户终端单命令硬超时默认值（.env.example：EXEC_TIMEOUT_MS） */
const DEFAULT_TIMEOUT_MS = 600_000;

const execBodySchema = z.object({
  command: z.string().min(1, '命令不能为空').max(500, '命令过长（上限 500 字符）'),
});

/** 正整数解析，非法/缺失回退默认（与 exec 层 env 配置同一容错口径） */
function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const params = await parseRouteParams(idParamsSchema, ctx.params);
    if (params === null) return badRequest('路径参数不合法：id 必须是数字');
    const owned = await requireProject(request, Number(params.id));
    if (owned instanceof Response) return owned;
    const projectId = owned.project.id;

    const parsed = execBodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return invalidBody(parsed.error);
    const { command } = parsed.data;

    const provider = getExecutionProvider();
    if (provider.kind === 'disabled') {
      return serviceUnavailable('执行能力已禁用（EXEC_PROVIDER=disabled），无法运行命令', { code: 'EXEC_DISABLED' });
    }

    // 同步预检（防手滑 denylist）：命中直接 400，不占槽不 spawn（与 run 内拦截同一份规则）
    const blockedLabel = commandGuardLabel(command);
    if (blockedLabel !== null) {
      return Response.json(
        { error: `命令被防误操作拦截（${blockedLabel}）。如确需执行请手动在宿主机操作。`, code: 'EXEC_COMMAND_BLOCKED' },
        { status: 400 },
      );
    }

    const handle = acquireTerminalSlot(projectId, command);
    if (handle === null) {
      const running = activeTerminalRun(projectId);
      return conflict('终端正忙：已有命令在运行，请先停止', {
        code: 'TERMINAL_BUSY',
        runningCommand: running?.command ?? '',
      });
    }

    // 杀路径接线（占槽成功后立刻接好，stop 才不会打在空气上）：stop 路由经
    // activeTerminalRun 拿到同一 handle 引用调 stop()——包一层级联到本次 run 的
    // runAbort；request.signal（客户端断开）同样汇入，三路收敛同一进程组 SIGKILL
    const runAbort = new AbortController();
    const slotStop = handle.stop;
    handle.stop = (): void => {
      runAbort.abort();
      slotStop();
    };
    if (request.signal.aborted) runAbort.abort();
    else request.signal.addEventListener('abort', () => runAbort.abort(), { once: true });

    let workspace: { dir: string; fileCount: number };
    try {
      workspace = await syncWorkspace(owned.storage, projectId);
    } catch (error) {
      releaseTerminalSlot(projectId);
      return internalError(error);
    }

    const timeoutMs = parseTimeoutMs(process.env.EXEC_TIMEOUT_MS);
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let seq = 0;
        let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

        const send = (frame: string): void => {
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            // 消费者已断开且 cancel 尚未触达：吞掉，等收口
          }
        };
        const sendEvent = (event: 'start' | 'stdout' | 'stderr' | 'exit', data: Record<string, unknown>): void => {
          seq += 1;
          send(`id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        heartbeatTimer = setInterval(() => send(': ping\n\n'), HEARTBEAT_INTERVAL_MS);
        sendEvent('start', { command });

        void (async (): Promise<void> => {
          let result: ExecResult;
          try {
            result = await provider.run({
              command,
              cwd: workspace.dir,
              timeoutMs,
              signal: runAbort.signal,
              onChunk: (chunk) => sendEvent(chunk.stream, { data: chunk.data }),
            });
          } catch (error) {
            // provider.run 内部已全收口，此处仅防御性兜底：转成 exit 帧不静默吞
            result = {
              ok: false, exitCode: null, reason: 'spawn_error',
              output: `执行失败：${messageOf(error)}`, durationMs: 0,
            };
          }
          sendEvent('exit', { code: result.exitCode, reason: result.reason, durationMs: result.durationMs });
          // finally 语义收口：清心跳 → 释放槽（恰一次）→ 关流
          if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
          }
          releaseTerminalSlot(projectId);
          try {
            controller.close();
          } catch {
            // 已被 cancel 先关：幂等收口
          }
        })();
      },
      cancel() {
        // 消费者断开（浏览器关页/切项目）：级联杀进程组；槽与心跳由 run settle 后统一收口
        runAbort.abort();
      },
    });

    return applySessionCookie(
      new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      }),
      owned.session,
    );
  } catch (error) {
    return internalError(error);
  }
}
