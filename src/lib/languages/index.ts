/**
 * 语言注册表（DESIGN §12「语言」行）：后缀查表 + 路径集合判定 + 缺省回退。
 * 声明序即预览入口探测序——js 打头保证存量项目行为不变；
 * 未知回退 javascript 的先例 = EXEC_PROVIDER 未知值回退 local。
 */
import type { LanguageProfile } from './types';
import { javascriptProfile } from './profiles/javascript';
import { typescriptProfile } from './profiles/typescript';

export type { LanguageProfile, LanguageId, PreviewRuntime } from './types';

export const LANGUAGE_PROFILES: readonly LanguageProfile[] = [javascriptProfile, typescriptProfile];

const BY_EXTENSION = new Map<string, LanguageProfile>(
  LANGUAGE_PROFILES.map((profile) => [profile.backendExtension, profile]),
);

/** 按后缀查档案；未注册后缀（html/md/css…）返回 null */
export function resolveProfileByExtension(ext: string): LanguageProfile | null {
  return BY_EXTENSION.get(ext.toLowerCase()) ?? null;
}

/** 从文件路径集合判定项目语言（后端入口在册即中；无 → 默认 js） */
export function resolveProfileByPaths(paths: Iterable<string>): LanguageProfile {
  for (const profile of LANGUAGE_PROFILES) {
    for (const path of paths) {
      if (path === profile.backendEntryPath) return profile;
    }
  }
  return defaultLanguageProfile();
}

/** 缺省回退（含未知后缀场景） */
export function defaultLanguageProfile(): LanguageProfile {
  return javascriptProfile;
}

export { javascriptProfile } from './profiles/javascript';
