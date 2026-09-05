/**
 * @ 成员提及解析（Task 19，DESIGN §3.1「@ 成员浮层数据源=RoleRegistry」）。
 *
 * 纯函数、客户端安全：只依赖角色注册表，不做任何 IO——
 * - parseMention：光标前 @ 触发判定（浮层开关 + 过滤词 + 精确命中角色）
 * - matchRoles：候选前缀过滤（role id 不区分大小写 / 注册表中文名）
 * - applyMention：候选回填（替换 @ 片段并返回新光标）
 * - extractMentions：发送前全文兜底收集（与勾选 chips 取并集）
 */
import { roleOrder, roleRegistry } from '@/lib/agents/registry';
import type { AgentRole } from '@/lib/db/provider/types';

/** 单个 @ 触发态（MentionPopover 的数据源；null = 光标前没有活跃 @ → 浮层关闭） */
export interface MentionState {
  /** @ 之后、光标之前的过滤词（可为空串） */
  query: string;
  /** @ 字符在全文中的下标（选中候选后替换片段用） */
  start: number;
  /** query 已精确命中某角色（可直接回车选中）时给出该角色 */
  activeAgent: AgentRole | null;
}

/** 过滤词长度上限（防把整段文本当成过滤词） */
const MAX_QUERY_LENGTH = 24;

/** 中文名 → role 反查表（@产品经理 → pm；注册表是常量，模块级建一次） */
const ROLE_BY_NAME: ReadonlyMap<string, AgentRole> = new Map(
  roleOrder.map((role) => [roleRegistry[role].name, role] as const),
);

/** 是否为词边界（undefined = 文本开头也算边界） */
function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char);
}

/** 精确命中：role id（不区分大小写）或注册表中文名；未命中返回 null */
function exactRoleOf(token: string): AgentRole | null {
  if (token === '') return null;
  const lowered = token.toLowerCase();
  if ((roleOrder as readonly string[]).includes(lowered)) return lowered as AgentRole;
  return ROLE_BY_NAME.get(token) ?? null;
}

/**
 * 解析光标前的 @ 触发态。
 * 规则：@ 必须在词首（文本开头或紧邻空白）；@ 之后到光标之间不能出现空白或第二个 @；
 * 过滤词超长视为不触发（避免浮层在长文本里乱弹）。
 */
export function parseMention(text: string, caret: number = text.length): MentionState | null {
  if (caret < 0 || caret > text.length) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (!isBoundary(at === 0 ? undefined : before[at - 1])) return null;

  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY_LENGTH) return null;
  if (/[\s@]/.test(query)) return null;
  return { query, start: at, activeAgent: exactRoleOf(query) };
}

/** 候选过滤：role id 前缀（不区分大小写）或中文名前缀；空过滤词返回注册表全量（稳定顺序） */
export function matchRoles(query: string): AgentRole[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...roleOrder];
  const lowered = trimmed.toLowerCase();
  return roleOrder.filter((role) => role.startsWith(lowered) || roleRegistry[role].name.startsWith(trimmed));
}

/** 用候选角色补全 @ 触发词：替换 [start, caret) 为「@中文名」，返回新文本与新光标 */
export function applyMention(text: string, caret: number, role: AgentRole): { text: string; caret: number } {
  const state = parseMention(text, caret);
  const end = Math.min(caret, text.length);
  const start = state === null ? end : state.start;
  const rest = text.slice(end);
  // 补全词后已有空白就不再追加空格（避免双空格）；文末则补一个，方便继续输入
  const separator = rest === '' || !/^\s/.test(rest) ? ' ' : '';
  const token = `@${roleRegistry[role].name}${separator}`;
  return { text: `${text.slice(0, start)}${token}${rest}`, caret: start + token.length };
}

/** 收集全文里的完整 @ 提及（发送时与勾选 chips 取并集；按出现顺序去重） */
export function extractMentions(text: string): AgentRole[] {
  const found: AgentRole[] = [];
  for (const match of text.matchAll(/@([^\s@]+)/g)) {
    const role = exactRoleOf(match[1] ?? '');
    if (role !== null && !found.includes(role)) found.push(role);
  }
  return found;
}
