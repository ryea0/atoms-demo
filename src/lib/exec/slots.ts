/**
 * 用户终端运行槽（per-project 单槽）：
 * 「人占着这个终端」的心智模型——同一项目同时至多一条命令在跑，运行中再提交 → 409。
 * agent bash 自检**不占**此槽（分槽：用户长驻 server 不阻塞 engineer 自检，反向亦然；
 * agent 侧靠编排器串行 + 每任务次数上限闭环，见 tools/bash.ts）。
 * 槽内持 AbortController，stop 路由与 exec 流的断连/超时共用同一杀路径（幂等）。
 */

export interface TerminalRunHandle {
  pid: number | null;
  startedAt: number;
  command: string;
  /** 幂等：内部 abort 同一 AbortController，重复调用无副作用 */
  stop(): void;
}

interface SlotEntry {
  controller: AbortController;
  handle: TerminalRunHandle;
}

/** 模块级单例（同进程内所有路由共享；dev 热更重载模块即清空——已知限制） */
const slots = new Map<number, SlotEntry>();

/**
 * 占槽（check+occupy 同一 tick，无竞态窗口）。spawn 拿到 pid 后由调用方回填 handle.pid；
 * run promise settle 后调用方必须 releaseTerminalSlot（finally 收口，恰一次）。
 * 已被占用返回 null。
 */
export function acquireTerminalSlot(projectId: number, command: string, pid: number | null = null): TerminalRunHandle | null {
  if (slots.has(projectId)) return null;
  const controller = new AbortController();
  const handle: TerminalRunHandle = {
    pid,
    startedAt: Date.now(),
    command,
    stop: () => controller.abort(),
  };
  slots.set(projectId, { controller, handle });
  return handle;
}

export function releaseTerminalSlot(projectId: number): void {
  slots.delete(projectId);
}

export function activeTerminalRun(projectId: number): TerminalRunHandle | null {
  return slots.get(projectId)?.handle ?? null;
}
