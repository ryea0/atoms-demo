/**
 * 终端面板前端测试：useTerminal（手写 SSE 帧解析 + JSON 错误信封 + 行数 cap +
 * 卸载 abort 生命周期）与 TerminalPane 冒烟渲染（纯消费边界，fake controller）。
 *
 * fetch 全量 stub：event-stream 用 ReadableStream + TextEncoder 手工编帧——
 * 覆盖「一帧跨 chunk 断开仍正确解析」的残包缓冲路径与 `: ping`/`id:` 行忽略；
 * JSON 错误信封（409 TERMINAL_BUSY）用真实 Response 构造。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { useTerminal } from '@/lib/client/terminal';
import type { TerminalController } from '@/lib/client/terminal';

const PROJECT_ID = 9;
const EXEC_URL = `/api/projects/${PROJECT_ID}/terminal/exec`;
const STOP_URL = `/api/projects/${PROJECT_ID}/terminal/stop`;

const encoder = new TextEncoder();

/** 编一帧标准 SSE（id/event/data 三行，data 为单行 JSON） */
function frame(id: number, event: string, data: string): string {
  return `id: ${id}\nevent: ${event}\ndata: ${data}\n\n`;
}

/** event-stream 响应：chunks 逐段入队（默认一帧一段；拆段即模拟网络分片残包） */
function sseResponse(chunks: readonly string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

/** JSON 错误信封响应（409/503/400 …） */
function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/* useTerminal：SSE 帧解析                                              */
/* ------------------------------------------------------------------ */

describe('useTerminal 帧解析', () => {
  it('标准链路：命令回显 info 行 + stdout/stderr 追加行 + exit「退出码 0」收口，URL 与方法正确', async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        frame(1, 'start', '{}'),
        frame(2, 'stdout', JSON.stringify({ data: 'hello' })),
        frame(3, 'stderr', JSON.stringify({ data: 'boom' })),
        frame(4, 'exit', JSON.stringify({ code: 0, reason: 'exit', durationMs: 12 })),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('echo hi');
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(EXEC_URL);
    const init = (fetchMock.mock.calls[0]?.[1] ?? {}) as { method?: string; body?: string };
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ command: 'echo hi' }));

    expect(result.current.lines.map((line) => line.text)).toEqual(['$ echo hi', 'hello', 'boom', '退出码 0']);
    expect(result.current.lines.map((line) => line.kind)).toEqual(['info', 'stdout', 'stderr', 'exit']);
    expect(result.current.history).toEqual(['echo hi']);
    expect(result.current.error).toBeNull();
  });

  it('帧跨 chunk 断开（一帧从中间切成两段推送）仍正确解析；`: ping` 心跳与 id 行被忽略', async () => {
    // 心跳 + 一帧 stdout，从 data 载荷中间断开成两个 chunk
    const whole = `: ping\n\n${frame(1, 'stdout', JSON.stringify({ data: 'split-frame' }))}`;
    const cut = whole.indexOf('split');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          whole.slice(0, cut),
          whole.slice(cut),
          frame(2, 'exit', JSON.stringify({ code: 0, reason: 'exit', durationMs: 1 })),
        ]),
      ),
    );

    const { result } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('cat todo.txt');
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });

    const texts = result.current.lines.map((line) => line.text);
    expect(texts).toEqual(['$ cat todo.txt', 'split-frame', '退出码 0']);
    // 心跳注释与 id 行都不落行（若被当输出解析，texts 会多出 ping / id 内容）
    expect(texts.join('\n')).not.toContain('ping');
  });

  it('运行中 running=true；exit 帧到达后置 false（流未收口前保持运行态）', async () => {
    let releaseExit: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame(1, 'stdout', JSON.stringify({ data: 'working' }))));
        releaseExit = () => {
          controller.enqueue(encoder.encode(frame(2, 'exit', JSON.stringify({ code: 0, reason: 'exit', durationMs: 5 }))));
          controller.close();
        };
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );

    const { result } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('sleep 1');
    });
    expect(result.current.running).toBe(true);

    await act(async () => {
      releaseExit?.();
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });
    expect(result.current.lines.at(-1)?.text).toBe('退出码 0');
  });

  it('终止语义映射：killed=已手动停止（stop 端点路径正确）', async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === STOP_URL) return jsonResponse(200, { ok: true, stopped: true });
      return sseResponse([frame(1, 'exit', JSON.stringify({ code: null, reason: 'killed', durationMs: 800 }))]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('long-run');
    });
    result.current.stop();
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });

    expect(result.current.lines.at(-1)?.text).toBe('已手动停止');
    expect(fetchMock).toHaveBeenCalledWith(STOP_URL, expect.objectContaining({ method: 'POST' }));
  });
});

/* ------------------------------------------------------------------ */
/* useTerminal：错误信封 / cap / 生命周期 / 链接                          */
/* ------------------------------------------------------------------ */

