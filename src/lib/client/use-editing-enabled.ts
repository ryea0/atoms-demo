'use client';

/**
 * 编辑能力开关订阅（Task 21 查看器消费，DESIGN §3.9）。
 *
 * 读侧与 EditSwitch（T23）同源：GET /api/settings 的 preferences.editing_enabled。
 * 抽成小 hook 是因为查看器的编辑按钮是另一个挂载点——false 时整个按钮不渲染（纯只读）。
 * 默认值沿用 DEFAULT_USER_PREFERENCES（编辑开），加载完成前按钮可见但行为不受影响；
 * 读失败按「开启」处理（与 EditSwitch 一致：不因偏好接口抖动把工作台变成只读）。
 */
import { useEffect, useState } from 'react';
import { fetchPreferences } from '@/lib/settings/client';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '@/lib/settings/types';

export interface EditingEnabledState {
  /** 是否允许人工编辑（偏好未返回前按默认值 true） */
  enabled: boolean;
  /** 偏好是否已从服务端加载（false 时消费方可先按默认值渲染） */
  loaded: boolean;
}

export function useEditingEnabled(): EditingEnabledState {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_USER_PREFERENCES);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchPreferences()
      .then((value) => {
        if (cancelled) return;
        if (value !== null) setPreferences(value);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        // 读失败也按开启处理（client 层已 toast），不静默吞——记日志便于排查
        console.error('[viewer] 编辑偏好读取失败：', error);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { enabled: preferences.editing_enabled, loaded };
}
