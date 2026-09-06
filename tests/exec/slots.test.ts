// @vitest-environment node
/**
 * 终端运行槽单测（Task 1）：单槽互斥、stop 幂等、release 后可复用。
 */
import { describe, expect, it } from 'vitest';
import { acquireTerminalSlot, activeTerminalRun, releaseTerminalSlot } from '@/lib/exec/slots';

const PROJECT_ID = 9_999_001;

describe('terminal slots', () => {
  it('占用后二次 acquire 返回 null，release 后可重新占用', () => {
    const handle = acquireTerminalSlot(PROJECT_ID, 'echo first');
    expect(handle).not.toBeNull();
    expect(activeTerminalRun(PROJECT_ID)?.command).toBe('echo first');

    expect(acquireTerminalSlot(PROJECT_ID, 'echo second')).toBeNull();

    releaseTerminalSlot(PROJECT_ID);
    expect(activeTerminalRun(PROJECT_ID)).toBeNull();

    const again = acquireTerminalSlot(PROJECT_ID, 'echo third');
    expect(again?.command).toBe('echo third');
    releaseTerminalSlot(PROJECT_ID);
  });

  it('stop 幂等：重复调用不抛', () => {
    const handle = acquireTerminalSlot(PROJECT_ID, 'sleep 60');
    expect(() => {
      handle?.stop();
      handle?.stop();
    }).not.toThrow();
    releaseTerminalSlot(PROJECT_ID);
  });

  it('handle 携带元数据', () => {
    const handle = acquireTerminalSlot(PROJECT_ID, 'ls -R', 12345);
    expect(handle?.pid).toBe(12345);
    expect(handle?.startedAt).toBeGreaterThan(0);
    releaseTerminalSlot(PROJECT_ID);
  });
});
