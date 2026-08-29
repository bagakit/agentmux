import { GitBranch, History } from 'lucide-react'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { FocusHistoryEntry } from '../lib/agent-focus'
import { workspaceForSession } from '../lib/workbench-tabs'
import { AgentAvatar } from './AgentAvatar'

export type FocusHistoryProps = {
  entries: readonly FocusHistoryEntry[]
  currentSessionId: string | null
  sessions: readonly SessionSnapshot[]
  config: Parameters<typeof workspaceForSession>[0]
  names: Readonly<Record<string, string>>
  onSelect(sessionId: string): void
}

function focusTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function FocusHistory({ entries, currentSessionId, sessions, config, names, onSelect }: FocusHistoryProps) {
  const sessionById = new Map(sessions.map((session) => [session.id, session]))
  return <section className="agent-focus-history" aria-label="Recent execution Agent focus">
    <header className="agent-focus-history__header">
      <span className="agent-focus-history__title"><GitBranch size={13} /><strong>Focus history</strong></span>
      <span className="agent-focus-history__hint">execution context</span>
    </header>
    {entries.length === 0 ? <p className="agent-focus-history__empty"><History size={13} /> Select an execution Agent to start a thread.</p> : <ol className="agent-focus-history__list">
      {entries.map((entry, index) => {
        const session = sessionById.get(entry.sessionId)
        if (!session) return null
        const workspace = workspaceForSession(config, session)
        const label = names[session.id] ?? session.label
        const current = currentSessionId === session.id
        return <li className={`agent-focus-history__item${current ? ' is-current' : ''}`} key={entry.sessionId}>
          <span className="agent-focus-history__lane" aria-hidden="true"><span className="agent-focus-history__dot" /></span>
          <button
            type="button"
            className="agent-focus-history__entry"
            data-focus-history-id={session.id}
            aria-current={current ? 'true' : undefined}
            title={`Return to ${label}`}
            onClick={() => onSelect(session.id)}
          >
            <AgentAvatar sessionId={session.id} label={label} state={session.status.state} providerId={session.providerId ?? undefined} size={18} />
            <span className="agent-focus-history__identity"><strong>{label}</strong><small>{workspace?.name ?? session.workspacePath}</small></span>
            <span className="agent-focus-history__meta"><b>{index === 0 && current ? 'HEAD' : `HEAD~${index + 1}`}</b><time dateTime={new Date(entry.focusedAt).toISOString()}>{focusTime(entry.focusedAt)}</time></span>
          </button>
        </li>
      })}
    </ol>}
  </section>
}
