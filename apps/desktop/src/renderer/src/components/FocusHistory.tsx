import { GitBranch, History, SquareTerminal } from 'lucide-react'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import { workspaceForSession } from '../lib/workbench-tabs'
import { AgentAvatar } from './AgentAvatar'

export type FocusHistoryProps = {
  entries: readonly AgentFocusHistoryEntry[]
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
  return <aside className="focus-history" aria-label="Recent execution contexts">
    <header className="focus-history__header">
      <span className="focus-history__title"><GitBranch size={13} /><strong>Recent contexts</strong></span>
      <span className="focus-history__hint">execution</span>
    </header>
    {entries.length === 0 ? <p className="focus-history__empty"><History size={13} /> Open an Agent or Terminal to start a thread.</p> : <ol className="focus-history__list">
      {entries.map((entry, index) => {
        const session = sessionById.get(entry.sessionId)
        if (!session) return null
        const workspace = workspaceForSession(config, session)
        const label = names[session.id] ?? (session.kind === 'terminal' ? 'Terminal' : session.label)
        const current = currentSessionId === session.id
        return <li className={`focus-history__item${current ? ' is-current' : ''}`} key={entry.sessionId}>
          <span className="focus-history__lane" aria-hidden="true"><span className="focus-history__dot" /></span>
          <button
            type="button"
            className="focus-history__entry"
            data-focus-history-id={session.id}
            aria-current={current ? 'true' : undefined}
            title={`Return to ${label}`}
            onClick={() => onSelect(session.id)}
          >
            {session.kind === 'agent'
              ? <AgentAvatar sessionId={session.id} label={label} state={session.status.state} providerId={session.providerId ?? undefined} size={18} />
              : <span className="focus-history__terminal-icon" aria-label="Terminal"><SquareTerminal size={15} /></span>}
            <span className="focus-history__identity"><strong>{label}</strong><small>{workspace?.name ?? session.workspacePath} · {session.kind === 'agent' ? 'Agent' : 'Terminal'}</small></span>
            <span className="focus-history__meta"><b>{index === 0 && current ? 'HEAD' : `HEAD~${index + 1}`}</b><time dateTime={new Date(entry.focusedAt).toISOString()}>{focusTime(entry.focusedAt)}</time></span>
          </button>
        </li>
      })}
    </ol>}
  </aside>
}
