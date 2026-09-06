'use client';

/**
 * 聊天输入区（Task 19）：受控 textarea + 成员 chips（多选）+ @ 浮层（↑↓/Enter/Esc/点击，
 * 前缀过滤）+ 模式徽标 + 发送/停止。
 *
 * 语义：空闲发送 = 新一轮生成；运行中发送 = 干预入队（黄条提示在 ChatPanel），
 * 输入框保持可用；运行中左下显示停止钮（POST stop）。
 * 模式徽标是**只读展示**：mode 在创建项目时确定（POST /api/projects 的 body.mode），
 * 生成中途不可切——消息路由不接收 mode，此前的可点胶囊是无上送通道的死控件（终审 #6）。
 * 新建项目的模式选择在首页 HomeHero（消费 preferences.default_mode 作为初值）。
 */
import { useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactElement, TextareaHTMLAttributes } from 'react';
import { AtSign, Send, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { roleOrder, roleRegistry } from '@/lib/agents/registry';
import { modeLabel } from '@/lib/client/format';
import type { AgentRole } from '@/lib/db/provider/types';
import { applyMention, extractMentions, matchRoles, parseMention } from '@/lib/client/mentions';

/** 发送载荷（POST /api/projects/[id]/messages 请求体） */
export interface ChatInputSendInput {
  content: string;
  mentions: AgentRole[];
}

export interface ChatInputProps {
  /** 发送（空闲=新一轮；运行中=干预入队）。返回是否成功，成功才清空输入 */
  onSend: (input: ChatInputSendInput) => Promise<boolean>;
  /** 停止当前生成（仅运行中显示） */
  onStop: () => void;
  /** 生成进行中：显示停止钮，发送语义变为「干预入队」 */
  running: boolean;
  /** 本项目的生成模式（创建时确定；只读徽标展示） */
  mode: 'fast' | 'full';
  /** 快照未就绪时禁用整个输入区 */
  disabled?: boolean;
  /**
   * 请求在途（T31 防重复提交）：ChatPanel 统一持有的发送门闸，覆盖输入框之外的发送入口。
   * 在途期间禁用发送钮与回车提交——模型思考以分钟计，第二次点击不再产生重复请求。
   */
  inFlight?: boolean;
}

/** @ 成员浮层：候选列表（listbox 语义 + 高亮态；键盘导航在 ChatInput 处理） */
function MentionPopover({
  candidates,
  activeIndex,
  onPick,
}: {
  candidates: readonly AgentRole[];
  activeIndex: number;
  onPick: (role: AgentRole) => void;
}) {
  return (
    <div
      role="listbox"
      aria-label="成员浮层"
      className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-background p-1 shadow-md"
    >
      {candidates.map((role, index) => {
        const meta = roleRegistry[role];
        return (
          <button
            key={role}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            // mousedown preventDefault：点击候选时不让输入框失焦（浮层不抖动关闭）
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(role)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent max-lg:min-h-11',
              index === activeIndex && 'bg-accent',
            )}
          >
            <span aria-hidden className="shrink-0" style={{ color: meta.color }}>
              {meta.emoji}
            </span>
            <span className="shrink-0 font-medium text-foreground">{meta.name}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{meta.blurb}</span>
          </button>
        );
      })}
    </div>
  );
}

