/**
 * SQLite 消息/干预队列仓库（DESIGN §12 按仓库分组实现之一）。
 * 干预队列即 messages 表的子集：role='intervention' AND delivered_at IS NULL（CLAUDE.md 规则 9）。
 * meta 为 SQLite text({mode:'json'})，drizzle 在此处完成 JSON 反序列化，业务侧拿到的已是对象。
 */
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { messages } from './schema';
import type { SqliteDb } from './storage';
import type { AddMessageInput, Message, MessagesRepo } from '../types';

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

    /** 批量标记已送达；入参来自同一项目的 takePendingInterventions（归属已在上游校验），空列表直接返回 */
    async markDelivered(messageIds: number[]): Promise<void> {
      if (messageIds.length === 0) return; // inArray 空数组会生成非法 SQL
      await db.update(messages).set({ deliveredAt: Date.now() }).where(inArray(messages.id, messageIds));
    },
  };
}
