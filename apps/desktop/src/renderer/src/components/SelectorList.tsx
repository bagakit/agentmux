import type { ReactNode } from 'react'
import { AgentAvatar } from './AgentAvatar'
import type { AgentDisplayState, AgentProviderId } from '@agentmux/core'
import type { AttentionCategory } from '../lib/attention-event'

/**
 * 同一族列表行的共享表现层。
 *
 * Branch/Worktree 条与 Topic 条回答的是同一种形状的问题——"这一组条目里挑一个，进去是一组
 * Tab、每个 Tab 是一套 Region 分屏"。此前它们各自长出了一套写法：两个 header、两个计数徽章、
 * 两簇 Agent 头像，看起来一样却是两段代码。于是它们各自漂移——Branch 侧的头像截断到 4 并给
 * `+N`，Topic 侧无上限直接铺完；Branch 侧 header 的计数是 `small`，Topic 侧是 `em`，圆角和
 * 内距也不同。这里只有一套。
 *
 * **它不感知选中真相。** 两个条的选中模型确实不同——Branch 换的是 `activeWorkspaceId`
 * （一个 worktree 本身就是一个 Workspace，天然拥有自己那份 layout），Topic 是对同一份 Scratch
 * layout 做投影。那条差异归交互合同，表现层只收一个 `selected` 布尔值，不得为了"统一"把其中
 * 一侧改成另一侧。数据源、选中判定、右键菜单、创建/改名流程与拖拽排序全部由调用方注入。
 */

export type SelectorPresenceAgent = {
  /** 用于 React key 与点击定位；Branch 侧按 provider 归并，Topic 侧是 sessionId。 */
  key: string
  providerId: AgentProviderId
  /** tooltip 与可访问名里的人话。 */
  label: string
  state: AgentDisplayState
  attention: AttentionCategory | null
  /** 同一个 provider 归并了几个 Session；1 时不显示角标。 */
  count?: number
  onOpen?: () => void
}

/**
 * 一摞头像能读作"一摞"而不是"一片"，靠的是枚数有限。叠压省的是宽度不是无限的，超出这个数
 * 就折成 `+N`——Topic 侧此前无上限，一个 8 人的 Topic 会把标题挤没。
 */
export const SELECTOR_PRESENCE_MAX = 4

export function SelectorPresence({
  agents,
  max = SELECTOR_PRESENCE_MAX
}: {
  agents: readonly SelectorPresenceAgent[]
  max?: number
}) {
  if (agents.length === 0) return null
  const visible = agents.slice(0, max)
  const hidden = agents.length - visible.length
  // 折起来的那些不能就此消失——全名进 tooltip，簇本身仍然自称完整的一份名单。
  const roster = agents
    .map((agent) => (agent.count && agent.count > 1 ? `${agent.label} ×${agent.count}` : agent.label))
    .join(', ')
  return (
    <span className="selector-presence" aria-label={`Agents: ${roster}`} title={`Agents: ${roster}`}>
      {visible.map((agent, index) => (
        // 最靠右的一枚要压在上面，否则右边的被左边盖住，读作"倒着叠"。DOM 顺序是从左到右，
        // 所以 z-index 随索引递增；hover 那枚由 CSS 再抬一层盖过所有邻座。
        <span className="selector-presence__slot" key={agent.key} style={{ zIndex: index + 1 }}>
          <AgentAvatar
            attention={agent.attention}
            label={agent.label}
            onOpen={agent.onOpen ?? (() => {})}
            providerId={agent.providerId}
            state={agent.state}
          />
          {agent.count && agent.count > 1 ? <small>{agent.count}</small> : null}
        </span>
      ))}
      {hidden > 0 ? <em>+{hidden}</em> : null}
    </span>
  )
}

/**
 * 容器 header：标题 + 计数 + 动作位。计数为空时不占位——一个恒为空的徽章是宽度开销。
 */
export function SelectorListHeader({
  title,
  count,
  actions,
  className
}: {
  title: string
  count?: number | null
  actions?: ReactNode
  /** 面板自己的定位/背景仍归它自己；共享的是里面的排版。 */
  className?: string
}) {
  return (
    <header className={className ? `selector-list__header ${className}` : 'selector-list__header'}>
      <span>
        <strong>{title}</strong>
        {typeof count === 'number' ? <em>{count}</em> : null}
      </span>
      {actions ? <span className="selector-list__actions">{actions}</span> : null}
    </header>
  )
}

/**
 * 一行：状态槽（可空）+ identity + 尾部 Agent 簇 + 尾部附注。
 *
 * 三段包在**自己的** `.selector-row` 里，行的排布因此只有一处定义（selector.css）。
 * 早先这里返回的是裸 fragment，由每个容器各写一份三列网格接住——而 `leading` 可空，
 * 只来两段时头像簇被摆进 identity 那一列，直接压在摘要文字上。容器只该管自己的
 * 内外边距与背景，不该重新推导行的内部结构。
 */
export function SelectorRow({
  leading,
  title,
  subtitle,
  titleTooltip,
  subtitleTooltip,
  presence,
  trailing
}: {
  leading?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  titleTooltip?: string | undefined
  subtitleTooltip?: string | undefined
  presence?: ReactNode
  trailing?: ReactNode
}) {
  return (
    <span className="selector-row">
      {leading ? <span className="selector-row__leading">{leading}</span> : null}
      <span className="selector-row__identity">
        <strong title={titleTooltip}>{title}</strong>
        {subtitle ? <small title={subtitleTooltip}>{subtitle}</small> : null}
      </span>
      <span className="selector-row__meta">
        {presence}
        {trailing}
      </span>
    </span>
  )
}
