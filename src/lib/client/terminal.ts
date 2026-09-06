'use client';

/**
 * 终端面板状态层（受控执行层的客户端）：命令下发 + SSE 输出流解析 + 生命周期。
 *
 * 边界划分：本 hook 只做「数据与请求生命周期」——POST exec 读 event-stream、手写
 * SSE 帧解析（跨 chunk 残包缓冲）、JSON 错误信封、行数 cap、卸载 abort；
 * 渲染（贴底滚动/输入行/停止按钮）在 TerminalPane。hook 由 Workspace 无条件挂载
 * （生命周期绑定工作台，切视图不杀进程），视图切换只是 TerminalPane 的挂卸。
 *
 * 停止语义：停止按钮走 POST stop 端点（服务端杀进程后在原流上补 exit 帧），
 * **不 abort fetch**——读流要保持到 exit 确认帧到达；abort 只发生在组件卸载。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** 单条终端输出行（kind 决定渲染语义：stdout/stderr/exit/error/info=命令回显） */
export interface TerminalLine {
  id: number;
  kind: 'stdout' | 'stderr' | 'exit' | 'error' | 'info';
  text: string;
  /** stdout/stderr 行内 ATOMS_SERVER_URL=… 解析出的可点链接（服务地址） */
  link?: string;
}

/** 终端面板消费的控制器（TerminalPane 纯消费，不自己拉数据） */
export interface TerminalController {
  lines: readonly TerminalLine[];
  running: boolean;
  history: readonly string[];
  error: string | null;
  run(command: string): void;
  stop(): void;
}

/** 输出流行数上限：超限丢头部并插省略标记（内存有界，现场感保留尾部） */
const MAX_LINES = 1000;
/** 命令历史条数上限（内存数组，仅回溯用） */
const HISTORY_CAP = 100;

/** 省略标记行（固定 id 0 与自增行 id 不冲突；模块级常量保证引用稳定） */
const OMITTED_MARKER: TerminalLine = Object.freeze({ id: 0, kind: 'info', text: '……更早输出已省略……' });

/** 服务地址环境变量行 → 可点链接（演示命令会回显 ATOMS_SERVER_URL=http://…） */
const SERVER_URL_PATTERN = /ATOMS_SERVER_URL=(https?:\/\/[^\s'"]+)/;

/** 单个 SSE 帧的解析结果（`\n\n` 之间的内容） */
interface SseFrame {
  event: string | null;
  data: string | null;
}

/** 解析一帧：忽略 `:` 心跳注释与 `id:` 行，收集 event:/data:（兼容 \r\n 行尾） */
function parseSseFrame(frame: string): SseFrame {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (raw.startsWith(':') || raw.startsWith('id:')) continue;
    if (raw.startsWith('event:')) {
      event = raw.slice('event:'.length).trim();
    } else if (raw.startsWith('data:')) {
      dataLines.push(raw.slice('data:'.length).replace(/^ /, ''));
    }
  }
  return { event, data: dataLines.length > 0 ? dataLines.join('\n') : null };
}

/** data 单行 JSON 解析（帧协议保证单行；非法/空值返回 null 由调用方跳过） */
function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    // 边界断言：外部数据解析后的形状收窄
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** exit 帧终止语义 → 中文行文本（code 仅 reason='exit' 时展示） */
function exitTextOf(payload: Record<string, unknown> | null): string {
  const body = payload ?? {};
  const reason = typeof body.reason === 'string' ? body.reason : 'exit';
  if (reason !== 'exit') {
    const durationMs = typeof body.durationMs === 'number' ? body.durationMs : 0;
    switch (reason) {
      case 'timeout':
        return `已超时强制终止（${Math.max(1, Math.round(durationMs / 1000))}s）`;
      case 'killed':
        return '已手动停止';
      case 'blocked':
        return '命令被拦截';
      case 'disabled':
        return '执行能力已禁用';
      case 'spawn_error':
        return '进程启动失败';
      default:
        break;
    }
  }
  return typeof body.code === 'number' ? `退出码 ${body.code}` : '已退出';
}

/** JSON 错误信封 → 中文错误文本（TERMINAL_BUSY 附运行中命令提示） */
async function jsonErrorMessage(response: Response): Promise<string> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // 空体/非 JSON：走 HTTP 兜底文案
  }
  const body =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  if (typeof body.error === 'string' && body.error !== '') {
    if (
      body.code === 'TERMINAL_BUSY' &&
      typeof body.runningCommand === 'string' &&
      body.runningCommand !== ''
    ) {
      return `${body.error}（当前正在运行：${body.runningCommand}）`;
    }
    return body.error;
  }
  return `请求失败（HTTP ${response.status}）`;
}

