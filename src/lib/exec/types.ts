/**
 * 受控执行层契约（DESIGN §12「执行」扩展点，2026-09-06 增补）。
 * 唯一进程执行面：终端面板与 engineer bash 自检共用同一 Provider，
 * 守卫（env 白名单/超时/输出上限/进程组杀）在实现层统一收口，消费方自动继承。
 * 安全姿态＝本机/内网演示：这是受托执行不是沙箱（见 .claude/rules/07-security.md「受控执行层」）。
 */

/** 终止原因：exit=自然退出 / timeout=硬超时强杀 / killed=外部停止（断连或停止按钮）/
 *  blocked=防手滑拦截 / disabled=执行能力被配置关闭 / spawn_error=进程未能启动 */
export type ExecExitReason = 'exit' | 'timeout' | 'killed' | 'blocked' | 'disabled' | 'spawn_error';

/** 实时输出块（终端 SSE 转发用） */
export interface ExecChunk {
  stream: 'stdout' | 'stderr';
  data: string;
}

export interface ExecResult {
  /** reason==='exit' 且退出码为 0 才算成功 */
  ok: boolean;
  /** 被杀/超时/拦截/禁用时为 null */
  exitCode: number | null;
  reason: ExecExitReason;
  /** stdout+stderr 合并（按到达先后），已过输出上限（超限保尾丢头并前置标记行） */
  output: string;
  durationMs: number;
}

export interface ExecRunOptions {
  command: string;
  cwd: string;
  /** 硬超时：到点杀整个进程组（含 bash 起的后台子进程） */
  timeoutMs: number;
  /** 外部终止信号：abort → 杀进程组（幂等）；三条杀路径（断连/停止/超时）统一收敛于此 */
  signal?: AbortSignal;
  /** 实时输出回调（不传则只攒累积缓冲）；输出超上限后停止转发 */
  onChunk?: (chunk: ExecChunk) => void;
}

export interface ExecutionProvider {
  readonly kind: 'local' | 'disabled';
  run(options: ExecRunOptions): Promise<ExecResult>;
}
