'use client';

/**
 * 终端面板（受控执行层的展示端，与 PreviewPane 同边界）：纯消费组件——
 * 数据与请求生命周期都在 useTerminal（Workspace 挂载层持有，切视图不杀进程），
 * 本组件只负责行流渲染、贴底滚动（ref 操作，规则 03）与命令输入行/停止按钮。
 *
 * 交互契约：Enter 提交命令（running 时输入禁用）；停止按钮走 terminal.stop()
 * （POST stop 端点，不 abort 读流——exit 确认帧仍会到达）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import { Loader2, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PaneEmpty } from '@/components/workspace/PaneShell';
import type { TerminalController, TerminalLine } from '@/lib/client/terminal';

/** 行颜色语义（token，规则 04）：stderr/error 红、exit 灰、info/exit 之外的输出走前景/次级 */
const KIND_CLASS: Record<TerminalLine['kind'], string> = {
  stdout: 'text-foreground/90',
  stderr: 'text-destructive',
  exit: 'text-muted-foreground',
  error: 'text-destructive',
  info: 'text-foreground',
};

/** 行内链接渲染：URL 段替换为可点 <a>（新窗口 + noreferrer，防 opener 反向操控） */
function TextWithLink({ text, link }: { text: string; link?: string }): ReactElement {
  if (link === undefined) return <>{text}</>;
  const index = text.indexOf(link);
  if (index === -1) {
    return (
      <>
        {text}{' '}
        <a href={link} target="_blank" rel="noreferrer" className="text-primary underline">
          {link}
        </a>
      </>
    );
  }
  return (
    <>
      {text.slice(0, index)}
      <a href={link} target="_blank" rel="noreferrer" className="text-primary underline">
        {link}
      </a>
      {text.slice(index + link.length)}
    </>
  );
}

/** 单行输出：info（命令回显）加粗 $ 前缀；whitespace-pre-wrap 保留行内换行 */
function TerminalRow({ line }: { line: TerminalLine }): ReactElement {
  const isCommandEcho = line.kind === 'info' && line.text.startsWith('$ ');
  const body = isCommandEcho ? line.text.slice(2) : line.text;
  return (
    <p className={KIND_CLASS[line.kind]}>
      {isCommandEcho && (
        <span aria-hidden className="font-semibold">
          {'$ '}
        </span>
      )}
      <TextWithLink text={body} link={line.link} />
    </p>
  );
}

export function TerminalPane({ terminal }: { terminal: TerminalController }): ReactElement {
  const [command, setCommand] = useState('');
  const outputRef = useRef<HTMLDivElement | null>(null);
  /** 用户是否停在输出底部附近（离开底部后新行不再抢滚动位置） */
  const stickToBottomRef = useRef(true);

  const handleScroll = useCallback(() => {
    const element = outputRef.current;
    if (element !== null) {
      stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    }
  }, []);

  // 贴底跟随（照抄 LiveAgentBlock 的 ref 滚动模式）：仅当用户已在底部附近才自动贴底
  useEffect(() => {
    const element = outputRef.current;
    if (element !== null && stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [terminal.lines]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (terminal.running) return;
      const trimmed = command.trim();
      if (trimmed === '') return;
      terminal.run(trimmed);
      setCommand('');
    },
    [command, terminal],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {terminal.lines.length === 0 ? (
        /* 空态：终端能力简介 + 真实执行警示（复用栏位空态样式） */
        <div className="min-h-0 flex-1">
          <PaneEmpty
            hint="在本机执行命令的工作终端"
            sub="命令在本机真实执行，仅限本地/内网演示环境使用"
          />
        </div>
      ) : (
        <div
          ref={outputRef}
          onScroll={handleScroll}
          aria-label="终端输出"
          className="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
        >
          {terminal.lines.map((line) => (
            <TerminalRow key={line.id} line={line} />
          ))}
        </div>
      )}

      {/* 命令输入行：Enter 提交；运行中禁用输入 + 红色停止按钮（调 stop 端点，不 abort 流） */}
      <form
        onSubmit={handleSubmit}
        className="flex h-11 shrink-0 items-center gap-2 border-t border-border bg-background px-2 sm:px-3"
      >
        <span aria-hidden className="shrink-0 font-mono text-xs text-muted-foreground">
          $
        </span>
        <input
          type="text"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={terminal.running}
          placeholder={terminal.running ? '命令运行中…' : '输入命令，回车执行'}
          aria-label="终端命令输入"
          autoComplete="off"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        />
        {terminal.running && (
          <>
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              运行中…
            </span>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={terminal.stop}
              title="停止当前命令"
              /* <lg 扩到 44px 触控目标（规则 04） */
              className="h-7 px-2 text-xs max-lg:h-11"
            >
              <Square className="size-3.5" aria-hidden />
              停止
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
