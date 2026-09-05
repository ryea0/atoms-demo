/**
 * 领域类型 + StorageProvider 契约（DESIGN §12「类型即文档」）
 * 业务代码（编排器/角色/API）只 import 本文件，不感知具体 dialect 实现——
 * 切换存储（sqlite → postgres）时本文件不变。
 */

/** agent 角色：领导/产品/架构/工程师/数据分析师/SEO/广告 */
export type AgentRole = 'leader'|'pm'|'architect'|'engineer'|'analyst'|'seo'|'ads';

/** 项目状态 */
export type ProjectStatus = 'draft'|'running'|'paused'|'done'|'failed';

/** 任务运行状态（rolled_back=检查点回滚后标记，DESIGN §3.10） */
export type RunStatus = 'pending'|'running'|'done'|'failed'|'stopped'|'rolled_back';

export interface Project { id:number; sessionId:string; title:string; requirement:string;
  mode:'fast'|'full'; status:ProjectStatus; createdAt:number; updatedAt:number; }
export interface Message { id:number; projectId:number; role:'user'|'assistant'|'intervention'|'system';
  content:string; meta?:{mentions?:AgentRole[]}|null; deliveredAt:number|null; createdAt:number; }
export interface AgentRun { id:number; projectId:number; taskKey:string; agent:AgentRole; task:string;
  status:RunStatus; summary:string|null; startedAt:number|null; endedAt:number|null; error:string|null; }
/** 文件写入者域：agent 角色名 / human（人机共编）/ seed（预置演示） */
export type FileEditor = AgentRole|'human'|'seed';

export interface FileRow { id:number; projectId:number; path:string; content:string;
  producedBy:FileEditor; lastEditor:AgentRole|'human'|'seed'; editingBy:string|null; editingExpiresAt:number|null;
  version:number; createdAt:number; updatedAt:number; }
export interface FileVersion { id:number; fileId:number; version:number; content:string; editor:string; createdAt:number; }
export interface Checkpoint { id:number; projectId:number; label:string; agentRunId:number|null; createdAt:number; }
export interface CheckpointFile { checkpointId:number; path:string; content:string; }
export interface LlmCall { id:number; projectId:number; agentRole:AgentRole; model:string;
  promptTokens:number; completionTokens:number; estimated:number; cost:number; latencyMs:number; createdAt:number; }

/** createProject 入参（id/status/时间戳由存储层与库默认值生成） */
export interface CreateProjectInput { sessionId:string; title:string; requirement:string; mode:'fast'|'full'; }

/** addMessage 入参（id/deliveredAt/createdAt 由存储层生成） */
export interface AddMessageInput { projectId:number; role:Message['role']; content:string;
  meta?:Message['meta']; }

/** createAgentRun 入参（id/status/时间戳由存储层与库默认值生成：status=pending、started_at 由编排器开跑时补） */
export interface CreateAgentRunInput { projectId:number; taskKey:string; agent:AgentRole; task:string; }

/**
 * updateAgentRun 入参：只推进调用方出现的字段。
 * summary/error/时间戳传 null = 显式清空（如中断后重算降级摘要）；缺省键一律不动库里既有值。
 */
export interface UpdateAgentRunPatch { status?:RunStatus; summary?:string|null; error?:string|null;
  startedAt?:number|null; endedAt?:number|null; }

/** usageByProject 聚合行：tokens=prompt+completion 之和（设置页/卡片墙统计用） */
export interface LlmUsageRow { agentRole:AgentRole; model:string; tokens:number; calls:number; }

/**
 * recordLlmCall 入参（llm 层 meteredCall 结构化落库，字段与 src/lib/llm/usage.ts 的 MeteringSink 一一对应）。
 * estimated=1 表示 usage 缺失按 DESIGN §4.4 公式估算；cost 默认 0（单价未配置时不计费）。
 */
export interface RecordLlmCallInput { projectId:number; agentRole:AgentRole; model:string;
  promptTokens:number; completionTokens:number; estimated:number; cost:number; latencyMs:number; }

/** 偏好作用域：demo 只用 session 级（DESIGN §4.2），user 级为 schema 预留 */
export type PreferenceScope = 'session'|'user';

/** 项目卡片 DTO（列表页一次查询聚合取齐，禁 N+1——.claude/rules/05） */
export type ProjectListItem = Project & {
  /** files 表行数 */
  fileCount:number;
  /** llm_calls 的 prompt+completion 之和（无调用=0） */
  totalTokens:number;
  /** 最后一条消息内容（无消息=null） */
  lastMessage:string|null;
};

