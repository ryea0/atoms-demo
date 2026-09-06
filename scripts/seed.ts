/**
 * 预置演示项目 CLI（Task 25，`npm run seed`）。
 *
 * 逻辑收口在 src/lib/seed.ts（服务层可测、与生产同一仓库层写路径）；本文件只做
 * 进程装配：取存储 → 执行 → 打印结果。幂等：projects 表非空即跳过，可重复执行。
 *
 * 用法：
 *   npm run seed                 # 写入 data/app.db（DB_FILE 可覆盖目标库）
 *   DB_FILE=data/app.db npm run seed
 */
import { createStorage } from '@/lib/db';
import { seedDemoProjects } from '@/lib/seed';

async function main(): Promise<void> {
  const storage = createStorage();
  const result = await seedDemoProjects(storage);

  if (result.skipped) {
    console.log('已跳过：数据库中已有项目（seed 仅在 projects 表为空时写入）。');
    return;
  }
  for (const project of result.created) {
    console.log(`已插入演示项目 #${project.id}：${project.title}（${project.status}）`);
  }
  console.log(`完成：共 ${result.created.length} 个预置项目。`);
}

main().catch((error: unknown) => {
  console.error('[seed] 执行失败：', error);
  process.exitCode = 1;
});
