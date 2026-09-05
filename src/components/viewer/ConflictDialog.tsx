'use client';

/**
 * 冲突对话框（Task 21，DESIGN §3.9 检测层）：人工保存遇 409（CAS 失败，agent 已写入新版本）。
 *
 * 三选：「用我的版本」（以服务端最新版本重发，覆盖 agent 内容）/
 *       「用 agent 的版本」（放弃草稿）/「并排对比」（两栏 pre + 整行红绿行级差异后再选）。
 * 三选只回调，不直接发请求——写路径收口在查看器容器，方便统一处理保存态与软锁释放。
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { diffLines } from '@/lib/client/diff-lines';

export interface ConflictDialogProps {
  open: boolean;
  /** 关闭请求（Esc / 点遮罩）：容器据此取消本次保存（草稿保留在编辑态里） */
  onOpenChange: (open: boolean) => void;
  /** 我的草稿 */
  mine: string;
  /** 服务端当前内容（409 响应带回） */
  theirs: string;
  /** 保留我的版本 */
  onKeepMine: () => void;
  /** 采用 agent 版本（放弃草稿） */
  onUseTheirs: () => void;
}

export function ConflictDialog({
  open,
  onOpenChange,
  mine,
  theirs,
  onKeepMine,
  onUseTheirs,
}: ConflictDialogProps): React.ReactElement {
  const [showDiff, setShowDiff] = useState(false);
  const rows = showDiff ? diffLines(mine, theirs) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>工程师已更新</DialogTitle>
          <DialogDescription>
            你编辑期间 agent 已写入该文件的新版本。请选择保留哪个版本（选择前可并排对比差异）。
          </DialogDescription>
        </DialogHeader>

        {showDiff ? (
          <div className="border-border bg-panel max-h-[45vh] overflow-auto rounded-lg border">
            <div className="grid grid-cols-2">
              <div className="border-border text-muted-foreground border-r px-3 py-1.5 text-xs font-medium">
                我的修改
              </div>
              <div className="text-muted-foreground px-3 py-1.5 text-xs font-medium">agent 最新版本</div>
              {rows.map((row, index) => (
                // rows 每次渲染由 diffLines 全量重算、不增删/重排，按下标作 key 稳定
                <DiffRowView key={index} left={row.left} right={row.right} same={row.same} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">
              你可以在并排对比里查看两版差异；不选择则保留现状（草稿仍在编辑框中，可继续修改）。
            </p>
            <div className="border-border bg-panel rounded-lg border">
              <p className="text-muted-foreground border-border border-b px-3 py-1.5 text-xs font-medium">
                agent 最新版本
              </p>
              <pre className="font-mono max-h-32 overflow-auto px-3 py-2 text-xs whitespace-pre-wrap">
                {theirs}
              </pre>
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => setShowDiff((value) => !value)}
            aria-label={showDiff ? '收起对比' : '并排对比'}
            className="max-lg:h-11 mr-auto"
          >
            {showDiff ? '收起对比' : '并排对比'}
          </Button>
          <Button type="button" variant="outline" onClick={onUseTheirs} className="max-lg:h-11">
            用 agent 的版本
          </Button>
          <Button type="button" onClick={onKeepMine} className="max-lg:h-11">
            用我的版本
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 一行对照：左=我的版本，右=agent 版本；不同行整行着色（红=会被覆盖 / 绿=将采用） */
function DiffRowView({
  left,
  right,
  same,
}: {
  left: string | null;
  right: string | null;
  same: boolean;
}): React.ReactElement {
  return (
    <>
      <pre
        className={
          same
            ? 'border-border font-mono min-w-0 border-r px-3 py-0.5 text-xs whitespace-pre-wrap'
            : 'border-border bg-destructive/10 text-destructive font-mono min-w-0 border-r px-3 py-0.5 text-xs whitespace-pre-wrap'
        }
      >
        {left ?? ''}
      </pre>
      <pre
        className={
          same
            ? 'font-mono min-w-0 px-3 py-0.5 text-xs whitespace-pre-wrap'
            : 'bg-brand/10 text-brand font-mono min-w-0 px-3 py-0.5 text-xs whitespace-pre-wrap'
        }
      >
        {right ?? ''}
      </pre>
    </>
  );
}