/** 项目仓库：全部查询强制 sessionId/projectId 过滤（CLAUDE.md 规则 9） */
export interface ProjectsRepo {
  createProject(input: CreateProjectInput): Promise<Project>;
  listProjects(sessionId: string): Promise<ProjectListItem[]>;
  getProject(projectId: number): Promise<Project|null>;
  renameProject(projectId: number, title: string): Promise<void>;
  /** 级联删除：files/messages/llm_calls/checkpoints 等随外键 onDelete cascade 一起删 */
  deleteProject(projectId: number): Promise<void>;
  updateProjectStatus(projectId: number, status: ProjectStatus): Promise<void>;
  /** 最近会话（updatedAt 倒序），默认取 8 条 */
  getRecentSessions(sessionId: string, limit?: number): Promise<Project[]>;
}

/** 消息/干预队列仓库：干预队列 = role='intervention' AND delivered_at IS NULL（CLAUDE.md 规则 9） */
export interface MessagesRepo {
  addMessage(input: AddMessageInput): Promise<Message>;
  listMessages(projectId: number): Promise<Message[]>;
  takePendingInterventions(projectId: number): Promise<Message[]>;
  /** projectId 提供时强制项目级作用域（规则 9）；缺省则按裸 ids 生效（调用方须已自行校验归属） */
  markDelivered(messageIds: number[], projectId?: number): Promise<void>;
}

/** upsertFile 入参（统一写入口：agent/seed 生成、人工新建同走此 API） */
export interface UpsertFileInput { projectId:number; path:string; content:string; editor:FileEditor; }

/** saveHuman 入参：baseVersion 为编辑器打开时的版本号，不匹配即冲突（CAS，DESIGN §3.9） */
export interface SaveHumanInput { projectId:number; fileId:number; content:string; baseVersion:number; }

/** saveHuman 结果：失败时带回服务端当前内容，前端渲染冲突对话框（用我的版本/用 agent 版本/并排 diff） */
export type SaveHumanResult = { ok:true; version:number } | { ok:false; conflict:true; current:string };

/** file_tree 行（树形 UI 只需路径+版本+最后编辑者，不背内容） */
export interface FileListItem { path:string; version:number; lastEditor:AgentRole|'human'|'seed'; }

/**
 * 虚拟文件系统仓库（CLAUDE.md 规则 6/11、DESIGN §3.9/§3.10）：
 * - 所有方法强制 project_id 过滤；file_versions 表无 project_id，归属经 files 回查/联表保证
 * - 覆盖写（agent/人工/恢复）统一归档旧版本到 file_versions——diff、回滚、可再撤销都靠它
 * - 乐观锁：更新条件带 version，影响行数=0 即冲突；事务短小（事务内只有纯 DB 写）
 */
export interface FilesRepo {
  /** 新路径插入 v1（produced_by=editor）；已存在则旧版本入档并 version+1，返回 {fileId, version} */
  upsertFile(input: UpsertFileInput): Promise<{ fileId:number; version:number }>;
  getFile(projectId:number, path:string): Promise<FileRow|null>;
  getFileById(projectId:number, fileId:number): Promise<FileRow|null>;
  /** file_tree 用（路径升序稳定排序） */
  listFiles(projectId:number): Promise<FileListItem[]>;
  /** 人工保存（CAS）：版本不匹配 → {ok:false,conflict:true,current=服务端最新内容}；文件不存在亦按冲突返回（current 为空串） */
  saveHuman(input: SaveHumanInput): Promise<SaveHumanResult>;
  /** 版本历史（新→旧倒序，供查看器版本侧栏） */
  listFileVersions(projectId:number, fileId:number): Promise<FileVersion[]>;
  /** 恢复=以该历史版本内容写一个新版本（可再撤销），返回新版本号；历史版本不存在则抛错 */
  restoreFileVersion(projectId:number, fileId:number, version:number): Promise<number>;
  /** 声明式软锁：on=人开始编辑（TTL 10min），off=释放；软锁检查在编排器步骤边界做，仓库不拦截写入 */
  setSoftLock(projectId:number, fileId:number, on:boolean): Promise<void>;
  /** 当前仍持有软锁的文件（只含未过期） */
  getSoftLockedFiles(projectId:number): Promise<FileRow[]>;
  /** 全量文件行（快照/导出/预览装配用） */
  readAllFiles(projectId:number): Promise<FileRow[]>;
}

/**
 * agent_runs 仓库：summary 是子任务间唯一交接物（CLAUDE.md 规则 7），回滚时统一标 rolled_back（DESIGN §3.10）。
 */
