/**
 * SSE 流（Task 16，.claude/rules/06 逐条落地 / DESIGN §3.6）。
 *
 * 本路由是纯订阅者：编排器/服务层把事件发到 projectEventBus，这里只负责
 * 把 StreamEvent 转成 text/event-stream 帧。
 * - 立即返回 Response（流式工作在 ReadableStream 回调内）
 * - start() 即发 `: connect` 注释帧：平台等首字节才提交响应头，空重放连接靠它立刻刷头
 *   （否则首连要干等 20s 心跳，长跑进程里可能永不送达——2026-09-06 /p/7 事故根因）
 * - 头：text/event-stream + no-cache,no-transform + keep-alive + X-Accel-Buffering:no
 * - 帧格式严格：`id: <seq>\nevent: <type>\ndata: <单行JSON>\n\n`（JSON.stringify 已转义换行）
 * - Last-Event-ID → subscribe(afterSeq)：同步重放环形缓冲缺失事件后进入实时推送
 * - 心跳：每 20s 一行 `: ping\n\n` 注释帧（防中间层掐空闲连接）
 * - request.signal / 消费者 cancel → 退订 + 清心跳 + 关流
 * - 连接跨轮次常驻：done/stopped 不关流（客户端留在页面等待下一轮）
 *
 * 重连对齐策略（T17 客户端职责，此处只提供机制）：先 GET /api/projects/[id]
 * 快照对齐状态，再以 ?lastEventId=<快照 lastSeq>（首连）或 Last-Event-ID 头（重连）
 * 重放增量——纯重放窗口上限 500 条（RING_CAP），超出部分只能靠快照补齐。
 */
import { projectEventBus } from '@/lib/agents/events';
import { badRequest, idParamsSchema, parseRouteParams, requireProject } from '@/lib/api/route-support';

export const dynamic = 'force-dynamic';

/** 心跳间隔（rules 06 建议区间 15-25s 内取 20s） */
const HEARTBEAT_INTERVAL_MS = 20_000;

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const params = await parseRouteParams(idParamsSchema, ctx.params);
  if (params === null) return badRequest('路径参数不合法：id 必须是数字');
  const owned = await requireProject(request, Number(params.id));
  if (owned instanceof Response) return owned;
  const projectId = owned.project.id;

  // Last-Event-ID：浏览器断线重连自动带上（http.dev/last-event-id）；非法值按全新订阅。
  // 原生 EventSource 首连带不了自定义头，客户端把快照 lastSeq 放进 ?lastEventId= query
  //（首连重放入口，T17）；头缺失时回退读 query，头优先（重连原生行为不受 URL 旧值影响）。
  const lastEventId = request.headers.get('Last-Event-ID') ?? new URL(request.url).searchParams.get('lastEventId');
  const afterSeq = lastEventId !== null && /^\d{1,9}$/.test(lastEventId) ? Number(lastEventId) : undefined;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;
  let cleanup: () => void = () => undefined;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // 消费者已断开且 cancel 尚未触达：吞掉，等 cleanup 收口
        }
      };

      // 首帧强制刷头（2026-09-06 /p/7 事故）：平台对流式响应**等到第一个字节才提交响应头**——
      // 空重放连接（首连时 lastEventId=快照 lastSeq=最新值，重放为空是常态）在此之前无头挂起，
      // EventSource 一直停在「连接已断开」，事件全部堆在流里不送达；长跑 dev 进程里甚至 20s
      // 心跳也不到达（enqueue 失败被 send 的 catch 静默吞掉），页面冻结在挂载时的快照。
      // 连接建立即发一帧注释（客户端按 SSE 规范忽略）：响应头立刻提交、onopen 立刻触发。
      send(': connect\n\n');

      // 先重放（subscribe 同步回放 seq>afterSeq 的缓冲事件）再挂实时订阅，不漏不乱序
      unsubscribe = projectEventBus.subscribe(
        projectId,
        (event) => {
          send(`id: ${event.seq}\nevent: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`);
        },
        afterSeq,
      );

      heartbeatTimer = setInterval(() => send(': ping\n\n'), HEARTBEAT_INTERVAL_MS);

      cleanup = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        try {
          controller.close();
        } catch {
          // 已关闭（cancel 先到）：幂等收口
        }
      };
      request.signal.addEventListener('abort', cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
