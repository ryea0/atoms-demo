'use client';

/**
 * 首页 hero（Task 17）：七角色头像排、大标题、大输入卡（textarea 自适应 + 模式胶囊 +
 * ⊕ 占位 + 黑色圆形发送）、示例 chips、可关闭公告条。
 * 提交 → POST /api/projects → router.push(`/p/${id}`)。
 * @ 成员浮层只在输入卡里预留位置（T19 接线），本组件不实现浮层逻辑。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp, Plus, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { roleOrder, roleRegistry } from '@/lib/agents/registry';
import { ApiError, createProject, dismissAnnouncement, isAnnouncementDismissed } from '@/lib/client/session';

/** 示例 chips（点击回填输入框） */
const SAMPLES = [
  { label: '番茄钟', prompt: '做一个番茄钟，可以开始暂停和重置' },
  { label: '待办清单', prompt: '做一个待办清单应用，支持增删改查和完成标记' },
  { label: '数据看板', prompt: '做一个销售数据看板，含指标卡与趋势图' },
] as const;

type Mode = 'fast' | 'full';

export function HomeHero() {
  const router = useRouter();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [requirement, setRequirement] = useState('');
  const [mode, setMode] = useState<Mode>('fast');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcementOpen, setAnnouncementOpen] = useState(true);

  // 公告条关闭标记在 sessionStorage（会话级）；只在挂载时读一次外部存储
  useEffect(() => {
    if (isAnnouncementDismissed()) setAnnouncementOpen(false);
  }, []);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, []);

  const submit = useCallback(() => {
    const text = requirement.trim();
    if (text === '' || submitting) return;
    setSubmitting(true);
    setError(null);
    void createProject({ requirement: text, mode })
      .then(({ project }) => router.push(`/p/${project.id}`))
      .catch((cause: unknown) => {
        setSubmitting(false);
        const message = cause instanceof ApiError ? cause.message : '创建项目失败，请稍后再试';
        setError(message);
      });
  }, [mode, requirement, router, submitting]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-16">
      {/* 公告条 */}
      {announcementOpen ? (
        <div className="mb-10 flex items-center gap-2 rounded-full border border-border bg-panel px-4 py-1.5 text-xs text-muted-foreground">
          <Sparkles className="size-3.5 text-brand" aria-hidden />
          <span>v1 支持多智能体团队协作</span>
          <button
            type="button"
            aria-label="关闭公告"
            onClick={() => {
              setAnnouncementOpen(false);
              dismissAnnouncement();
            }}
            className="rounded-full p-0.5 transition-colors hover:bg-background hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      {/* 七角色头像排 */}
      <ul className="mb-5 flex items-center -space-x-2">
        {roleOrder.map((role) => {
          const meta = roleRegistry[role];
          return (
            <li
              key={role}
              title={`${meta.name} · ${meta.blurb}`}
              className="flex size-9 items-center justify-center rounded-full border-2 bg-background"
              style={{ borderColor: meta.color }}
            >
              <span aria-hidden>{meta.emoji}</span>
              <span className="sr-only">{meta.name}</span>
            </li>
          );
        })}
      </ul>

      <h1 className="text-center text-3xl font-semibold tracking-tight">输入想法，产出产品</h1>
      <p className="mt-3 text-center text-sm text-muted-foreground">
        一句话描述需求，领导分派、团队接力，产出 PRD、架构设计与可预览的全栈应用。
      </p>

      {/* 输入卡 */}
      <div className="mt-8 w-full rounded-xl border border-border bg-card p-3">
        <label className="sr-only" htmlFor="home-requirement">
          需求描述
        </label>
        <textarea
          id="home-requirement"
          ref={textareaRef}
          value={requirement}
          onChange={(event) => {
            setRequirement(event.target.value);
            autoResize();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              // IME 组词中的 Enter 只确认候选词（中文输入），不能当提交
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder="描述你想要的应用，团队替你实现"
          className="w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        {/* @ 成员浮层占位：T19 在此处挂浮层（仅位置留白） */}
        <div id="mention-popover-slot" aria-hidden className="h-0" />

        <div className="mt-2 flex items-center gap-2">
          {/* 模式胶囊 */}
          <div className="flex items-center rounded-full border border-border bg-panel p-0.5">
            {(
              [
                { value: 'fast', label: '快速', aria: '快速模式（预置模板加速）' },
                { value: 'full', label: '完整', aria: '完整模式（全量流水线）' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={option.aria}
                aria-pressed={mode === option.value}
                onClick={() => setMode(option.value)}
                className={cn(
                  'rounded-full px-3 py-1 text-xs transition-colors',
                  mode === option.value
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>

          {/* ⊕ 附件/@ 入口（T19 接线） */}
          <button
            type="button"
            aria-label="添加成员或附件"
            title="添加成员或附件（即将上线）"
            className="flex size-8 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-4" aria-hidden />
          </button>

          {error === null ? null : <p className="text-xs text-destructive">{error}</p>}

          {/* 黑色圆形发送 */}
          <button
            type="button"
            aria-label="发送"
            onClick={submit}
            disabled={requirement.trim() === '' || submitting}
            className="ml-auto flex size-9 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-30"
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      {/* 示例 chips */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        {SAMPLES.map((sample) => (
          <button
            key={sample.label}
            type="button"
            onClick={() => {
              setRequirement(sample.prompt);
              autoResize();
            }}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {sample.label}
          </button>
        ))}
      </div>
    </div>
  );
}
