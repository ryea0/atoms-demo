/**
 * SQLite 消息/干预队列仓库（DESIGN §12 按仓库分组实现之一）。
 * 干预队列即 messages 表的子集：role='intervention' AND delivered_at IS NULL（CLAUDE.md 规则 9）。
 * meta 为 SQLite text({mode:'json'})，drizzle 在此处完成 JSON 反序列化，业务侧拿到的已是对象。
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { messages } from './schema';
import type { SqliteDb } from './storage';
import type { AddMessageInput, Message, MessageMeta, MessagesRepo } from '../types';

/** 行 → 领域类型映射：json 列在 drizzle 的 $type 下可能返回 null，统一收敛为 Message.meta 的可空形状 */
function toMessage(row: typeof messages.$inferSelect): Message {
  return {
    id: row.id,
    projectId: row.projectId,
    role: row.role,
    content: row.content,
    meta: row.meta ?? null,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
  };
}

export function createMessagesRepo(db: SqliteDb): MessagesRepo {
  return {
    /** 写消息：干预消息 delivered_at 留空等待注入；其余角色落库即视为已送达 */
    async addMessage(input: AddMessageInput): Promise<Message> {
      const rows = await db
        .insert(messages)
        .values({
          projectId: input.projectId,
          role: input.role,
          content: input.content,
          meta: input.meta ?? null,
          deliveredAt: input.role === 'intervention' ? null : Date.now(),
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('消息写入失败：insert 未返回行');
      return toMessage(row);
    },

    /** 项目内全部消息（时间正序，created_at 并列按 id 稳定排序） */
    async listMessages(projectId: number): Promise<Message[]> {
      const rows = await db
        .select()
        .from(messages)
        .where(eq(messages.projectId, projectId))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      return rows.map(toMessage);
    },

    /** 取走待注入干预（FIFO）：只读快照，注入成功后由调用方 markDelivered 确认，避免注入失败丢消息 */
    async takePendingInterventions(projectId: number): Promise<Message[]> {
      const rows = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.projectId, projectId),
            eq(messages.role, 'intervention'),
            isNull(messages.deliveredAt),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.id));
      return rows.map(toMessage);
    },

    /**
     * 批量标记已送达（空列表直接返回：inArray 空数组会生成非法 SQL）。
     * projectId 可选作用域（规则 9：写入强制 project_id 过滤）——编排器/路由应始终传入，
     * 即使批量里混入了他项目 id 也只会动本项目；缺省时按裸 ids 生效，仅限已先行校验归属的调用方
     * （保留以兼容 brief 原签名）。
     * meta 可选：注入打戳时写回 targetTask（T25——刷新后从快照也能还原「已注入 {文件}」），
     * 由调用方传入合并后的完整 meta（仓库层不做合并）；不传则保持原值。
     */
    async markDelivered(messageIds: number[], projectId?: number, meta?: MessageMeta): Promise<void> {
      if (messageIds.length === 0) return;
      const scope = inArray(messages.id, messageIds);
      await db
        .update(messages)
        .set(meta === undefined ? { deliveredAt: Date.now() } : { deliveredAt: Date.now(), meta: meta ?? null })
        .where(projectId === undefined ? scope : and(scope, eq(messages.projectId, projectId)));
    },
  };
}
