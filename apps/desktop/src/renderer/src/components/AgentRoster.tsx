import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronUp, ShieldAlert } from 'lucide-react'
import { useAppStore } from '../store'
import { buildAgentRoster, rowRiskTier, type RosterRow } from '../lib/agent-roster'
import { agentRosterMenuActions } from '../lib/agent-roster-menu'
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

function stateFor(row: RosterRow): 'working' | 'waiting' | 'error' | null {
  if (row.attention === 'needs-you') return 'waiting'
  if (row.attention === 'error') return 'error'
  return row.state === 'working' ? 'working' : null
}

function RosterRowView({
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
          {...(row.attention ? { 'data-attention': row.attention } : {})}
          // The scope goes into the accessible name, not just a muted line: what an Agent is allowed to do
          // is the point of showing it, and a reader that only hears the name would otherwise miss it.
          aria-label={[
            row.label,
            row.awaitingReply ? 'awaiting your reply' : row.state,
            ...(row.unacknowledgedThreads > 0 ? [`${row.unacknowledgedThreads} unacknowledged messages`] : []),
            scopeText || 'no launch scope declared',
            // 用量作为可访问名的一部分：屏幕阅读器听到的是"最近一 turn 多少 token"或"此 Provider 不报用量"，
            // 而不是把这行事实漏掉。三态各自读得出，绝不读成 0。
            row.usage.title
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
          {/* 未确认的 Thread 是这一行的另一件待办；与 reply 同一枚样式，因为它们是同一类事。 */}
          {row.unacknowledgedThreads > 0 ? (
            <span className="agent-roster__pending" title={`${row.unacknowledgedThreads} unacknowledged`}>
              {row.unacknowledgedThreads} msg
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
