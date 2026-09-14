import { History, Play } from 'lucide-react'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { AgentFocusHistoryEntry } from '../lib/agent-focus'
import { workspaceForSession } from '../lib/workbench-tabs'
import { AgentAvatar } from './AgentAvatar'

type TimelineEntry = AgentFocusHistoryEntry & { session: SessionSnapshot; label: string }

function clock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function timelineEntries(
  entries: readonly AgentFocusHistoryEntry[],
  sessions: readonly SessionSnapshot[],
  names: Readonly<Record<string, string>>
): TimelineEntry[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  return entries.flatMap((entry) => {
    const session = byId.get(entry.sessionId)
    return session ? [{ ...entry, session, label: names[session.id] ?? (session.kind === 'terminal' ? 'Terminal' : session.label) }] : []
  })
}

export function RecentFocusTimeline({
  entries,
  currentSessionId,
  sessions,
  config,
  names,
  onSelect
}: {
  entries: readonly AgentFocusHistoryEntry[]
  currentSessionId: string | null
  sessions: readonly SessionSnapshot[]
  config: Parameters<typeof workspaceForSession>[0]
  names: Readonly<Record<string, string>>
  onSelect(sessionId: string): void
}) {
  const items = timelineEntries(entries, sessions, names)
  const ordered = [...items].sort((a, b) => a.focusedAt - b.focusedAt)
  const start = ordered[0]?.focusedAt ?? 0
  const end = Math.max(
    ordered.at(-1)?.focusedAt ?? 0,
    (ordered.at(-1)?.focusedAt ?? 0) + 15 * 60 * 1000
  )
  const span = Math.max(1, end - start)
  return <section className="recent-focus" aria-label="Recent Focus">
    <header className="recent-focus__header">
      <span className="recent-focus__title"><History size={13} /><strong>Recent Focus</strong><small>Focus timeline</small></span>
      <span className="recent-focus__range">{items.length > 0 ? `${clock(start)} — ${clock(end)}` : 'No focus history'}</span>
    </header>
    {items.length === 0 ? <p className="recent-focus__empty">Focus an Agent or Terminal to build your timeline.</p> : <div className="recent-focus__body">
      <div className="recent-focus__ruler" aria-hidden="true"><span>{clock(start)}</span><span>{clock(start + span / 2)}</span><span>{clock(end)}</span></div>
      <div className="recent-focus__tracks">
        {ordered.map((item, index) => {
          const next = ordered[index + 1]?.focusedAt ?? Math.min(end, item.focusedAt + 15 * 60 * 1000)
          const left = ((item.focusedAt - start) / span) * 100
          const width = Math.max(3.5, ((Math.max(item.focusedAt + 30 * 1000, next) - item.focusedAt) / span) * 100)
          const workspace = workspaceForSession(config, item.session)
          const current = item.session.id === currentSessionId
          return <div className="recent-focus__track" data-focus-timeline-id={item.session.id} key={`${item.session.id}-${item.focusedAt}`}>
            <button
              type="button"
              className={`recent-focus__segment${current ? ' is-current' : ''}`}
              style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
              aria-current={current ? 'true' : undefined}
              title={`${item.label} · ${workspace?.name ?? item.session.workspacePath} · ${clock(item.focusedAt)}`}
              onClick={() => onSelect(item.session.id)}
            >
              {item.session.kind === 'agent' ? <AgentAvatar sessionId={item.session.id} label={item.label} state={item.session.status.state} providerId={item.session.providerId ?? undefined} size={16} /> : <Play size={12} />}
              <span>{item.label}</span><time>{clock(item.focusedAt)}</time>
            </button>
          </div>
        })}
      </div>
    </div>}
  </section>
}
