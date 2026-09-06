/**
 * 本地受控执行 Provider（演示姿态）：bash -c 一次性执行 + detached 进程组强杀。
 * 守卫：env 白名单 / 硬超时 / 输出上限保尾 / 防手滑 denylist / 进程组 SIGKILL。
 * 这不是沙箱：命令以平台进程同一用户运行，cd 逃逸与读家目录拦不住——
 * 仅限本机/内网演示（.claude/rules/07-security.md「受控执行层」）。
 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ExecChunk, ExecResult, ExecRunOptions, ExecutionProvider } from './types';

/** 子进程 env 白名单：LLM_*、DASHSCOPE_*、NPM_CONFIG__AUTH、GITHUB_TOKEN 等一切密钥绝不透传 */
const ENV_ALLOWLIST = new Set(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ']);

/**
 * 防手滑 denylist（词法匹配）：定位是「明显误操作的最后一道闸」，不是安全边界——
 * 加引号/变量拼接即可绕过，真正的边界是部署姿态（不公网裸奔）。
 */
const DENYLIST: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(?:-{1,2}[A-Za-z]*[rf][A-Za-z]*\s+){1,2}\/(?:\s|$)/, label: 'rm -rf 根目录' },
  { pattern: /\bmkfs(?:\.|\s)/, label: 'mkfs 格式化' },
  { pattern: /\bdd\b[^|;&]*\bof=\/dev\//, label: 'dd 覆写块设备' },
  { pattern: /\b(?:shutdown|reboot|poweroff|halt)\b/, label: '关机/重启' },
];

/**
 * 同步预检（路由层 400 用）：命中防手滑 denylist 返回 label，否则 null。
 * 与 run 内拦截同一份规则（单一事实源），保证预检口径与执行口径一致。
 */
export function commandGuardLabel(command: string): string | null {
  const hit = DENYLIST.find((item) => item.pattern.test(command));
  return hit?.label ?? null;
}

const DEFAULT_MAX_OUTPUT_CHARS = 262_144;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createLocalExecutionProvider(env: NodeJS.ProcessEnv = process.env): ExecutionProvider {
  const maxOutputChars = parsePositiveInt(env.EXEC_OUTPUT_MAX_BYTES, DEFAULT_MAX_OUTPUT_CHARS);
  return {
    kind: 'local',
    run: (options) => runLocal(options, maxOutputChars),
  };
}

async function runLocal(options: ExecRunOptions, maxOutputChars: number): Promise<ExecResult> {
  const startedAt = Date.now();

  const blockedLabel = commandGuardLabel(options.command);
  if (blockedLabel !== null) {
    return {
      ok: false, exitCode: null, reason: 'blocked',
      output: `命令被防误操作拦截（${blockedLabel}）。如确需执行请手动在宿主机操作。`,
      durationMs: 0,
    };
  }

  if (options.signal?.aborted) {
    return { ok: false, exitCode: null, reason: 'killed', output: '命令尚未启动即被停止。', durationMs: 0 };
  }

  // env 白名单从 process.env 取值（工厂 env 参数只承载 EXEC_* 配置）
  const childEnv: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) childEnv[key] = value;
  }

  return new Promise<ExecResult>((resolve) => {
    // 超时与外部停止只是置原因标志，真正的杀动作统一走 killGroup（幂等，吞 ESRCH）
    let timeoutFired = false;
    let abortFired = false;
    let settled = false;
    let truncated = false;
    let output = '';

    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('bash', ['-c', options.command], {
        cwd: options.cwd,
        detached: true,
        // NODE_ENV 非密钥且为 ProcessEnv 必带键（Next 类型增强），显式透传
        env: { NODE_ENV: process.env.NODE_ENV ?? 'development', ...childEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, exitCode: null, reason: 'spawn_error', output: `启动进程失败：${messageOf(error)}`, durationMs: Date.now() - startedAt });
      return;
    }

    function killGroup(): void {
      if (child.pid !== undefined) {
        try {
          // 负 pid = 杀整个进程组（detached 使 bash 成为新组长），后台子进程不留孤儿
          process.kill(-child.pid as number, 'SIGKILL');
        } catch {
          // ESRCH=进程已退出（与 exit 竞态），静默即可
        }
      }
    }

    function append(text: string, stream: ExecChunk['stream']): void {
      if (text.length === 0) return;
      if (truncated) return; // 已超限：不再累积不再转发，最终 output 前置截断标记
      output += text;
      if (output.length > maxOutputChars) {
        output = output.slice(output.length - maxOutputChars);
        truncated = true;
      }
      options.onChunk?.({ stream, data: text });
    }

    function settle(reason: ExecResult['reason'], exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      const finalOutput = truncated
        ? `……[输出超上限，已截断，仅保留末尾 ${maxOutputChars} 字符]……\n${output}`
        : output;
      resolve({
        ok: reason === 'exit' && exitCode === 0,
        exitCode,
        reason,
        output: finalOutput,
        durationMs: Date.now() - startedAt,
      });
    }

    const timer = setTimeout(() => { timeoutFired = true; killGroup(); }, options.timeoutMs);

    function onAbort(): void { abortFired = true; killGroup(); }
    options.signal?.addEventListener('abort', onAbort);

    child.on('error', (error) => {
      // bash 缺失 / cwd 不存在等：进程从未真正跑起来，错误信息进输出便于排查
      const line = `[进程错误] ${messageOf(error)}`;
      output = output.length > 0 ? `${output}\n${line}` : line;
      settle('spawn_error', null);
    });

    child.stdout?.on('data', (buf: Buffer) => append(stdoutDecoder.write(buf), 'stdout'));
    child.stderr?.on('data', (buf: Buffer) => append(stderrDecoder.write(buf), 'stderr'));

    child.on('close', (code) => {
      // 收口前冲刷 decoder 内残余的多字节半字符
      append(stdoutDecoder.end(), 'stdout');
      append(stderrDecoder.end(), 'stderr');
      const reason: ExecResult['reason'] = timeoutFired ? 'timeout' : abortFired ? 'killed' : 'exit';
      settle(reason, reason === 'exit' ? code : null);
    });
  });
}