export function ChatInput({ onSend, onStop, running, mode, disabled = false, inFlight = false }: ChatInputProps): ReactElement {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  /** chips 多选（与正文里的 @ 提及取并集发送） */
  const [picked, setPicked] = useState<AgentRole[]>([]);
  const [sending, setSending] = useState(false);
  /** Esc 关闭浮层时记录的过滤词：换词（继续输入）即重新打开 */
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const blocked = disabled || inFlight;
  const mention = blocked ? null : parseMention(text, caret);
  const candidates = mention === null ? [] : matchRoles(mention.query);
  const popoverOpen = mention !== null && dismissedQuery !== mention.query && candidates.length > 0;
  const activeIndex = Math.min(highlight, Math.max(candidates.length - 1, 0));

  // 发送的 mentions = 勾选 chips ∪ 正文 @ 提及（并集去重，按勾选顺序在前）
  const mentions: AgentRole[] = [...picked];
  for (const role of extractMentions(text)) {
    if (!mentions.includes(role)) mentions.push(role);
  }

  const syncCaret = (element: HTMLTextAreaElement): void => {
    setCaret(element.selectionStart ?? element.value.length);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>): void => {
    setText(event.currentTarget.value);
    setHighlight(0);
    setDismissedQuery(null);
    syncCaret(event.currentTarget);
  };

  const handleSelect: TextareaHTMLAttributes<HTMLTextAreaElement>['onSelect'] = (event) => {
    syncCaret(event.currentTarget);
  };

  const submit = (): void => {
    if (blocked || sending) return;
    const content = text.trim();
    if (content === '') return;
    setSending(true);
    void onSend({ content, mentions })
      .then((ok) => {
        if (ok) {
          setText('');
          setCaret(0);
          setPicked([]);
          setDismissedQuery(null);
        }
      })
      .finally(() => setSending(false));
  };

  const applyText = (next: string, nextCaret: number): void => {
    setText(next);
    setCaret(nextCaret);
    setHighlight(0);
    setDismissedQuery(null);
    const element = textareaRef.current;
    if (element !== null) element.setSelectionRange(nextCaret, nextCaret);
  };

  /** 选中候选：回填中文名（浮层因触发词被替换而自动关闭） */
  const pick = (role: AgentRole): void => {
    if (mention === null) return;
    const next = applyMention(text, caret, role);
    applyText(next.text, next.caret);
  };

  /** @ 按钮：在光标处插入 @ 并聚焦，直接进入浮层 */
  const insertAt = (): void => {
    const element = textareaRef.current;
    if (element === null) return;
    element.focus();
    const position = element.selectionStart ?? text.length;
    applyText(`${text.slice(0, position)}@${text.slice(position)}`, position + 1);
  };

  const togglePicked = (role: AgentRole): void => {
    setPicked((current) =>
      current.includes(role) ? current.filter((item) => item !== role) : [...current, role],
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // IME 组词中的按键只确认候选词（中文输入）：既不能误选 @ 候选，也不能把半截拼音当消息发出。
    // keyCode 229 兜底不透传 isComposing 的非标准键盘事件（先例：HomeHero 的需求输入框）
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (popoverOpen && mention !== null) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((index) => (candidates.length === 0 ? 0 : (index + 1) % candidates.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((index) =>
          candidates.length === 0 ? 0 : (index - 1 + candidates.length) % candidates.length,
        );
        return;
      }
      if (event.key === 'Enter') {
        const role = candidates[activeIndex];
        if (role !== undefined) {
          event.preventDefault();
          pick(role);
        }
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissedQuery(mention.query);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-2 border-t border-border bg-background px-2.5 py-2 sm:px-3">
      {/* 成员 chips（多选）：点选即指定，@ 提及与勾选取并集 */}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="插入 @ 提及"
          title="插入 @ 提及成员"
          onClick={insertAt}
          disabled={disabled}
          className="shrink-0 text-muted-foreground max-lg:size-11"
        >
          <AtSign className="size-3.5" aria-hidden />
        </Button>
        {roleOrder.map((role) => {
          const meta = roleRegistry[role];
          const active = picked.includes(role);
          return (
            <button
              key={role}
              type="button"
              aria-pressed={active}
              aria-label={`指定${meta.name}`}
              title={meta.blurb}
              onClick={() => togglePicked(role)}
              disabled={disabled}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] transition-colors max-lg:h-11',
                active
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-border bg-background text-muted-foreground hover:bg-accent',
              )}
            >
              <span aria-hidden style={{ color: meta.color }}>
                {meta.emoji}
              </span>
              {meta.name}
              {active && <X className="size-3" aria-hidden />}
            </button>
          );
        })}
      </div>

      <div className="relative">
        {popoverOpen && mention !== null && (
          <MentionPopover candidates={candidates} activeIndex={activeIndex} onPick={pick} />
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onSelect={handleSelect}
          onKeyUp={(event) => syncCaret(event.currentTarget)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={3}
          aria-label="输入消息"
          placeholder="描述你的需求；@成员可指定负责人，运行中发送将作为干预注入"
          className="min-h-11 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        />
      </div>

      <div className="flex items-center gap-1.5">
        {/* 停止（左下，仅运行中显示） */}
        {running && (
          <Button
            variant="destructive"
            size="icon"
            aria-label="停止生成"
            title="停止当前生成（已生成文件保留，可从断点续跑）"
            onClick={onStop}
            disabled={disabled}
            className="size-9 shrink-0 max-lg:size-11"
          >
            <Square className="size-4" aria-hidden />
          </Button>
        )}
        {/* 模式徽标：只读展示（mode 在创建项目时确定，见组件头注释） */}
        <span
          aria-label="生成模式"
          title="模式在创建项目时确定（首页可改），生成中不可切换"
          className="border-border bg-panel text-muted-foreground inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-xs max-lg:h-11"
        >
          {mode === 'fast' ? '⚡' : '🧩'} {modeLabel(mode)}
        </span>

        <span className="min-w-0 flex-1 truncate text-right text-[11px] text-muted-foreground">
          {mentions.length > 0 ? `将发给 ${mentions.length} 位成员` : null}
        </span>

        <Button
          size="icon"
          aria-label="发送消息"
          onClick={submit}
          disabled={blocked || sending || text.trim() === ''}
          className="size-9 shrink-0 rounded-full max-lg:size-11"
        >
          <Send className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