export interface RunsRepo {
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRun>;
  /** 按 id 推进；projectId 提供时叠加项目级作用域（规则 9），缺省按裸 id 生效（调用方须已自行校验归属） */
  updateAgentRun(id: number, patch: UpdateAgentRunPatch, projectId?: number): Promise<void>;
  /** 任务时间线（created_at 正序，并列按 id 稳定排序） */
  listAgentRuns(projectId: number): Promise<AgentRun[]>;
  /** 检查点回滚配套：id ≤ uptoRunId 的本项目任务（含已 done/failed）全部改标 rolled_back */
  markRunsRolledBack(projectId: number, uptoRunId: number): Promise<void>;
}

/**
 * 杂项仓库：项目级检查点（DESIGN §3.10）+ llm_calls 计量（CLAUDE.md 规则 10）+ 个人偏好（DESIGN §3.9/§4.2）。
 * 检查点快照/恢复必须在一个短事务内完成（事务里只有纯 DB 读写，无 await/IO/LLM 调用）。
 */
export interface MiscRepo {
  /** 打点：当前全部 files 全量快照入 checkpoint_files（读快照与落库同事务），返回 checkpoint id */
  createCheckpoint(projectId: number, label: string, agentRunId: number|null): Promise<number>;
  /**
   * 恢复：当前内容先各入 file_versions（回滚可撤销），再按快照 upsert 回 files——
   * 快照内已有文件行覆盖内容并 version+1、已消失的行重建；快照外的文件（打点后新增）一律不动。
   * 返回受影响 fileId（按快照路径升序）。checkpointId 不存在或归属不符时抛错。
   */
  restoreCheckpoint(projectId: number, cpId: number): Promise<number[]>;
  /** 打点列表（新→旧，时间线「回到此任务前」用） */
  listCheckpoints(projectId: number): Promise<Checkpoint[]>;
  recordLlmCall(input: RecordLlmCallInput): Promise<void>;
  /** 按 agentRole+model 聚合 tokens/calls（单条 SQL groupBy，禁 N+1） */
  usageByProject(projectId: number): Promise<LlmUsageRow[]>;
  /** 未命中返回 null；data 已由 text({mode:'json'}) 反序列化 */
  getPreference(scope: PreferenceScope, targetId: string): Promise<unknown|null>;
  /** upsert on (scope,target_id)：同键二次写覆盖（编辑能力开关等只存最新值） */
  setPreference(scope: PreferenceScope, targetId: string, data: Record<string, unknown>): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 模型管理全局表（DESIGN §7/§5①）：provider → model → 角色绑定            */
/* ------------------------------------------------------------------ */

/** LLM 服务商行（全局表）；api_key 仅服务端使用，绝不进日志/前端/SSE（.claude/rules/07） */
export interface LlmProviderRow { id:number; name:string; baseUrl:string; apiKey:string; enabled:boolean; createdAt:number; }

/** 模型行（全局表）：price_input/output 用于 llm_calls 成本核算（DESIGN §5③），默认 0 */
export interface LlmModelRow { id:number; providerId:number; modelId:string; displayName:string;
  priceInput:number; priceOutput:number; enabled:boolean; createdAt:number; }

/** 角色绑定行（全局表，role 唯一）：一角色一绑定（DESIGN §5①） */
export interface AgentModelBindingRow { id:number; role:AgentRole; providerId:number; modelId:number; createdAt:number; }

/**
 * 模型管理只读仓库（DESIGN §5①）：T27 的 resolveRoleModel（三级路由）消费。
 * 刻意只读且最小——T24 的设置页 CRUD 在此之上扩展写方法（届时并入本接口或另立 LlmWriteRepo）。
 */
export interface LlmReadRepo {
  /** 角色绑定（role 唯一，无绑定返回 null） */
  getAgentModelBinding(role: AgentRole): Promise<AgentModelBindingRow|null>;
  getLlmProviderById(providerId: number): Promise<LlmProviderRow|null>;
  getLlmModelById(modelId: number): Promise<LlmModelRow|null>;
}

/**
 * 存储抽象（DESIGN §12）：按仓库分组继承（Task 5 已补齐全部仓库组）。
 * 实现侧约定：所有查询强制 project_id 过滤（CLAUDE.md 规则 9）、更新走乐观锁（规则 05）。
 */
export interface StorageProvider extends ProjectsRepo, MessagesRepo, FilesRepo, RunsRepo, MiscRepo, LlmReadRepo {
  /**
   * 关闭底层连接（幂等；关闭后本实例不可再用，需重新走工厂）。
   * 文件库实例按 dbFile 路径 memoize——业务侧在模块层调用一次 createStorage() 并持有即可，
   * 切勿每请求新建（否则句柄泄漏、WAL 写者叠加，SQLite 单写者模型会互相阻塞）。
   */
  close(): void;
}
