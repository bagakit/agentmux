import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from './HoverDropdownMenu'
import { ChevronUp, ShieldAlert } from 'lucide-react'
import { useAppStore } from '../store'
import { buildAgentRoster, rowRiskTier, type RosterRow } from '../lib/agent-roster'
import { buildAgentTree, type AgentTreeFilter } from '../lib/agent-tree'
import { agentRosterMenuActions } from '../lib/agent-roster-menu'
import { statusDotTier } from '../lib/attention-event'
import { copyTextToClipboard } from '../lib/clipboard-copy'

// The roster behind the attention bar's total.
//
// The bar states HOW MANY Agents the window holds and routes to the single one that has waited
// longest. This is the other half: the enumerable list, so several Agents in flight can be scanned and
// reached without walking panes. It hangs off the total segment because that segment already owns
// "how many Agents exist" — one identity, one place.
//
// Collapsed it costs nothing but the count that was already there. Everything below appears only once
// the user asks for it.

// The row's attention, in the shared status vocabulary so its dot carries it.
//
// One mark per row, and this is it. The row also used to emit `data-attention`, which no stylesheet
// read — so it painted nothing while looking handled. Deleted rather than given a rule: `waiting` and
// `error` already resolve `--status-ink` to amber and red, and amber's dot carries a `?` pip, so the
// signal is on screen and colour-blind-safe without a second competing mark.
//
// The tier itself is decided in `attention-event.ts` — the same call the fan-out lane makes. It used to
// be four lines here and four more there, and both ended in `state === 'working' ? 'working' : null`,
// which painted a live `running` Agent with the resting grey dot while this very panel's heading
// counted it as working.
function stateFor(row: RosterRow): ReturnType<typeof statusDotTier> {
  return statusDotTier(row.state)
}

/**
 * 每档上下文压力对应的**下一步**，给悬停提示和屏幕阅读器用。
 *
 * 写的是用户能做的事，不是形容词。"high" 只是把百分比换了个说法，用户读完仍不知道该干什么；
 * "wrap up or start a fresh session" 说的是在压缩发生之前还来得及做的那件事。
 *
 * 刻意不写「即将压缩」或任何时间预测：各家 Provider 在什么阈值压缩我们不知道，也不猜
 * （`AgentContextUsage` 的正文已明说这条）。这里说的是**我们的提醒时机**，不是对 Provider 行为的预报。
 */
// 导出而不是各写一份：Agents dock 的行也要念同一句「下一步该做什么」。两处若各抄一份，
// 哪天改了措辞就有一处漏改，用户在两个面上读到两种建议。见 SurfaceToolDock 的 WorkspaceAgentsTool。
export const CONTEXT_PRESSURE_HINT = {
  caution: 'plan to wrap up or start a fresh session',
  danger: 'wrap up now or start a fresh session'
} as const

