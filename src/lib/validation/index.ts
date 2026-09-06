/**
 * 校验与安全层公共入口（DESIGN §5③ / rules/07「生成物安全」）。
 * 纯函数层：path + content 进，verdict 出——零 db import、零仓库依赖，
 * 供 file_end 落库前校验（编排器）与 preview 组装前复检（预览装配）调用。
 */
import type { Danger } from './danger';
import { scanDanger } from './danger';
import { checkSyntax, extensionOf } from './syntax';
import { resolveProfileByExtension } from '@/lib/languages';

export { checkSyntax, extensionOf, type SyntaxReport } from './syntax';
export { scanDanger, type Danger, type DangerRule } from './danger';

/** 单文件最终裁决 */
export interface FileValidation {
  /** 无 hard 违规且无语法错误才为 true；soft 警告不拦截 */
  ok: boolean;
  hard: Danger[];
  soft: Danger[];
  syntaxError?: string;
}

/**
 * 综合校验：语法（checkSyntax）+ 危险 API（scanDanger）。
 * 语法错误不影响 scanDanger 照常跑（其内部已退回正则粗扫），两者结论并列返回。
 * 后端语言档案优先（.ts/.py…）；未注册后缀（html/md/…）走下方原路径。
 */
export function validateFile(path: string, content: string): FileValidation {
  const profile = resolveProfileByExtension(extensionOf(path));
  if (profile !== null) {
    return assemble(profile.checkSyntax(path, content), profile.scanDanger(path, content));
  }
  return assemble(checkSyntax(path, content), scanDanger(path, content));
}

function assemble(syntax: ReturnType<typeof checkSyntax>, dangers: ReturnType<typeof scanDanger>): FileValidation {
  const hard = dangers.filter((item) => item.severity === 'hard');
  const soft = dangers.filter((item) => item.severity === 'soft');
  return { ok: hard.length === 0 && syntax.ok, hard, soft, syntaxError: syntax.error };
}
