import { AgentAvatar } from './AgentAvatar'
import { AlertCircle, CheckCircle2, Inbox, PanelRightClose, PlayCircle, Search, SquareTerminal, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAppStore } from '../store'
import { buildAgentRoster, type RosterRow } from '../lib/agent-roster'
import { isNeedsYouState } from '../lib/attention-vocabulary'
import { workspaceForSession } from '../lib/workbench-tabs'
import { agentProviderLabel } from './AgentProviderIcon'
import { AttentionRequestPanel } from './AttentionRequestPanel'
import { SessionObservationRegions } from './SessionObservationRegions'
import { AgentTopologySummary } from './AgentTopologySummary'
import { FocusHistory } from './FocusHistory'
import { PMO_TEAMS_TOPIC_ID } from '../../../shared/scratch-topics'
import { topicIdForSession } from '../lib/workbench-tabs'
import { executionFocusHistory, executionFocusSessionId } from '../lib/agent-focus'

type AgentBucket = 'needs-you' | 'working' | 'done' | 'error'
type FocusRow = Pick<RosterRow, 'sessionId' | 'label' | 'providerId' | 'workspacePath' | 'state' | 'attention' | 'awaitingReply'> & {
  kind: 'agent' | 'terminal'
}
const BUCKET_META = {
  'needs-you': { label: 'Needs you', icon: Inbox },
  working: { label: 'Working', icon: PlayCircle },
  done: { label: 'Results', icon: CheckCircle2 },
  error: { label: 'Error', icon: AlertCircle }
}
function bucketFor(row: Pick<FocusRow, 'state'>): AgentBucket {
  if (isNeedsYouState(row.state)) return 'needs-you'
  if (row.state === 'error') return 'error'
  if (row.state === 'done') return 'done'
  return 'working'
}