export function RosterRowView({
  row,
  onSelect,
  reportError
}: {
  row: RosterRow
  onSelect: (sessionId: string) => void
  reportError: (error: unknown) => void
}) {
  const state = stateFor(row)
  const tier = rowRiskTier(row)
  // 复用 agent-address 的 formatter，不在 Roster 里重写寻址。写剪贴板走共用出口，失败必报。
  const menuActions = agentRosterMenuActions({
    sessionId: row.sessionId,
    writeClipboardText: async (text) => {
      await copyTextToClipboard(text, reportError)
    }
  })
  // The scope reads as one line so a row stays scannable: "Sandbox: Danger full access · Approvals: Never ask".
  const scopeText = row.scopes.map((scope) => `${scope.label}: ${scope.value}`).join(' · ')
  return (
    // 右键点这一行就寻址这一个 Agent——Roster 恰恰最该有寻址/交接入口，不必先切到分屏格。
    // 左键仍走 DropdownMenu.Item 的 onSelect（导航到该 Session）；右键交给 ContextMenu。
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <DropdownMenu.Item
          className="agent-roster__row"
          // The scope goes into the accessible name, not just a muted line: what an Agent is allowed to do
          // is the point of showing it, and a reader that only hears the name would otherwise miss it.
          aria-label={[
            row.label,
            row.awaitingReply ? 'awaiting your reply' : row.state,
            scopeText || 'no launch scope declared',
            // 用量作为可访问名的一部分：屏幕阅读器听到的是"最近一 turn 多少 token"或"此 Provider 不报用量"，
            // 而不是把这行事实漏掉。三态各自读得出，绝不读成 0。
            row.usage.title,
            // 上下文压力只在够得上门槛时读出来，且读的是**为什么该看它**而不是颜色名——"amber" 对
            // 听的人毫无信息。够不上门槛（或压根不知道）时整段缺席：给每一行都念一句"上下文正常"，
            // 会把真正需要听见的那两行埋掉。
            ...(row.contextPressure
              ? [`context ${row.contextPercent}% full, ${CONTEXT_PRESSURE_HINT[row.contextPressure]}`]
              : [])
          ].join(' · ')}
          onSelect={() => onSelect(row.sessionId)}
        >
          <span className={state ? `status status--${state}` : 'status'} aria-hidden="true">
            <span className="status__dot" />
          </span>
          <span className="agent-roster__identity">
            <strong>{row.label}</strong>
            {/* Absence hides: an Agent on Provider defaults shows nothing here rather than a guess. */}
            {scopeText ? (
              <small className="agent-roster__scope" {...(tier ? { 'data-tier': tier } : {})}>
                {tier === 'danger' ? <ShieldAlert size={9} aria-hidden="true" /> : null}
                {scopeText}
              </small>
            ) : null}
          </span>
          {row.awaitingReply ? <span className="agent-roster__pending">reply</span> : null}
          {/* 上下文压力：只有够得上门槛才出现。一个用了 12% 的 Agent 不需要标记——给每行都发一枚
              徽章，等于把真正快满的那两行埋进噪音里。严重度用 data-pressure 交给 CSS 上色，
              逻辑层不出现颜色名（见 agent-usage.ts 的 contextPressure）。
              aria-hidden：这句话已经在整行的 aria-label 里念过了，再让它单独可读会重复一遍。 */}
          {row.contextPressure ? (
            <span
              className="agent-roster__pressure"
              data-pressure={row.contextPressure}
              title={`Context window ${row.contextPercent}% full — ${CONTEXT_PRESSURE_HINT[row.contextPressure]}`}
              aria-hidden="true"
            >
              {row.contextPercent}%
            </span>
          ) : null}
          {/* token 用量：真实数用常规色，"不报"/"还没有"压低成静默灰——它们是缺席，不该抢注意力，
              更不能被读成一个跑出来的 0。 */}
          <span
            className="agent-roster__usage"
            data-usage={row.usage.kind}
            title={row.usage.title}
          >
            {row.usage.text}
          </span>
        </DropdownMenu.Item>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="tab-context-menu" collisionPadding={8}>
          {menuActions.map((action) => (
            <ContextMenu.Item
              key={action.key}
              className="tab-context-menu__item"
              onSelect={action.onSelect}
            >
              <action.icon size={14} />
              <span>{action.label}</span>
            </ContextMenu.Item>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}

export function AgentRoster({ total }: { total: number }) {
  const sessions = useAppStore((state) => state.sessions)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const selectSession = useAppStore((state) => state.selectSession)
  const reportError = useAppStore((state) => state.reportError)
  const rows = buildAgentRoster({ sessions, providerCatalog })
  if (rows.length === 0) return null

  return (
    // DropdownMenu rather than Popover: it is already a dependency and its semantics are exactly this
    // — one trigger disclosing a list of navigable items, with roving focus and Escape for free.
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="agent-status-bar__segment agent-status-bar__segment--action agent-roster__trigger"
          type="button"
          data-attention="total"
          aria-label={`${total} ${total === 1 ? 'agent' : 'agents'} in this window. Open the roster.`}
          title="List every agent in this window"
        >
          <span className="status" aria-hidden="true"><span className="status__dot" /></span>
          <span className="agent-status-bar__count">{total}</span>
          <span className="agent-status-bar__label">{total === 1 ? 'agent' : 'agents'}</span>
          <ChevronUp size={10} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Presence-managed: any keyframe animation here must be scoped to [data-state='open'], or the
            node waits for an animationend a close never fires. See presence-exit-animation.test.ts. */}
        <DropdownMenu.Content className="agent-roster" side="top" align="start" sideOffset={6} collisionPadding={8}>
          <div className="agent-roster__heading">
            <span>Agents in this window</span>
            <span className="agent-roster__heading-count">{rows.length}</span>
          </div>
          <div className="agent-roster__list">
            {rows.map((row) => (
              <RosterRowView key={row.sessionId} row={row} onSelect={selectSession} reportError={reportError} />
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}

// The project→Agent tree behind ONE status-bar count. Each count segment (working / needs-you / error)
// renders one of these beside its number: a chevron that hover-, click- or keyboard-discloses the
// Agents in that class, bucketed by the Project that owns each one. It reuses `RosterRowView` — the same
// row the window roster ships, with its state dot, scope mark, usage and right-click addressing — so
// there is one row definition, not a second one that could drift.
//
// It is a SEPARATE control from the count button on purpose. needs-you/error already jump on click to
// the Agent that has waited longest; that one-click jump is a capability the user has today and
// principle 11 forbids removing it silently. So disclosure is added alongside the jump, never in place
// of it — a distinct focusable chevron, which also keeps the tree keyboard-reachable (Radix gives Enter/
// Space/Arrow for free on its trigger).
//
// A class with no Agents renders NOTHING here — no chevron, no dead click into an empty popover. That is
// the single decision for the zero case, so working/needs-you/error behave identically when empty.
export function AgentTreePanel({
  filter,
  heading,
  label
}: {
  filter: AgentTreeFilter
  heading: string
  // The chevron's accessible name: it carries the fact ("Show the 3 working agents by project"), not
  // just "expand", so a screen-reader user hears what opens.
  label: string
}) {
  const sessions = useAppStore((state) => state.sessions)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const workspaces = useAppStore((state) => state.config?.workspaces)
  const selectSession = useAppStore((state) => state.selectSession)
  const reportError = useAppStore((state) => state.reportError)
  const projects = buildAgentTree({ sessions, providerCatalog, workspaces: workspaces ?? [], filter })
  if (projects.length === 0) return null

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          className="agent-status-bar__segment agent-status-bar__segment--action agent-tree__disclose"
          type="button"
          aria-label={label}
          title={label}
        >
          <ChevronUp size={10} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        {/* Presence-managed: keyframe animation scoped to [data-state='open'] — see the roster above. */}
        <DropdownMenu.Content className="agent-roster agent-tree" side="top" align="start" sideOffset={6} collisionPadding={8}>
          <div className="agent-roster__heading">
            <span>{heading}</span>
            <span className="agent-roster__heading-count">
              {projects.reduce((sum, project) => sum + project.rows.length, 0)}
            </span>
          </div>
          {projects.map((project) => (
            <div className="agent-tree__project" key={project.key}>
              <div className="agent-tree__project-name">
                {project.name}
                {project.hostId !== 'local' ? <small>{project.hostId}</small> : null}
              </div>
              <div className="agent-roster__list">
                {project.rows.map((row) => (
                  <RosterRowView key={row.sessionId} row={row} onSelect={selectSession} reportError={reportError} />
                ))}
              </div>
            </div>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
