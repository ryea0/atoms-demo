'use client';

/**
 * 回滚确认对话框（Task 25，DESIGN §3.10 项目级回滚入口）。
 *
 * 时间线「回到此任务前」的确认闸：回滚会把项目文件恢复到检查点快照——
 * **未保存的人工修改会被覆盖**（已落库的人工内容会先入版本历史，可再撤销），
 * 必须让用户显式确认。本组件只负责确认语义，POST 与快照刷新收口在 Workspace。
 */
import { Loader2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface RollbackDialogProps {
  open: boolean;
  /** 关闭请求（Esc / 点遮罩 / 取消）：仅未在进行中时允许关闭 */
  onOpenChange: (open: boolean) => void;
  /** 目标检查点（展示用） */
  checkpointLabel: string;
  /** 确认回滚（Workspace 发 POST 并刷新快照） */
  onConfirm: () => void;
  /** 请求进行中（按钮禁用 + 转圈，防双击重复回滚） */
  pending?: boolean;
}

export function RollbackDialog({
  open,
  onOpenChange,
  checkpointLabel,
  onConfirm,
  pending = false,
}: RollbackDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" role="alertdialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <Undo2 className="size-4" aria-hidden />
            回到此任务前
          </DialogTitle>
          <DialogDescription>
            将把项目文件恢复到检查点 <span className="font-mono text-foreground">{checkpointLabel}</span> 时的快照：
            该检查点之后的任务产出会被撤销，
            <span className="text-foreground font-medium">未保存的人工修改将被覆盖</span>
            （回滚前的内容会进入版本历史，可再撤销）。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending} className="max-lg:h-11">
            取消
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending} className="max-lg:h-11">
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Undo2 className="size-4" aria-hidden />}
            {pending ? '回滚中…' : '确认回滚'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