/** 读 event-stream 并逐帧回调（跨 chunk 残包缓冲，按 `\n\n` 分帧） */
async function readSseStream(body: ReadableStream<Uint8Array>, onFrame: (frame: SseFrame) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = (chunk: string): void => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf('\n\n');
      if (index === -1) break;
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      onFrame(parseSseFrame(frame));
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (value !== undefined) consume(decoder.decode(value, { stream: true }));
    if (done) break;
  }
  consume(decoder.decode());
}

/** 行数 cap：超限丢头部，最前插省略标记（标记自身占一行，总数回收进上限） */
function capLines(lines: readonly TerminalLine[]): TerminalLine[] {
  if (lines.length <= MAX_LINES) return [...lines];
  return [OMITTED_MARKER, ...lines.slice(lines.length - (MAX_LINES - 1))];
}

/** abort 归一判断（卸载主动中断不是错误，不产生用户可见提示） */
function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
}

export function useTerminal(projectId: number): TerminalController {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  /** 行 id 发号器（render 之外的自增序号，用 ref 避免把纯计数放进 state） */
  const nextIdRef = useRef(1);
  /** running 的 ref 镜像：让 run 守卫不依赖 state 闭包（回调保持稳定） */
  const runningRef = useRef(false);
  /** 在途 exec 请求的控制器（仅卸载时 abort；停止走 stop 端点） */
  const abortRef = useRef<AbortController | null>(null);

  const appendLine = useCallback((kind: TerminalLine['kind'], text: string, link?: string): void => {
    const line: TerminalLine = { id: nextIdRef.current, kind, text };
    nextIdRef.current += 1;
    if (link !== undefined) line.link = link;
    setLines((prev) => capLines([...prev, line]));
  }, []);

  /** 输出行追加：顺带解析 ATOMS_SERVER_URL 链接 */
  const appendOutput = useCallback(
    (kind: 'stdout' | 'stderr', text: string): void => {
      const match = SERVER_URL_PATTERN.exec(text);
      appendLine(kind, text, match?.[1]);
    },
    [appendLine],
  );

  const run = useCallback(
    (command: string): void => {
      const trimmed = command.trim();
      if (trimmed === '' || runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      setError(null);
      appendLine('info', `$ ${trimmed}`);
      setHistory((prev) => [...prev, trimmed].slice(-HISTORY_CAP));

      const controller = new AbortController();
      abortRef.current = controller;
      const finish = (): void => {
        runningRef.current = false;
        setRunning(false);
      };

      void (async (): Promise<void> => {
        try {
          const response = await fetch(`/api/projects/${projectId}/terminal/exec`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: trimmed }),
            signal: controller.signal,
          });
          const contentType = response.headers.get('content-type') ?? '';
          if (!response.ok || !contentType.includes('text/event-stream')) {
            // JSON 错误信封（409 busy / 503 disabled / 400 blocked …）：error 行 + error 状态
            const message = await jsonErrorMessage(response);
            appendLine('error', message);
            setError(message);
            return;
          }
          if (response.body === null) {
            const message = '服务端未返回输出流';
            appendLine('error', message);
            setError(message);
            return;
          }
          await readSseStream(response.body, (frame) => {
            if (frame.event === 'stdout' || frame.event === 'stderr') {
              const payload = parseJsonObject(frame.data);
              if (payload !== null && typeof payload.data === 'string') {
                appendOutput(frame.event, payload.data);
              }
            } else if (frame.event === 'exit') {
              appendLine('exit', exitTextOf(parseJsonObject(frame.data)));
            }
            // start 帧/心跳无行输出
          });
        } catch (streamError) {
          if (!isAbortError(streamError)) {
            console.error('[terminal] 命令执行流中断：', streamError);
            const message =
              streamError instanceof Error ? `连接中断：${streamError.message}` : '连接中断';
            appendLine('error', message);
            setError(message);
          }
        } finally {
          finish();
        }
      })();
    },
    [projectId, appendLine, appendOutput],
  );

  /** 停止当前命令：POST stop 端点（服务端杀进程后原流补 exit 帧），不 abort 读流 */
  const stop = useCallback((): void => {
    fetch(`/api/projects/${projectId}/terminal/stop`, { method: 'POST', credentials: 'same-origin' })
      .then(() => undefined)
      .catch((stopError: unknown) => {
        console.error('[terminal] 停止请求失败：', stopError);
      });
  }, [projectId]);

  // 卸载收尾：abort 在途 fetch（服务端会级联杀进程）+ 复位 running
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      runningRef.current = false;
      setRunning(false);
    };
  }, []);

  return useMemo<TerminalController>(
    () => ({ lines, running, history, error, run, stop }),
    [lines, running, history, error, run, stop],
  );
}
