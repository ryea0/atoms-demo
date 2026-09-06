/**
 * T30 测试：samples/app-skeleton 的启动脚本模板（renderStartSh）端口契约。
 *
 * 用户反馈：导出项目 `bash start_app.sh` 默认端口 3000 与平台自身 dev server（3000）撞车。
 * 契约：
 * - 默认端口 3001（shell 侧等价 `process.env.PORT || 3001`：PORT 环境变量可覆盖）
 * - 启动提示必须给出端口占用的自救说明「若端口被占用：PORT=xxxx bash start_app.sh」
 * mock provider（mock.ts）、seed（seed.ts）、保底模板（engineer.renderFallbackFile）
 * 都走这一个渲染函数——单点修正三处生效。
 */
import { describe, expect, it } from 'vitest';
import { renderStartSh } from '@/lib/agents/roles/samples/app-skeleton';

describe('renderStartSh 启动脚本模板', () => {
  const script = renderStartSh();

  it('默认端口 3001（PORT 环境变量可覆盖），不再钉 3000', () => {
    expect(script).toContain('PORT="${PORT:-3001}"');
    expect(script).not.toContain('3000');
  });

  it('启动提示给出端口占用自救说明：若端口被占用：PORT=xxxx bash start_app.sh', () => {
    expect(script).toContain('若端口被占用：PORT=xxxx bash start_app.sh');
  });

  it('本地静态预览入口：服务 app/frontend/index.html（提示里带端口变量）', () => {
    expect(script).toContain('app/frontend/index.html');
    expect(script).toContain('${PORT}');
  });

  it('保持 POSIX sh 与零依赖承诺：sh shebang、可执行行不含 npm 安装面', () => {
    expect(script.startsWith('#!/usr/bin/env sh')).toBe(true);
    // 只看可执行行（排除注释与 echo 文案——echo 里的「不做 npm install」是承诺，不是命令）
    const commands = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('echo '));
    expect(commands.some((line) => /^npm\s/.test(line))).toBe(false);
    // bash 专属条件语法不入脚本（用户可能用 sh 执行）
    expect(commands.some((line) => line.startsWith('[['))).toBe(false);
  });
});
