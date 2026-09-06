/**
 * write_file 参数流 → 文件打字机增量转发器（真模型打字机的关键一环）。
 *
 * 背景：真实模型（openai 兼容流）写文件时全文走 tool_calls.arguments 增量分片，
 * 正文 content 基本为空——orchestrator 若只转发 content 增量，file_start 与
 * file_end 之间零 delta 事件，文件「啪」地整块出现（无打字机）。本模块把
 * provider 透传的 arguments 原始分片增量解出 content 字段文本，按 delta 事件
 * 转发到 SSE；mock provider 也按同一语义分片，两端行为一致。
 *
 * 职责边界（CLAUDE.md 规则 1）：provider 只透传原始分片；本模块做确定性的
 * 增量 JSON 字符串解码（代码做执行）；落库仍以 write_file 工具执行为准
 * （file_end 后内容来自 files 表，流式文本只是预览）。
 *
 * 语义：
 * - 只处理 name === 'write_file' 的调用；content 字段按 args 里第一个键位提取
 *   （path 值是沙箱相对路径，不含未转义引号，不会先于真键出现）。
 * - 同一 call id 的分片按到达顺序增量解码；转义序列（\n、\"、\uD83D 等）允许
 *   跨分片断裂——未齐的转义挂在状态里，下个分片补齐才产出字符。
 * - 第二波 write_file（新 call id：覆写修正 / 校验重试）先补发 file_start
 *   （客户端与事件总线的 live 缓冲都按 file_start 重开新档，重连重放同样正确）；
 *   首波不补发——编排器在任务边界已经发过 file_start。
 * - 已知取舍：delta 只带目标文件路径（编排器派发时绑定），不解析 args 里的
 *   path 参数（键序不保证在 content 之前）；若模型越规写了别的路径，file_end
 *   仍落真实路径与版本，刷新即自愈。
 */
import type { AgentRole } from '@/lib/db/provider/types';
import type { ToolCallStreamDelta } from '@/lib/llm/types';
import type { StreamEvent } from './events';

/** 与编排器 TaskContext.emit 同形（seq/projectId 由事件总线分配） */
type EmitFn = (e: Omit<StreamEvent, 'seq' | 'projectId'>) => unknown;

/** 单个工具调用的增量解码状态（按 call id 维护） */
interface CallState {
  /** arguments 原文累积缓冲（content 闭合前持续追加） */
  raw: string;
  /** content 值的起始位置（找到键后固定；null = 还没扫到） */
  valueStart: number | null;
  /** 已处理到的原文位置（valueStart 之后；增量推进，总量 O(n)） */
  scanPos: number;
  /** 悬而未决的转义：'\\' 已见但转义字符/十六进制位未齐（可跨分片） */
  escape: { kind: 'char' } | { kind: 'unicode'; digits: string } | null;
  /** content 值已见到闭合引号（该调用的后续分片一概忽略） */
  closed: boolean;
}

/** 简单转义字符映射（JSON 规范集；未知转义按原字符宽容处理） */
const SIMPLE_UNESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

/** content 键定位：容忍冒号与引号间的空白（真机实测 doubao 形态 `, "content": "`） */
const CONTENT_KEY_PATTERN = /"content"\s*:\s*"/;

/**
 * 创建转发器：返回可直接挂到 RunnerCallbacks.onToolCallDelta 的回调。
 * path/agent 由派发方绑定（单文件任务的目标路径与角色）。
 */
export function createWriteFileDeltaForwarder(
  path: string,
  agent: AgentRole,
  emit: EmitFn,
): (delta: ToolCallStreamDelta) => void {
  const calls = new Map<string, CallState>();
  let waves = 0;

  return ({ id, name, fragment }: ToolCallStreamDelta): void => {
    if (name !== 'write_file') return; // read_file/bash 等参数流与文件打字机无关
    let state = calls.get(id);
    if (state === undefined) {
      state = { raw: '', valueStart: null, scanPos: 0, escape: null, closed: false };
      calls.set(id, state);
      waves += 1;
      if (waves > 1) {
        // 第二波起（覆写修正/重试）：重开新档，客户端清掉上一波半成品再流新文
        emit({ runId: null, event: 'file_start', agent, path });
      }
    }
    if (state.closed) return;
    state.raw += fragment;

    if (state.valueStart === null) {
      // 键搜索只发生在 content 之前的前缀（有界：path/空白），整段重扫可接受
      const found = CONTENT_KEY_PATTERN.exec(state.raw);
      if (found === null) return; // 键还没到（或键名本身跨分片断裂，下个分片再试）
      state.valueStart = found.index + found[0].length;
      state.scanPos = state.valueStart;
    }

    let fresh = '';
    while (state.scanPos < state.raw.length) {
      const ch = state.raw[state.scanPos];
      if (ch === undefined) break; // 不可达（循环条件已保证）；noUncheckedIndexedAccess 收尾
      if (state.escape !== null) {
        if (state.escape.kind === 'char') {
          if (ch === 'u') {
            state.escape = { kind: 'unicode', digits: '' };
          } else {
            fresh += SIMPLE_UNESCAPES[ch] ?? ch;
            state.escape = null;
          }
        } else {
          state.escape.digits += ch;
          if (state.escape.digits.length === 4) {
            // 代理对（😀）分属两次 \uXXXX，各自产出码元，拼接自然成对
            fresh += String.fromCharCode(Number.parseInt(state.escape.digits, 16));
            state.escape = null;
          }
        }
      } else if (ch === '\\') {
        state.escape = { kind: 'char' };
      } else if (ch === '"') {
        state.closed = true; // 值闭合：该调用剩余片段（路径键序在后时的尾巴）忽略
        break;
      } else {
        fresh += ch;
      }
      state.scanPos += 1;
    }
    if (fresh !== '') emit({ runId: null, event: 'delta', agent, path, content: fresh });
  };
}
