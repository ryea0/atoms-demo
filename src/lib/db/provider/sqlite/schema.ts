/**
 * SQLite schema（drizzle sqlite-core）——DESIGN §7 全部 12 张表
 *
 * 约定（.claude/rules/05）：
 * - SQLite 无 jsonb：JSON 一律 `text({ mode: 'json' })`，枚举用 `text().$type<Union>()`
 *   （枚举类型用领域类型的索引访问，如 `Project['mode']`，保证单一事实来源不漂移）
 * - 每表自增 `id` 主键 + `created_at`（integer 毫秒，`$defaultFn` JS 侧生成）
 * - 业务表带 `project_id` 外键并级联删除；llm_providers / llm_models / agent_model_bindings /
 *   preferences 为全局表（DESIGN §7），不带 project_id
 * - 唯一约束显式命名（files_project_path / preferences_scope_target / agent_model_bindings 的 role）
 * - fresh 库自举 DDL 见 ./ddl.ts（列集合一致性有测试守护）
 */
import { integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import type { AgentRole, FileRow, Message, Project, ProjectStatus, RunStatus } from '../types';

/** 项目（一句话需求 → 一次生成会话） */
export const projects = sqliteTable('projects', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull(),
  title: text('title').notNull(),
  requirement: text('requirement').notNull(),
  mode: text('mode').$type<Project['mode']>().notNull(),
  status: text('status').$type<ProjectStatus>().notNull().default('draft'),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
  updatedAt: integer('updated_at').notNull().$defaultFn(() => Date.now()),
});

/** 聊天/干预消息：role='intervention' 且 delivered_at IS NULL 即待注入干预队列（DESIGN §3.5） */
export const messages = sqliteTable('messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  role: text('role').$type<Message['role']>().notNull(),
  content: text('content').notNull(),
  /** @ 指定成员等元数据（DESIGN §3.1） */
  meta: text('meta', { mode: 'json' }).$type<Exclude<Message['meta'], null>>(),
  deliveredAt: integer('delivered_at'),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});

/** agent 任务运行记录：summary 是子任务间唯一交接物（CLAUDE.md 规则 7） */
export const agentRuns = sqliteTable('agent_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  taskKey: text('task_key').notNull(),
  agent: text('agent').$type<AgentRole>().notNull(),
  task: text('task').notNull(),
  status: text('status').$type<RunStatus>().notNull().default('pending'),
  summary: text('summary'),
  startedAt: integer('started_at'),
  endedAt: integer('ended_at'),
  error: text('error'),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});

/** 虚拟文件系统：agent 读写只走本表（CLAUDE.md 规则 6）；(project_id, path) 唯一 */
export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    content: text('content').notNull(),
    producedBy: text('produced_by').$type<FileRow['producedBy']>().notNull(),
    /** 最后编辑者：agent 角色名 / human（M 角标双色溯源，DESIGN §3.9） */
    lastEditor: text('last_editor').$type<FileRow['lastEditor']>().notNull(),
    /** 人工编辑软锁：编辑者标识，TTL 由 editing_expires_at 控制 */
    editingBy: text('editing_by'),
    editingExpiresAt: integer('editing_expires_at'),
    /** 乐观锁版本号（人工保存 CAS 用，DESIGN §3.9） */
    version: integer('version').notNull().default(1),
    createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
    updatedAt: integer('updated_at').notNull().$defaultFn(() => Date.now()),
  },
  (t) => [unique('files_project_path').on(t.projectId, t.path)],
);

/** 文件历史版本：file_end/人工保存覆盖写时旧版本入此表（diff/回滚，DESIGN §3.10） */
export const fileVersions = sqliteTable('file_versions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fileId: integer('file_id')
    .notNull()
    .references(() => files.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  content: text('content').notNull(),
  editor: text('editor').notNull(),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});

/** LLM 服务商（全局，不含 project_id） */
export const llmProviders = sqliteTable('llm_providers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  /** 仅服务端使用，绝不进日志/前端/SSE（.claude/rules/07） */
  apiKey: text('api_key').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});

/** 模型清单（全局）：单价用于 llm_calls 成本核算（DESIGN §5③） */
export const llmModels = sqliteTable('llm_models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  providerId: integer('provider_id')
    .notNull()
    .references(() => llmProviders.id, { onDelete: 'cascade' }),
  modelId: text('model_id').notNull(),
  displayName: text('display_name').notNull(),
  priceInput: real('price_input').notNull().default(0),
  priceOutput: real('price_output').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});

/** 角色级模型绑定（全局）：role 唯一，一角色一绑定（DESIGN §5①） */
export const agentModelBindings = sqliteTable(
  'agent_model_bindings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    role: text('role').$type<AgentRole>().notNull(),
    providerId: integer('provider_id')
      .notNull()
      .references(() => llmProviders.id, { onDelete: 'cascade' }),
    modelId: integer('model_id')
      .notNull()
      .references(() => llmModels.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
  },
  (t) => [unique('agent_model_bindings_role').on(t.role)],
);

/** LLM 调用计量：每次调用一行，usage 缺失时按估算公式落库并标 estimated（DESIGN §4.4/§5③） */
export const llmCalls = sqliteTable('llm_calls', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  agentRole: text('agent_role').$type<AgentRole>().notNull(),
  model: text('model').notNull(),
  promptTokens: integer('prompt_tokens').notNull(),
  completionTokens: integer('completion_tokens').notNull(),
  /** 1=估算值（usage 获取降级），0=真实 usage */
  estimated: integer('estimated').notNull().default(0),
  cost: real('cost').notNull().default(0),
  latencyMs: integer('latency_ms').notNull(),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});

/** 个人偏好（全局，scope 级）：editing_enabled 等开关（DESIGN §3.9/§4.2） */
export const preferences = sqliteTable(
  'preferences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    scope: text('scope').$type<'session' | 'user'>().notNull(),
    targetId: text('target_id').notNull(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
  },
  (t) => [unique('preferences_scope_target').on(t.scope, t.targetId)],
);

/** 项目级检查点：每个 agent 任务开始前自动打点（DESIGN §3.10） */
export const checkpoints = sqliteTable('checkpoints', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  projectId: integer('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  /** 打点时的任务 run（软引用：runs 与 checkpoints 随 project 级联，不单删） */
  agentRunId: integer('agent_run_id'),
  /**
   * 打点时刻该项目最大的 agent_runs.id（回滚标记边界：restore 后 id > afterRunId 的
   * 任务标 rolled_back）。检查点在任务开跑**前**打，run id 尚不存在，故须打点时捕获。
   * 旧库行经 ALTER 迁移默认 0（= 回滚标记全部 run，dev 数据保守语义）。
   */
  afterRunId: integer('after_run_id').notNull().default(0),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});

/** 检查点文件快照（全量，事务内恢复；比领域类型多 id/created_at，仓库层映射） */
export const checkpointFiles = sqliteTable('checkpoint_files', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  checkpointId: integer('checkpoint_id')
    .notNull()
    .references(() => checkpoints.id, { onDelete: 'cascade' }),
  path: text('path').notNull(),
  content: text('content').notNull(),
  createdAt: integer('created_at').notNull().$defaultFn(() => Date.now()),
});
