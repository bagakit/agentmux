import type { HostAgentResourceObservation } from '@agentmux/core'

export type AgentResourceRead = {
  current?: HostAgentResourceObservation
  confirmed?: HostAgentResourceObservation | undefined
  error?: string | undefined
  busy?: boolean
}

const time = (at: number) => new Date(at).toLocaleTimeString()
function note(read: AgentResourceRead | undefined) {
  const measurement = read?.confirmed?.measurement
  const at = measurement?.state === 'available' ? measurement.value.observedAt : undefined
  const issue = read?.error ?? (read?.current?.measurement.state === 'unavailable' ? read.current.measurement.message : undefined)
  return <>{issue ? `${issue}${at === undefined ? '' : ` Last confirmed ${time(at)}.`}` : at !== undefined ? `Sample ${time(at)}${read?.busy ? ' · reading…' : ''}` : read?.busy ? 'Reading…' : 'Not observed'}</>
}

/** Agent semantics come from the Core record owners, never the Native Run total. */
export function HostAgentResources({ records, running }: { records?: AgentResourceRead | undefined; running?: AgentResourceRead | undefined }) {
  const saved = records?.confirmed?.kind === 'records' && records.confirmed.measurement.state === 'available' ? records.confirmed.measurement.value : undefined
  const active = running?.confirmed?.kind === 'running' && running.confirmed.measurement.state === 'available' ? running.confirmed.measurement.value : undefined
  const oldRecords = Boolean(records?.error || records?.current?.measurement.state === 'unavailable')
  const oldRunning = Boolean(running?.error || running?.current?.measurement.state === 'unavailable')
  return <section className="host-agent-resources" aria-label="Agent record measurements">
    <header><strong>Agent records</strong><span>Original saved records</span></header>
    <div className="host-runtime__resources">
      <div><span>Saved</span><strong>{saved?.saved ?? '—'}</strong><small>{saved ? oldRecords ? 'Last confirmed' : 'Committed records' : records?.busy ? 'Reading…' : 'Not observed'}</small></div>
      <div><span>Running saved</span><strong>{active?.count ?? '—'}</strong><small>{active ? oldRunning ? 'Last confirmed' : 'Running bindings' : running?.busy ? 'Reading…' : 'Not observed'}</small></div>
      <div><span>Retired</span><strong>{saved?.retired ?? '—'}</strong><small>{saved ? oldRecords ? 'Last confirmed' : 'Retired records' : records?.busy ? 'Reading…' : 'Not observed'}</small></div>
    </div>
    <details className="host-runtime__details"><summary>Count sources{oldRecords || oldRunning ? ' · Some unavailable' : ''}</summary>
      <p className="host-runtime__sample" data-agent-source="records">Saved / Retired · {note(records)}</p>
      <p className="host-runtime__sample" data-agent-source="running">Running saved · {note(running)}{active ? ` · Native sample ${time(active.nativeObservedAt)}` : ''}</p>
      <p className="host-runtime__sample">These sources are read separately. Running saved counts saved Agents with a running Native Run; it does not describe Provider activity. Native Runs and helpers are counted separately below.</p>
    </details>
  </section>
}
