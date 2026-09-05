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
export interface FileRow { id:number; projectId:number; path:string; content:string;
  producedBy:AgentRole|'seed'; lastEditor:AgentRole|'human'|'seed'; editingBy:string|null; editingExpiresAt:number|null;
  version:number; createdAt:number; updatedAt:number; }
export interface FileVersion { id:number; fileId:number; version:number; content:string; editor:string; createdAt:number; }
export interface Checkpoint { id:number; projectId:number; label:string; agentRunId:number|null; createdAt:number; }
export interface CheckpointFile { checkpointId:number; path:string; content:string; }
export interface LlmCall { id:number; projectId:number; agentRole:AgentRole; model:string;
  promptTokens:number; completionTokens:number; estimated:number; cost:number; latencyMs:number; createdAt:number; }

/** createProject 入参（id/status/时间戳由存储层与库默认值生成） */
export interface CreateProjectInput { sessionId:string; title:string; requirement:string; mode:'fast'|'full'; }

/**
 * 存储抽象（DESIGN §12）：方法按仓库分组，随 Task 3-5 逐组补齐
 * （messages/agent_runs/files/file_versions/llm_calls/preferences/checkpoints…）。
 * 实现侧约定：所有查询强制 project_id 过滤（CLAUDE.md 规则 9）、更新走乐观锁（规则 05）。
 */
export interface StorageProvider {
  /** 项目仓库（Task 3 扩展：列表聚合、重命名、删除级联） */
  createProject(input: CreateProjectInput): Promise<Project>;
  listProjects(sessionId: string): Promise<Project[]>;
  /**
   * 关闭底层连接（幂等；关闭后本实例不可再用，需重新走工厂）。
   * 文件库实例按 dbFile 路径 memoize——业务侧在模块层调用一次 createStorage() 并持有即可，
   * 切勿每请求新建（否则句柄泄漏、WAL 写者叠加，SQLite 单写者模型会互相阻塞）。
   */
  close(): void;
}