describe('useTerminal 错误与边界', () => {
  it('409 JSON 错误信封：追加 error 行 + 置 error 状态（TERMINAL_BUSY 附运行中命令提示）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(409, { error: '已有命令在执行', code: 'TERMINAL_BUSY', runningCommand: 'npm run dev' }),
      ),
    );

    const { result } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('ls');
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });

    const errorLine = result.current.lines.find((line) => line.kind === 'error');
    expect(errorLine?.text).toContain('已有命令在执行');
    expect(errorLine?.text).toContain('npm run dev');
    expect(result.current.error).toContain('npm run dev');
  });

  it('行数 cap 1000：超出后丢头部并出现「……更早输出已省略……」标记，尾部最新行保留', async () => {
    const total = 1010;
    const chunks = Array.from({ length: total }, (_, index) =>
      frame(index + 1, 'stdout', JSON.stringify({ data: `line-${index}` })),
    );
    chunks.push(frame(total + 1, 'exit', JSON.stringify({ code: 0, reason: 'exit', durationMs: 1 })));
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(chunks)));

    const { result } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('many');
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });

    expect(result.current.lines).toHaveLength(1000);
    expect(result.current.lines[0]?.text).toBe('……更早输出已省略……');
    // 头部确实被丢、尾部确实保留
    expect(result.current.lines.some((line) => line.text === 'line-0')).toBe(false);
    expect(result.current.lines.some((line) => line.text === 'line-1009')).toBe(true);
    expect(result.current.lines.at(-1)?.text).toBe('退出码 0');
  });

  it('组件卸载：在途 exec fetch 被 abort（signal.aborted=true）', async () => {
    let capturedInit: RequestInit | undefined;
    const pendingStream = new ReadableStream<Uint8Array>({
      start() {
        // 不 close：读流挂住，直到 abort 级联取消
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        capturedInit = init;
        return new Response(pendingStream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const { result, unmount } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('hang');
    });
    expect(result.current.running).toBe(true);

    unmount();
    expect((capturedInit?.signal as AbortSignal | undefined)?.aborted).toBe(true);
  });

  it('ATOMS_SERVER_URL 行解析出 link 字段', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          frame(1, 'stdout', JSON.stringify({ data: '服务已启动 ATOMS_SERVER_URL=http://127.0.0.1:3000/app' })),
          frame(2, 'exit', JSON.stringify({ code: 0, reason: 'exit', durationMs: 1 })),
        ]),
      ),
    );

    const { result } = renderHook(() => useTerminal(PROJECT_ID));
    await act(async () => {
      result.current.run('npm run dev');
    });
    await waitFor(() => {
      expect(result.current.running).toBe(false);
    });

    const stdoutLine = result.current.lines.find((line) => line.kind === 'stdout');
    expect(stdoutLine?.link).toBe('http://127.0.0.1:3000/app');
    expect(stdoutLine?.text).toContain('ATOMS_SERVER_URL=http://127.0.0.1:3000/app');
  });
});

/* ------------------------------------------------------------------ */
/* TerminalPane 冒烟渲染（纯消费边界）                                   */
/* ------------------------------------------------------------------ */

function fakeController(overrides?: Partial<TerminalController>): TerminalController {
  return {
    lines: [
      { id: 1, kind: 'info', text: '$ npm run dev' },
      {
        id: 2,
        kind: 'stdout',
        text: 'server ready ATOMS_SERVER_URL=http://localhost:3000',
        link: 'http://localhost:3000',
      },
      { id: 3, kind: 'stderr', text: 'deprecation warning' },
      { id: 4, kind: 'exit', text: '退出码 0' },
    ],
    running: false,
    history: ['npm run dev'],
    error: null,
    run: vi.fn(),
    stop: vi.fn(),
    ...overrides,
  };
}

describe('TerminalPane 冒烟渲染', () => {
  it('渲染输出行（命令回显/stderr/exit）与服务地址链接（新窗口 + noreferrer）', () => {
    render(createElement(TerminalPane, { terminal: fakeController() }));

    expect(screen.getByText('npm run dev')).toBeInTheDocument();
    expect(screen.getByText('deprecation warning')).toBeInTheDocument();
    expect(screen.getByText('退出码 0')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'http://localhost:3000' });
    expect(link).toHaveAttribute('href', 'http://localhost:3000');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    expect(link.className).toContain('text-primary');
  });

  it('空态：无任何行时居中展示能力简介与真实执行警示', () => {
    render(createElement(TerminalPane, { terminal: fakeController({ lines: [] }) }));

    expect(screen.getByText('在本机执行命令的工作终端')).toBeInTheDocument();
    expect(screen.getByText('命令在本机真实执行，仅限本地/内网演示环境使用')).toBeInTheDocument();
    expect(screen.queryByLabelText('终端输出')).not.toBeInTheDocument();
  });

  it('running=true：输入禁用、无提交，停止按钮可点（调 stop）', () => {
    const controller = fakeController({ running: true });
    render(createElement(TerminalPane, { terminal: controller }));

    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByText('运行中…')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '停止' }));
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(controller.run).not.toHaveBeenCalled();
  });

  it('空闲态：输入命令回车提交调 run（入参 trim），提交后清空输入', () => {
    const controller = fakeController();
    render(createElement(TerminalPane, { terminal: controller }));

    const input = screen.getByRole('textbox');
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: '  ls -la  ' } });
    fireEvent.submit(input.closest('form') ?? document.createElement('form'));

    expect(controller.run).toHaveBeenCalledWith('ls -la');
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(controller.stop).not.toHaveBeenCalled();
  });
});
