/**
 * 设置页表单字段标签（客户端安全）。ui/label 未安装，且不改共享 ui 目录——
 * 就地用原生 label + 统一 token 类名（.claude/rules/04：不写自定义 CSS、不用魔法色值）。
 */
import { cn } from '@/lib/utils';

export function FieldLabel(props: { htmlFor: string; children: React.ReactNode; className?: string }): React.ReactElement {
  return (
    <label
      htmlFor={props.htmlFor}
      className={cn('text-foreground text-sm leading-none font-medium', props.className)}
    >
      {props.children}
    </label>
  );
}
