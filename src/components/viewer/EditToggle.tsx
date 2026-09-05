'use client';

/**
 * 编辑按钮（Task 21，DESIGN §3.9 人机共编入口）。
 *
 * 只负责「要不要/能不能编辑」这一件事：偏好开关（editing_enabled）关闭时整个按钮不渲染
 * （纯只读查看器）；文件在流式生成中或尚未落库（无 fileId，无法走 PATCH/软锁）时禁用。
 * 点击后进入编辑态的具体行为（软锁声明、textarea、保存）由查看器容器处理。
 */
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useEditingEnabled } from '@/lib/client/use-editing-enabled';

export interface EditToggleProps {
  /** 文件当前是否允许进入编辑（流式中 / 无 fileId = false） */
  disabled?: boolean;
  /** 禁用原因（title 与读屏可见） */
  disabledReason?: string;
  /** 点击「编辑」进入编辑态 */
  onEnterEditing: () => void;
}

export function EditToggle({
  disabled = false,
  disabledReason,
  onEnterEditing,
}: EditToggleProps): React.ReactElement | null {
  const { enabled } = useEditingEnabled();

  // 偏好关闭 = 工作台只读（agent 永不遇软锁），编辑入口整体隐藏
  if (!enabled) return null;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-label="编辑文件"
      title={disabled ? (disabledReason ?? '当前不可编辑') : '编辑该文件（保存时与 agent 写入走同一 CAS 校验）'}
      disabled={disabled}
      onClick={onEnterEditing}
      className="max-lg:h-11 gap-1.5"
    >
      <Pencil className="size-3.5" aria-hidden />
      编辑
    </Button>
  );
}
