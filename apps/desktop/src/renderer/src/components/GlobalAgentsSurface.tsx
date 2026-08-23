import { AgentAvatar } from './AgentAvatar'
import { AlertCircle, CheckCircle2, Inbox, PanelRightClose, PlayCircle, Search, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { buildAgentRoster, type RosterRow } from '../lib/agent-roster'
import { isNeedsYouState } from '../lib/attention-vocabulary'
import { workspaceForSession } from '../lib/workbench-tabs'
import { agentProviderLabel } from './AgentProviderIcon'
import { AttentionRequestPanel } from './AttentionRequestPanel'
import { SessionObservationRegions } from './SessionObservationRegions'
import { AgentTopologySummary } from './AgentTopologySummary'

type AgentBucket = 'needs-you' | 'working' | 'done' | 'error'
const BUCKET_META = {
  'needs-you': { label: 'Needs you', icon: Inbox },
  working: { label: 'Working', icon: PlayCircle },
  done: { label: 'Results', icon: CheckCircle2 },
  error: { label: 'Error', icon: AlertCircle }
}
function bucketFor(row: RosterRow): AgentBucket {
  if (isNeedsYouState(row.state)) return 'needs-you'
  if (row.state === 'error') return 'error'
  if (row.state === 'done') return 'done'
  return 'working'
}

export function GlobalAgentsSurface() {
  const sessions = useAppStore((state) => state.sessions)
  const config = useAppStore((state) => state.config)
  const tabs = useAppStore((state) => state.tabs)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const names = useAppStore((state) => state.agentNames)
  const selectedId = useAppStore((state) => state.selectedAgentSessionId)
  const setSelected = useAppStore((state) => state.setSelectedAgentSession)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [requestId, setRequestId] = useState<string | null>(null)
  const rows = useMemo(() => buildAgentRoster({ sessions, providerCatalog }), [sessions, providerCatalog])
  const filtered = rows.filter((row) => {
    const session = sessions.find((entry) => entry.id === row.sessionId)!
    return (project === 'all' || workspaceForSession(config, session)?.id === project)
      && `${names[row.sessionId] ?? row.label} ${row.workspacePath} ${row.providerId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  })
  const selected = rows.find((row) => row.sessionId === selectedId)
  return <section className={`global-board-surface global-agents-board ${selectedId ? 'global-board-surface--session-open' : ''}`} aria-label="Agents">
    <div className="global-board-main">
      <header className="global-board-toolbar">
        <div className="global-board-toolbar__scope"><Users size={14} /><strong>Agents</strong><span className="global-board-toolbar__crumb">Sessions · Global</span></div>
        <div className="global-board-toolbar__controls">
          <label className="global-board-search"><Search size={13} /><input aria-label="Search agents" placeholder="Search agents" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label className="global-board-select">Project<select aria-label="Agent project filter" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All</option>{config?.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        </div>
      </header>
      {rows.length === 0 ? <div className="global-agents-empty" role="status"><Users size={20} /><strong>No Agent Sessions yet</strong><span>Start a Session from a Project to make it appear here.</span></div> : <div className="global-board-columns" aria-label="Global agent board">
        {(Object.keys(BUCKET_META) as AgentBucket[]).map((bucket) => {
          const meta = BUCKET_META[bucket]
          const Icon = meta.icon
          const grouped = filtered.filter((row) => bucketFor(row) === bucket)
          return <section className="global-board-column global-agents-group" data-bucket={bucket} key={bucket}>
            <header className="global-board-column__header"><span><Icon size={13} /><strong>{meta.label}</strong><em>{grouped.length}</em></span></header>
            <div className="global-board-column__cards">{grouped.map((row) => <button type="button" className={`global-session-card ${selectedId === row.sessionId ? 'global-session-card--selected' : ''}`} data-session-id={row.sessionId} data-attention={row.attention ?? undefined} aria-pressed={selectedId === row.sessionId} key={row.sessionId} onClick={() => setSelected(row.sessionId)}>
              <span className="global-session-card__topline"><AgentAvatar sessionId={row.sessionId} label={row.label} state={row.state} providerId={row.providerId} size={16} /><span>{agentProviderLabel(row.providerId)}</span><span>{row.state}</span></span>
              <strong className="global-session-card__title">{names[row.sessionId] ?? row.label}</strong>
              <span className="global-session-card__description">{row.workspacePath}</span>
              {row.awaitingReply ? <span className="global-session-card__meta">Awaiting your reply</span> : null}
            </button>)}{grouped.length === 0 ? <div className="global-board-column__empty">Nothing here</div> : null}</div>
          </section>
        })}
      </div>}
      <footer className="global-board-footer"><span>{filtered.length} of {rows.length} Agents</span></footer>
    </div>
    {selectedId ? <aside className="global-session-workspace" aria-label="Agent workspace">
      <header className="global-session-workspace__header"><div className="global-session-workspace__identity"><strong>{names[selectedId] ?? selected?.label ?? 'Session awaiting recovery'}</strong><small>{selected ? agentProviderLabel(selected.providerId) : selectedId}</small></div><button type="button" className="icon-button" aria-label="Close agent workspace" onClick={() => setSelected(null)}><PanelRightClose size={15} /></button></header>
      {selected && (selected.awaitingReply || selected.attention === 'needs-you') ? <div className="global-session-workspace__toolbar"><button type="button" className="global-board-action" onClick={() => setRequestId(selectedId)}>Review here</button></div> : null}
      <AgentTopologySummary sessionIds={[selectedId]} sessions={sessions} tabs={tabs} config={config} />
      <SessionObservationRegions sessionIds={[selectedId]} contextId={`agent:${selectedId}`} />
    </aside> : null}
    {requestId ? <AttentionRequestPanel sessionId={requestId} onClose={() => setRequestId(null)} onSessionChange={setSelected} /> : null}
  </section>
}
