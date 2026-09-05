'use client';

/**
 * 编辑能力开关（Task 23，DESIGN §3.9）：人工编辑的总闸——
 * 开 = 完整人机共编（可编辑、可软锁、可裁决）；关 = 纯只读查看器，agent 永不遇软锁。
 *
 * 自包含组件：挂载即读偏好（GET /api/settings），切换即持久化（PUT /api/settings，session 级）。
 * 顶栏挂接点归 T19（TopBar 预留 data-topbar-actions 槽位）；设置页可复用同一组件。
 */
import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { fetchPreferences, putPreferences } from '@/lib/settings/client';
import { DEFAULT_USER_PREFERENCES, type UserPreferences } from '@/lib/settings/types';

export function EditSwitch(props: { className?: string }): React.ReactElement {
  // 偏好是服务端数据：挂载时拉取一次（外部系统同步收在 effect 里，React 规则 3）
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_USER_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchPreferences()
      .then((value) => {
        if (cancelled) return;
        if (value !== null) setPreferences(value);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        console.error('[EditSwitch] 偏好读取失败：', error);
        if (!cancelled) setLoaded(true); // 读失败也能看、能切（切时以 PUT 为准）
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /** 乐观更新 + 失败回滚（切换手感优先，持久化结果以服务端返回为准） */
  const handleToggle = (checked: boolean): void => {
    const previous = preferences;
    setPreferences({ ...previous, editing_enabled: checked });
    setSaving(true);
    void putPreferences({ editing_enabled: checked })
      .then((saved) => {
        if (saved === null) {
          setPreferences(previous); // 请求失败（client 层已 toast）：回滚到切换前
          return;
        }
        setPreferences(saved);
      })
      .finally(() => setSaving(false));
  };

  return (
    <label
      className={props.className ?? 'text-muted-foreground flex items-center gap-2 text-sm select-none'}
      title={
        preferences.editing_enabled
          ? '人工编辑已开启：agent 会避开你正在编辑的文件'
          : '人工编辑已关闭：工作台为只读，agent 不会遇到软锁'
      }
    >
      <span>编辑</span>
      <Switch
        size="sm"
        checked={preferences.editing_enabled}
        disabled={!loaded || saving}
        onCheckedChange={handleToggle}
        aria-label="人工编辑能力开关"
      />
    </label>
  );
}
