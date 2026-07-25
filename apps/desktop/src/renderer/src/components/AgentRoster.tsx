import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronUp, ShieldAlert } from 'lucide-react'
import { useAppStore } from '../store'
import { buildAgentRoster, rowRiskTier, type RosterRow } from '../lib/agent-roster'

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
  onSelect
}: {
  row: RosterRow
  onSelect: (sessionId: string) => void
}) {
  const state = stateFor(row)
  const tier = rowRiskTier(row)
  // The scope reads as one line so a row stays scannable: "Sandbox: Danger full access · Approvals: Never ask".
  const scopeText = row.scopes.map((scope) => `${scope.label}: ${scope.value}`).join(' · ')
  return (
    // A DropdownMenu.Item, not a bare button: the roster is a navigable list, and Radix owns the arrow
    // keys, typeahead and roving focus. A plain button inside the content would be unreachable by keyboard.
    <DropdownMenu.Item
      className="agent-roster__row"
      {...(row.attention ? { 'data-attention': row.attention } : {})}
      // The scope goes into the accessible name, not just a muted line: what an Agent is allowed to do
      // is the point of showing it, and a reader that only hears the name would otherwise miss it.
      aria-label={[
        row.label,
        row.awaitingReply ? 'awaiting your reply' : row.state,
        scopeText || 'no launch scope declared'
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
    </DropdownMenu.Item>
  )
}

export function AgentRoster({ total }: { total: number }) {
  const sessions = useAppStore((state) => state.sessions)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const selectSession = useAppStore((state) => state.selectSession)
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
              <RosterRowView key={row.sessionId} row={row} onSelect={selectSession} />
            ))}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
