'use client';

/**
 * 聊天面板（Task 19）：消息流 + 任务时间线 + 输入区的组合，落在工作台聊天区槽位。
 *
 * 数据统一来自 useWorkspace 的快照（由 Workspace 传入，本组件不自建 SSE 连接——
 * store 是 per-project 单例，双重订阅会出现两条 EventSource）。REST 调用集中在这里
 * （POST messages / POST stop），子组件保持纯展示；查看器/回滚的接线（T25）通过
 * onOpenFile / onRollback 回调上抛，本组件不直接操作查看器。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { ChatInput, type ChatInputSendInput } from './ChatInput';
import { LiveAgentBlock } from './LiveAgentBlock';
import { MessageList } from './MessageList';
import { Timeline } from './Timeline';
import { isGenerationRunning } from '@/lib/client/format';
import { sendProjectMessage, stopProjectGeneration } from '@/lib/client/session';
import { createWorkspaceStore, type WorkspaceState } from '@/lib/client/store';

export interface ChatPanelProps {
  /** 工作台聚合状态（Workspace 从 useWorkspace 取好后传入） */
  state: WorkspaceState;
  /** 点击文件产物卡打开对应文件（T25 接线到查看器） */
  onOpenFile?: (path: string) => void;
  /** 时间线「回到此任务前」（T25 接线到检查点回滚） */
  onRollback?: (runId: number) => void;
}

export function ChatPanel({ state, onOpenFile, onRollback }: ChatPanelProps): ReactElement {
  const projectId = state.projectId;

  const running = isGenerationRunning({
    finished: state.finished,
    projectStatus: state.project?.status ?? null,
    runningRunCount: state.runs.filter((run) => run.status === 'running').length,
    livePathCount: state.livePaths.length,
  });

  // 新消息/新任务到达时贴底（滚动是外部系统同步，走 ref 不走 state；内容 delta 不触发，不打扰用户回看）
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const feedLength = `${state.messages.length}:${state.runs.length}`;
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [feedLength]);

  /** 请求在途守卫（T31）：从点击发送到 POST 返回期间禁用发送，防黑盒期重复提交 */
  const [sending, setSending] = useState(false);

  /** 发送（空闲=新一轮；运行中=干预入队）。失败回滚乐观气泡 + toast，返回 false（输入不清空） */
  const handleSend = useCallback(
    async (input: ChatInputSendInput): Promise<boolean> => {
      if (projectId === null) return false;
      const store = createWorkspaceStore(projectId);
      // 发送即上屏（乐观气泡，合成负数 id）：模型思考以分钟计，用户的第一反馈是「话已送到」；
      // 成功后由持久化行收编（同内容匹配，不产生双气泡），失败则原样回滚
      const localId = store.appendLocalUserMessage({
        projectId,
        content: input.content,
        mentions: input.mentions,
      });
      setSending(true);
      try {
        // 发送前取号（T32 I2）：fire-and-forget 轮可能在响应返回前就 done，
        // 号对不上时 beginRound 不复位 finished（不把已完成的背景轮拉回 running）
        const ticket = store.roundTicket();
        const result = await sendProjectMessage(projectId, input);
        if (result.delivered === 'intervention' && result.messageId !== undefined) {
          // 入队分支只落库不发 SSE：用响应 messageId 本地补登待注入卡，「📥 排队中」即时可见，
          // 之后同 messageId 的 intervention_injected 事件把它翻转为「已注入 {文件}」；
          // 队列卡接管这条消息的展示，乐观气泡随即让位（避免同文案出现两份）
          store.appendPendingIntervention({
            projectId,
            messageId: result.messageId,
            content: input.content,
            mentions: input.mentions,
          });
          store.removeLocalMessage(projectId, localId);
        } else {
          // 新一轮开跑：复位上一轮遗留的 finished，停止钮/干预黄条/直播块立即生效
          store.beginRound(projectId, ticket);
        }
        return true;
      } catch (error) {
        store.removeLocalMessage(projectId, localId);
        console.error('[chat] 消息发送失败：', error);
        toast.error('发送失败', {
          description: error instanceof Error ? error.message : '请稍后重试',
        });
        return false;
      } finally {
        setSending(false);
      }
    },
    [projectId],
  );

  /** 裁决按钮 / 队列卡等以纯文本回发（不带 @） */
  const handleSendText = useCallback(
    (content: string): Promise<boolean> => handleSend({ content, mentions: [] }),
    [handleSend],
  );

  const handleStop = useCallback((): void => {
    if (projectId === null) return;
    void stopProjectGeneration(projectId).catch((error: unknown) => {
      console.error('[chat] 停止失败：', error);
      toast.error('停止失败', { description: error instanceof Error ? error.message : '请稍后重试' });
    });
  }, [projectId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 快照加载失败 / 流内顶层错误：顶部红条（失败红条），不静默吞 */}
      {state.error !== null && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-1.5 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span aria-hidden>⚠️</span>
          <span className="min-w-0 flex-1 break-words">{state.error}</span>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <MessageList
          messages={state.messages}
          files={state.files}
          runs={state.runs}
          finished={state.finished}
          running={running}
          onOpenFile={onOpenFile}
          onSend={handleSendText}
        />
        {/* 直播转录块（T31，吸收取代 T30 活动行）：谁在干活、在想什么、正在写哪个文件 */}
        <LiveAgentBlock live={state.liveAgents} onOpenFile={onOpenFile} />
        {state.runs.length > 0 && <Timeline runs={state.runs} onRollback={onRollback} running={running} />}
      </div>

      {/* 运行中：发送即干预入队（DESIGN §3.5 两级边界注入） */}
      {running && (
        <p className="shrink-0 border-t border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
          <span aria-hidden>📥</span> 将注入下一个步骤
          <span className="ml-1 text-amber-700/80">（运行中发送会排队，不打断当前生成）</span>
        </p>
      )}

      <ChatInput
        onSend={handleSend}
        onStop={handleStop}
        running={running}
        mode={state.project?.mode ?? 'full'}
        disabled={projectId === null}
        inFlight={sending}
      />
    </div>
  );
}
