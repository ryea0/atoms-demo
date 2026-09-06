/**
 * 项目事件总线（Task 15，DESIGN §3.6 SSE 协议 / 断线恢复）。
 *
 * 职责：编排器把运行过程中的全部状态变化发到这里；SSE 路由（Task 16+）订阅本总线
 * 转成 text/event-stream。事件不落库（delta 只走 SSE；落库时机=file_end，由角色层负责），
 * 内存里保留最近 RING_CAP 条供 Last-Event-ID 重连重放。
 *
 * 模块级单例 projectEventBus：内部按 projectId 分桶（每 project 独立 seq/缓冲/订阅者），
 * 与「每 project 一个、单例 Map」的语义一致——切 project 互不串扰。
 *
 * 协议备注（error 事件的终态语义）：**error{agent}（无 path）视为该 agent 当前 run 的终态**，
 * 等价于一次带错误信息的 agent_end——编排器任务失败只发 error{agent,taskKey}，不再补发
 * agent_end；客户端（store.errorPatchFor）据此把该角色最近 running run 置 failed。
 * 新增事件消费方（时间线、进度条等）必须遵守同一约定，否则任务级失败会永久停留在「进行中」。
 */
import type { AgentRole } from '@/lib/db/provider/types';

/** SSE 事件名（与 .claude/rules/06 协议一致；新增状态需同步改协议与前端） */
export type StreamEventName =
  | 'agent_start'
  | 'file_start'
  | 'delta'
  | 'file_end'
  | 'agent_end'
  | 'message'
  | 'intervention_injected'
  | 'done'
  | 'stopped'
  | 'error';

/** 单条流事件：seq/projectId 由总线分配，其余字段按事件语义选填 */
export interface StreamEvent {
  seq: number;
  projectId: number;
  /** 关联的 agent_runs.id；任务级事件（如 message）无关联时为 null */
  runId: number | null;
  event: StreamEventName;
  agent?: AgentRole;
  path?: string;
  content?: string;
  summary?: string;
  error?: string;
  /**
   * 事件附属信息（按 event 语义选填，自由形状）：
   * - message：role（user/assistant）+ messageId（落库行 id，前端按正数 id 去重防重放重复）；
   *   leader 卡片另带 kind（softlock=软锁裁决 / restore=回滚通知）与 path
   * - intervention_injected：messageId + targetTask（注入到哪个任务/文件边界）
   * - file_end：version（落库版本号）+ ok（校验是否通过）
   * - agent_start/agent_end/error：taskKey
   */
  meta?: Record<string, unknown>;
}

/** 环形缓冲容量（DESIGN §3.6：最近 500 条重放窗口） */
const RING_CAP = 500;

/** 单个 project 的总线状态 */
interface BusState {
  /** 已发事件总数（单调递增，作为 seq） */
  seq: number;
  /** 最近 RING_CAP 条事件（重放窗口） */
  ring: StreamEvent[];
  subscribers: Set<(event: StreamEvent) => void>;
  /** 正在流式生成文件的全文缓冲（path → 已累积 delta），file_end 清除 */
  live: Map<string, string>;
}

/** 每 project 一个的分桶状态（懒创建） */
function newState(): BusState {
  return { seq: 0, ring: [], subscribers: new Set(), live: new Map() };
}

/**
 * 项目事件总线。emit 分配 seq 并推环形缓冲与订阅者；
 * subscribe(afterSeq) 先同步重放缓冲中 seq 更大者，再进入实时推送。
 * 订阅者异常被隔离（一个坏消费者不拖垮编排器）。
 */
export class ProjectEventBus {
  private readonly projects = new Map<number, BusState>();

  private stateOf(projectId: number): BusState {
    let state = this.projects.get(projectId);
    if (state === undefined) {
      state = newState();
      this.projects.set(projectId, state);
    }
    return state;
  }

  emit(projectId: number, e: Omit<StreamEvent, 'seq' | 'projectId'>): StreamEvent {
    const state = this.stateOf(projectId);
    state.seq += 1;
    const event: StreamEvent = { ...e, seq: state.seq, projectId };

    state.ring.push(event);
    if (state.ring.length > RING_CAP) state.ring.splice(0, state.ring.length - RING_CAP);

    // 正在流式文件全文：delta 累积；file_start 重开新档；file_end 清除
    if (event.event === 'file_start' && event.path !== undefined) {
      state.live.set(event.path, '');
    } else if (event.event === 'delta' && event.path !== undefined) {
      state.live.set(event.path, (state.live.get(event.path) ?? '') + (event.content ?? ''));
    } else if (event.event === 'file_end' && event.path !== undefined) {
      state.live.delete(event.path);
    } else if (event.event === 'error' && event.path !== undefined) {
      state.live.delete(event.path); // 文件级失败：清掉该路径的在流文本（避免快照读到残文）
    } else if (event.event === 'stopped') {
      state.live.clear(); // 停止后不再有「正在生成」的文件
    }

    for (const subscriber of state.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        console.error(`[events] 订阅者处理事件失败（seq=${event.seq}，event=${event.event}）：`, error);
      }
    }
    return event;
  }

  /** 订阅实时事件；afterSeq 提供时先重放缓冲中 seq > afterSeq 的事件（Last-Event-ID 恢复）。返回退订函数 */
  subscribe(projectId: number, fn: (event: StreamEvent) => void, afterSeq?: number): () => void {
    const state = this.stateOf(projectId);
    // 重放与订阅之间无 await：同步重放完毕才挂上实时订阅，不会漏事件也不会乱序；
    // 重放同样隔离订阅者异常（坏消费者不能把 SSE 路由的注册流程炸掉）
    if (afterSeq !== undefined) {
      for (const event of state.ring) {
        if (event.seq > afterSeq) {
          try {
            fn(event);
          } catch (error) {
            console.error(`[events] 订阅者重放事件失败（seq=${event.seq}，event=${event.event}）：`, error);
          }
        }
      }
    }
    state.subscribers.add(fn);
    return () => {
      state.subscribers.delete(fn);
    };
  }

  /** 缓冲快照：seq > afterSeq 的事件（重连重放数据源；超出 500 条窗口的部分不可恢复） */
  snapshotBuffer(projectId: number, afterSeq: number): StreamEvent[] {
    return this.stateOf(projectId).ring.filter((event) => event.seq > afterSeq);
  }

  /** 正在流式生成文件的全文（打字机/刷新快照用）；无在流文件返回空串 */
  liveBuffer(projectId: number, path: string): string {
    return this.stateOf(projectId).live.get(path) ?? '';
  }

  /**
   * 显式释放项目资源（项目删除路由调用）：清空环形缓冲/订阅者/在流文本。
   * 正常收口（done/stopped）**不**清缓冲——重连重放窗口保持完整，只有显式释放才清。
   */
  release(projectId: number): void {
    const state = this.projects.get(projectId);
    if (state === undefined) return;
    this.projects.delete(projectId);
  }
}

/** 模块级单例：编排器与 SSE 路由共用同一份（跨模块 import 本实例，勿各自 new） */
export const projectEventBus = new ProjectEventBus();
