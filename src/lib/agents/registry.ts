/**
 * 角色注册表（Task 14，DESIGN §1 角色表 / §3.1「@ 成员浮层数据源=RoleRegistry」）。
 *
 * 职责：七个角色的用户可见元数据（中文名/emoji/主题色/一句话职责）单一事实来源——
 * 工作台 @ 浮层、头像角标、时间线节点与用量卡片都从这里取色取文案，不再各写一份。
 *
 * 注意：本模块必须保持客户端安全（会被前端组件直接 import）——
 * 只允许类型 import 与纯常量，禁止引入任何服务端模块（db/env/llm）。
 */
import type { AgentRole } from '@/lib/db/provider/types';

/** 单个角色的展示元数据 */
export interface RoleMeta {
  /** 用户可见中文名（与 mock provider 的角色标记契约一致：数据分析师 / SEO 专家 / 广告专家） */
  name: string;
  /** 头像/时间线图标 */
  emoji: string;
  /** 主题色（HEX；Tailwind 侧按需映射成 token，不走魔法色值硬编码） */
  color: string;
  /** 一句话职责（@ 浮层副标题） */
  blurb: string;
}

/**
 * 七角色注册表。颜色为 DESIGN 拍板值：
 * 蓝#3B82F6 领导 / 紫#8B5CF6 PM / 青#06B6D4 架构师 / 绿#10B981 工程师 /
 * 橙#F59E0B 分析师 / 粉#EC4899 SEO / 红#EF4444 广告
 */
export const roleRegistry: Record<AgentRole, RoleMeta> = {
  leader: {
    name: '团队领导',
    emoji: '🧭',
    color: '#3B82F6',
    blurb: '理解需求、拆解任务并分派给团队成员，收尾时汇总汇报',
  },
  pm: {
    name: '产品经理',
    emoji: '📋',
    color: '#8B5CF6',
    blurb: '需求分析与优先级取舍，产出 PRD（docs/prd.md）',
  },
  architect: {
    name: '架构师',
    emoji: '🏗️',
    color: '#06B6D4',
    blurb: '技术选型与系统设计，产出架构图与 file_tree',
  },
  engineer: {
    name: '工程师',
    emoji: '💻',
    color: '#10B981',
    blurb: '按 file_tree 逐文件实现全栈代码并自审修复',
  },
  analyst: {
    name: '数据分析师',
    emoji: '📊',
    color: '#F59E0B',
    blurb: '定义核心指标与埋点方案，产出数据分析报告',
  },
  seo: {
    name: 'SEO 专家',
    emoji: '🔍',
    color: '#EC4899',
    blurb: '关键词与站内优化建议，产出 SEO 优化报告',
  },
  ads: {
    name: '广告专家',
    emoji: '📣',
    color: '#EF4444',
    blurb: '投放策略与转化目标设计，产出广告投放报告',
  },
};

/** 注册表稳定顺序（@ 浮层按此排序展示：领导在前，其余按流水线顺序） */
export const roleOrder: readonly AgentRole[] = ['leader', 'pm', 'architect', 'engineer', 'analyst', 'seo', 'ads'];
