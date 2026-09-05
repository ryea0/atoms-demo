/**
 * 虚拟文件系统路径沙箱（.claude/rules/07「虚拟文件系统沙箱」红线）。
 * 所有 FS 工具的 path 入参必须先过 normalizeProjectPath：
 * 拒绝绝对路径、反斜杠、null 字节、`..`/`.` 相对段、空段、非法字符、超长路径——
 * 不做任何"尽力修复"式的静默改写，宁可拒绝也不放行。
 */

/** 路径总长上限（字符） */
const MAX_PATH_CHARS = 200;

/** 单段字符白名单：字母/数字/点/下划线/中划线（`.`、`..` 段已单独拒绝） */
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

/** 校验结果：ok=true 携带归一化后的项目内相对路径；ok=false 携带可直接回喂模型的中文原因 */
export type PathCheckResult = { ok:true; path:string } | { ok:false; error:string };

/**
 * 校验并归一化项目内路径。
 * 入参必须是相对项目根的 `/` 分隔路径；通过校验后原样返回（无 `..`、空段、首尾斜杠可归一）。
 */
export function normalizeProjectPath(input:string):PathCheckResult {
  if (input.length === 0) return { ok:false, error:'路径不能为空' };
  if (input.length > MAX_PATH_CHARS) return { ok:false, error:`路径长度 ${input.length} 超过上限 ${MAX_PATH_CHARS} 字符` };
  if (input.startsWith('/')) return { ok:false, error:'拒绝绝对路径：必须相对项目根，不能以 / 开头' };
  if (input.endsWith('/')) return { ok:false, error:'路径不能以 / 结尾' };
  if (input.includes('\\')) return { ok:false, error:'拒绝反斜杠：路径分隔符只能用 /' };
  if (input.includes('\0')) return { ok:false, error:'路径包含非法空字节 \\0' };

  const segments = input.split('/');
  for (const segment of segments) {
    if (segment.length === 0) return { ok:false, error:'路径包含空段（不允许连续 //）' };
    if (segment === '.' || segment === '..') {
      return { ok:false, error:`拒绝相对路径段 "${segment}"（防目录逃逸）` };
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      return { ok:false, error:`路径段 "${segment}" 含非法字符（仅允许 A-Za-z0-9._-）` };
    }
  }
  return { ok:true, path: segments.join('/') };
}