export function GlobalFocusSurface() {
  const sessions = useAppStore((state) => state.sessions)
  const config = useAppStore((state) => state.config)
  const tabs = useAppStore((state) => state.tabs)
  const providerCatalog = useAppStore((state) => state.providerCatalog)
  const names = useAppStore((state) => state.agentNames)
  const selectedId = useAppStore((state) => executionFocusSessionId(state.agentFocus))
  const executionHistory = useAppStore((state) => executionFocusHistory(state.agentFocus))
  const focusExecutionSession = useAppStore((state) => state.focusExecutionSession)
  const [query, setQuery] = useState('')
  const [project, setProject] = useState('all')
  const [requestId, setRequestId] = useState<string | null>(null)
  const executionRows = useMemo<FocusRow[]>(() => {
    const agentRows: FocusRow[] = buildAgentRoster({ sessions, providerCatalog })
      .map((row) => ({ ...row, kind: 'agent' as const }))
    const terminalRows: FocusRow[] = sessions
      .filter((session) => session.kind === 'terminal' && topicIdForSession(config, session) !== PMO_TEAMS_TOPIC_ID)
      .map((session) => ({
        sessionId: session.id,
        label: session.label,
        providerId: '',
        workspacePath: session.workspacePath,
        state: session.status.state,
        attention: null,
        awaitingReply: false,
        kind: 'terminal' as const
      }))
    return [...agentRows, ...terminalRows].filter((row) => {
      const session = sessions.find((entry) => entry.id === row.sessionId)
      return session && topicIdForSession(config, session) !== PMO_TEAMS_TOPIC_ID
    })
  }, [config, providerCatalog, sessions])
  const filtered = executionRows.filter((row) => {
    const session = sessions.find((entry) => entry.id === row.sessionId)!
    return (project === 'all' || workspaceForSession(config, session)?.id === project)
      && `${names[row.sessionId] ?? row.label} ${row.workspacePath} ${row.providerId}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  })
  const selected = executionRows.find((row) => row.sessionId === selectedId)
  return <section className={`global-board-surface global-focus-surface ${selectedId ? 'global-board-surface--session-open' : ''}`} aria-label="Focus">
    <div className="global-focus-layout">
      <FocusHistory entries={executionHistory} currentSessionId={selectedId} sessions={sessions.filter((session) => topicIdForSession(config, session) !== PMO_TEAMS_TOPIC_ID)} config={config} names={names} onSelect={focusExecutionSession} />
      <div className="global-board-main global-focus-main">
      <header className="global-board-toolbar">
        <div className="global-board-toolbar__scope"><Users size={14} /><strong>Focus</strong><span className="global-board-toolbar__crumb">Execution contexts · Global</span></div>
        <div className="global-board-toolbar__controls">
          <label className="global-board-search"><Search size={13} /><input aria-label="Search contexts" placeholder="Search contexts" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
          <label className="global-board-select">Project<select aria-label="Focus project filter" value={project} onChange={(event) => setProject(event.target.value)}><option value="all">All</option>{config?.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        </div>
      </header>
      {executionRows.length === 0 ? <div className="global-agents-empty" role="status"><Users size={20} /><strong>No execution contexts yet</strong><span>Open an Agent or Terminal from a Workspace to make it appear here.</span></div> : <div className="global-board-columns" aria-label="Global execution contexts">
        {(Object.keys(BUCKET_META) as AgentBucket[]).map((bucket) => {
          const meta = BUCKET_META[bucket]
          const Icon = meta.icon
          const grouped = filtered.filter((row) => bucketFor(row) === bucket)
          return <section className="global-board-column global-agents-group" data-bucket={bucket} key={bucket}>
            <header className="global-board-column__header"><span><Icon size={13} /><strong>{meta.label}</strong><em>{grouped.length}</em></span></header>
            <div className="global-board-column__cards">{grouped.map((row) => <button type="button" className={`global-session-card ${selectedId === row.sessionId ? 'global-session-card--selected' : ''}`} data-session-id={row.sessionId} data-attention={row.attention ?? undefined} aria-pressed={selectedId === row.sessionId} key={row.sessionId} onClick={() => focusExecutionSession(row.sessionId)}>
              <span className="global-session-card__topline">{row.kind === 'agent' ? <AgentAvatar sessionId={row.sessionId} label={row.label} state={row.state} providerId={row.providerId} size={16} /> : <span className="global-session-card__terminal-icon"><SquareTerminal size={15} /></span>}<span>{row.kind === 'agent' ? agentProviderLabel(row.providerId) : 'Terminal'}</span><span>{row.state}</span></span>
              <strong className="global-session-card__title">{names[row.sessionId] ?? row.label}</strong>
              <span className="global-session-card__description">{row.workspacePath}</span>
              {row.awaitingReply ? <span className="global-session-card__meta">Awaiting your reply</span> : null}
            </button>)}{grouped.length === 0 ? <div className="global-board-column__empty">Nothing here</div> : null}</div>
          </section>
        })}
      </div>}
      <footer className="global-board-footer"><span>{filtered.length} of {executionRows.length} contexts</span><span>PMO context is isolated</span></footer>
      </div>
    </div>
    {selectedId ? <aside className="global-session-workspace" aria-label="Focus workspace">
      <header className="global-session-workspace__header"><div className="global-session-workspace__identity"><strong>{names[selectedId] ?? selected?.label ?? 'Session awaiting recovery'}</strong><small>{selected ? (selected.kind === 'agent' ? agentProviderLabel(selected.providerId) : 'Terminal') : selectedId}</small></div><button type="button" className="icon-button" aria-label="Close Focus workspace" onClick={() => focusExecutionSession(null)}><PanelRightClose size={15} /></button></header>
      {selected && (selected.awaitingReply || selected.attention === 'needs-you') ? <div className="global-session-workspace__toolbar"><button type="button" className="global-board-action" onClick={() => setRequestId(selectedId)}>Review here</button></div> : null}
      <AgentTopologySummary sessionIds={[selectedId]} sessions={sessions} tabs={tabs} config={config} />
      <SessionObservationRegions sessionIds={[selectedId]} contextId={`agent:${selectedId}`} />
    </aside> : null}
    {requestId ? <AttentionRequestPanel sessionId={requestId} onClose={() => setRequestId(null)} onSessionChange={focusExecutionSession} /> : null}
  </section>
}
