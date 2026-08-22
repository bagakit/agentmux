import { AlertCircle, CheckCircle2, CircleDot, Inbox, PlayCircle, RotateCcw, Users } from 'lucide-react'
import { useMemo } from 'react'
import { useAppStore } from '../store'
import { buildAgentRoster, type RosterRow } from '../lib/agent-roster'
import { isNeedsYouState } from '../lib/attention-vocabulary'
import { AgentProviderIcon, agentProviderLabel } from './AgentProviderIcon'

type AgentBucket = 'needs-you' | 'working' | 'done' | 'error'

const BUCKET_META: Record<AgentBucket, { label: string; description: string; icon: typeof Inbox }> = {
  'needs-you': { label: 'Needs you', description: 'Requests and blocked work waiting for a decision', icon: Inbox },
  working: { label: 'Working', description: 'Agents currently producing work', icon: PlayCircle },
  done: { label: 'Results', description: 'Completed work ready to inspect', icon: CheckCircle2 },
  error: { label: 'Error', description: 'Agents that stopped with an error', icon: AlertCircle }
}

function bucketFor(row: RosterRow): AgentBucket {
  if (isNeedsYouState(row.state)) return 'needs-you'
  if (row.state === 'error') return 'error'
  if (row.state === 'done') return 'done'
  return 'working'
}

function AgentInboxRow({ row, onSelect }: { row: RosterRow; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      className="global-agents-row"
      data-session-id={row.sessionId}
      data-attention={row.attention ?? undefined}
      onClick={() => onSelect(row.sessionId)}
      aria-label={`${row.label} · ${row.state}${row.awaitingReply ? ' · awaiting your reply' : ''}`}
    >
      <span className={`global-agents-row__status status status--${row.state}`} aria-hidden="true"><CircleDot size={12} /></span>
      <span className="global-agents-row__identity">
        <strong>{row.label}</strong>
        <small>{agentProviderLabel(row.providerId)} · {row.workspacePath.split('/').filter(Boolean).slice(-2).join('/') || 'workspace'}</small>
      </span>
      {row.awaitingReply ? <span className="global-agents-row__reply">Reply</span> : null}
      <AgentProviderIcon providerId={row.providerId} size={16} />
      <span className="global-agents-row__open" aria-hidden="true">Open <RotateCcw size={12} /></span>
    </button>
  )
}

export function GlobalAgentsSurface() {
  const sessions = useAppStore((state) => state.sessions)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const selectSession = useAppStore((state) => state.selectSession)
  const rows = useMemo(() => buildAgentRoster({ sessions, providerCatalog }), [sessions, providerCatalog])
  const groups = useMemo(() => {
    const grouped: Record<AgentBucket, RosterRow[]> = { 'needs-you': [], working: [], done: [], error: [] }
    for (const row of rows) grouped[bucketFor(row)].push(row)
    return grouped
  }, [rows])

  return (
    <section className="global-agents-surface" aria-label="Agents">
      <header className="global-agents-header">
        <div>
          <span className="global-agents-eyebrow"><Users size={14} /> Global attention inbox</span>
          <h1>Agents</h1>
          <p>See who is working, who needs you, and which results are ready to review.</p>
        </div>
        <span className="global-agents-count">{rows.length} {rows.length === 1 ? 'Agent' : 'Agents'}</span>
      </header>
      {rows.length === 0 ? (
        <div className="global-agents-empty" role="status"><Users size={20} /><strong>No Agent Sessions yet</strong><span>Start a Session from a Project to make it appear here.</span></div>
      ) : (
        <div className="global-agents-groups">
          {(Object.keys(BUCKET_META) as AgentBucket[]).map((bucket) => {
            const meta = BUCKET_META[bucket]
            const Icon = meta.icon
            const bucketRows = groups[bucket]
            if (bucketRows.length === 0) return null
            return (
              <section key={bucket} className="global-agents-group" data-bucket={bucket}>
                <header className="global-agents-group__header"><span><Icon size={14} /><strong>{meta.label}</strong><small>{meta.description}</small></span><em>{bucketRows.length}</em></header>
                <div className="global-agents-group__rows">
                  {bucketRows.map((row) => <AgentInboxRow key={row.sessionId} row={row} onSelect={selectSession} />)}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}
