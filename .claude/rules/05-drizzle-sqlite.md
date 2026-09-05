# Drizzle + SQLite 规则

> 来源：SQLite 官方 WAL 文档、Drizzle 文档/issue（见文末）

## 驱动与连接
- better-sqlite3 单例连接（全局缓存），开启 `journal_mode = WAL`、`synchronous = NORMAL`、`foreign_keys = ON`（PRAGMA 在连接初始化执行）
- WAL 喜欢小事务：**保持事务短小**——一次事务只做一组紧密写（如"回滚=事务内恢复 files"），不在事务里做 LLM 调用等慢操作
- 数据库文件固定 `data/app.db`（部署挂持久卷），目录不存在则创建

## Schema
- SQLite 方言：**没有 jsonb**——JSON 字段用 `text({ mode: 'json' })`，类型标注 `.$type<T>()`
- 每表必带：`id`（自增主键）、`created_at`（integer timestamp，`$defaultFn(() => Date.now())`）
- 唯一约束显式声明（如 files 的 `unique('files_project_path').on(t.projectId, t.path)`）
- 枚举用 text + `$type<Union>()`，不用 check 约束
- 所有业务表带 `project_id` 外键；级联删除用 `onDelete: 'cascade'`

## 查询纪律
- **所有查询经仓库层**（`src/lib/db/repo/`），仓库函数强制接收 projectId 并过滤——路由/服务层禁止直接摸 db
- 更新走乐观锁：`update().set({...}).where(and(eq(id), eq(version, baseVersion)))`，影响行数=0 视为冲突
- 动态条件用 `and(...conditions.filter(Boolean))` 组装，防 undefined 进 where
- N+1 禁止：列表页聚合（文件数、token 汇总）用 `groupBy` 一次查完

## 迁移
- schema 变更后 `npm run db:push`（开发）；生产部署前同命令幂等执行
- 迁移不入 seed 数据；seed 独立脚本（scripts/seed.ts）

## 来源
- https://www.sqlite.org/wal.html
- https://orm.drizzle.team/docs/overview
- https://github.com/drizzle-team/drizzle-orm/issues/4968
