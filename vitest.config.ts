import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    // 排除 SDD 并行 worktree（否则会把在途分支的测试文件扫进主干套件）
    exclude: ['**/node_modules/**', '**/dist/**', '.superpowers/**'],
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
