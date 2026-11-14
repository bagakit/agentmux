import { demandAgentReferenceLabel } from '@agentmux/demand/relations'
import { useState } from 'react'
import { mintObjectId } from '@agentmux/core/object-id'
import { AGENTMUX_CONTROL_SCHEMA_VERSION } from '@agentmux/core/control'
import { formatSessionAddress } from '@agentmux/core/sharing'
import type { GoalResponsibilityPhase, GoalResponsibilityRow } from '@agentmux/core/goal-responsibility'
import type { DemandRecord } from '../lib/global-demand-board'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { GoalPatrolControl } from './GoalPatrolControl'
import { GoalContinuationAgent } from './GoalContinuationControl'

export const GOAL_RESPONSIBILITY_LABELS: Record<GoalResponsibilityPhase, string> = {
  executing: 'Executing', 'idle-grace': 'Awaiting report', stalled: 'Execution stalled', 'needs-input': 'Needs a response', blocked: 'Blocked',
  'waiting-external': 'Waiting on external conditions', 'report-review': 'Report awaiting collection', 'result-review': 'Results need verification',
  'handed-off': 'Handed off', ended: 'Original Run ended · Continue original work', unknown: 'Observation unconfirmed', closed: 'Closed'
}

/** Shared source-qualified responsibility in list, detail and Mote; navigation preserves original input. */
export function GoalResponsibilitySummary({ demand, compact = false, active = true, embedded = false, represented = new Set<string>(), primary }: { demand: DemandRecord; compact?: boolean; active?: boolean; embedded?: boolean; represented?: ReadonlySet<string> | undefined; primary?: boolean | undefined }) {
  const current = useAppStore(state => active ? state.demands[demand.id] ?? demand : demand)
  const [issue, setIssue] = useState<string | null>(null)
  const observed = current.responsibility, rows = (observed?.executions ?? []).filter(row => !represented.has(`${row.execution.kind}:${row.execution.operationId}`))
  const retained = Boolean(current.delegationReadCut && current.delegationReadCut.goalUpdatedAt < current.updatedAt)
  async function openAgent(id: string, hostId?: string) {
    try {
      if (hostId) {
        const result = await useAppStore.getState().executeControl({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: mintObjectId(),
          operation: 'focus', target: { kind: 'focus-agent', hostId, agentSessionId: id }, inputPolicy: 'preserve' })
        if (result.operation === 'focus' && result.navigation.state === 'rejected') { setIssue(result.issues.map(item => item.message).join(' ')); return }
      } else await api.ui.openObjectLink(formatSessionAddress(id))
      setIssue(null)
    }
    catch (error) { setIssue(error instanceof Error ? error.message : String(error)) }
  }
  const identity = (id: string, hostId?: string) => <button type="button" className="goal-responsibility__agent" onClick={event => { event.stopPropagation(); void openAgent(id, hostId) }} title={`Session ${id}${hostId ? ' · Host ' + hostId : ''}`}>
    <GoalContinuationAgent agentSessionId={id} {...(hostId === undefined ? {} : { hostId })} active={active} size={14} />
  </button>
  const attention = rows.filter(row => row.alert !== null)
  const visible = compact ? [...attention, ...rows.filter(row => row.alert === null)].slice(0, 2) : rows
  const hiddenAttention = attention.length - visible.filter(row => row.alert !== null).length
  const hasExecutionRecords = Boolean(current.delegations?.length || current.dispatches?.some(item => item.execution === 'finite'))
  // With nothing observed and nothing dispatched, Collaboration already states the absence; a patrol
  // or a retained issue still needs this block.
  const patrolPresent = Boolean(current.patrols?.some(item => item.purpose !== 'plan'))
  if (!observed && !hasExecutionRecords && !patrolPresent && !retained && !issue && !current.delegationObservationIssue) return null
  return <div className={`goal-responsibility${compact ? ' goal-responsibility--compact' : ''}`} aria-label="Execution responsibility" data-goal-responsibility={current.id}>
    {!compact && !embedded ? <strong className="goal-responsibility__heading">Execution responsibility</strong> : null}
    {observed && !embedded ? <div className="goal-responsibility__manager"><span>Supervisor</span>{observed.supervisor.agentReference ? <code>{demandAgentReferenceLabel(observed.supervisor.agentReference)}</code> : observed.supervisor.agentSessionId ? identity(observed.supervisor.agentSessionId, observed.supervisor.hostId) : <span>Unassigned</span>}
      {observed.supervisor.state === 'ended' ? <span className="goal-responsibility__notice">Supervisor Run ended · Restore original Session</span>
        : observed.supervisor.state === 'blocked' ? <span className="goal-responsibility__notice">Supervisor needs attention</span>
        : observed.supervisor.state === 'unknown' ? <span className="goal-responsibility__notice">Supervisor observation unconfirmed</span>
        : observed.supervisor.state === 'missing' ? <span className="goal-responsibility__notice">Supervisor unassigned</span> : null}
    </div> : null}
    {!observed && (!compact || current.delegations?.length || current.dispatches?.some(item => item.execution === 'finite')) ? <span className="goal-responsibility__pending">{current.delegations?.length || current.dispatches?.some(item => item.execution === 'finite') ? 'Reading original execution responsibility…' : 'No confirmed execution binding'}</span> : null}
    {visible.map(row => <div className="goal-responsibility__execution" key={`${row.execution.kind}:${row.execution.operationId}`}>
      <div className="goal-responsibility__line"><span className="goal-responsibility__label">Execution</span>{identity(row.execution.agentSessionId, row.execution.hostId)}
        <span className={`goal-responsibility__phase${row.alert ? ' goal-responsibility__phase--attention' : ''}`}>{GOAL_RESPONSIBILITY_LABELS[row.phase]}</span>
        {row.binding !== 'confirmed' ? <span className="goal-responsibility__binding">{row.binding === 'ambiguous' ? 'Multiple execution sources' : 'Original input unconfirmed'}</span> : null}
      </div>
      <div className="goal-responsibility__next"><span>Next</span>{row.nextOwner.agentReference ? <code>{demandAgentReferenceLabel(row.nextOwner.agentReference)}</code> : row.nextOwner.agentSessionId ? identity(row.nextOwner.agentSessionId,
        row.nextOwner.kind === 'manager' && row.nextOwner.agentSessionId === observed?.supervisor.agentSessionId ? observed.supervisor.hostId
          : row.nextOwner.kind === 'worker' && row.nextOwner.agentSessionId === row.execution.agentSessionId ? row.execution.hostId : undefined) : <span>{row.nextOwner.kind === 'human' ? 'Human review' : row.nextOwner.kind === 'external' ? 'External conditions' : 'Owner unconfirmed'}</span>}
        <span className="goal-responsibility__next-action">{row.nextOwner.action}</span>
      </div>
      {!compact || row.alert ? <p className="goal-responsibility__reason" role={row.alert ? 'status' : undefined}>{row.reason}</p> : null}
      {!compact ? <details className="goal-responsibility__source"><summary>Responsibility and source</summary>
        <dl><dt>Original execution</dt><dd>{row.execution.kind} · {row.execution.operationId}</dd><dt>Host / Run</dt><dd>{row.execution.hostId} / {row.execution.runId}</dd>
          <dt>State since</dt><dd>{row.stateSince ? new Date(row.stateSince).toLocaleString() : 'Unknown'}</dd><dt>Source</dt><dd>{row.observation?.source ?? 'Original observation unavailable'}</dd></dl>
        {row.progress ? <p>{row.progress.summary}{row.progress.evidence.map(source => <span className="goal-responsibility__evidence" key={source}>{source}</span>)}</p> : null}
      </details> : null}
    </div>)}
    {compact && rows.length > visible.length ? <span className="goal-responsibility__pending">{rows.length - visible.length} more original executions · Read details</span> : null}
    {compact && hiddenAttention > 0 ? <span className="goal-responsibility__notice" role="status">{hiddenAttention} more need attention · Read details</span> : null}
    {observed && !observed.executions.length && !compact ? <span className="goal-responsibility__pending">No confirmed execution binding; a relationship or historical Session is not an execution binding.</span> : null}
    {embedded && observed && !['available', 'busy'].includes(observed.supervisor.state)
      ? <p className="goals-caption" role="status">{observed.supervisor.state === 'ended' ? 'Supervisor Run ended' : observed.supervisor.state === 'unknown' ? 'Supervisor observation unconfirmed' : observed.supervisor.state === 'missing' ? 'Supervisor unassigned' : 'Supervisor needs attention'}</p> : null}
    <GoalPatrolControl demand={current} compact={compact} embedded={embedded} primary={primary} />
    {retained || issue || !embedded && current.delegationObservationIssue ? <p className="goal-responsibility__reason" role="status">{issue ?? (!embedded ? current.delegationObservationIssue : undefined) ?? 'Refreshing responsibility; last confirmed facts remain visible.'}</p> : null}
  </div>
}

/** The exact execution's owner facts, embedded in its one original work record. */
export function GoalExecutionResponsibility({ row }: { row: GoalResponsibilityRow | undefined }) {
  if (!row) return null
  return <div className="goal-work__responsibility" data-goal-execution-responsibility={`${row.execution.kind}:${row.execution.operationId}`}>
    <p><strong>{GOAL_RESPONSIBILITY_LABELS[row.phase]}</strong>{row.binding !== 'confirmed' ? <span> · {row.binding === 'ambiguous' ? 'Multiple execution sources' : 'Original input unconfirmed'}</span> : null}</p>
    <details><summary>Responsibility and source</summary>{row.reason ? <p>{row.reason}</p> : null}<p>{row.nextOwner.action}</p><dl><dt>Next owner</dt><dd>{row.nextOwner.agentReference ? demandAgentReferenceLabel(row.nextOwner.agentReference) : row.nextOwner.agentSessionId ?? row.nextOwner.kind}</dd>
      <dt>Original operation</dt><dd>{row.execution.kind} · {row.execution.operationId}</dd><dt>Host / Run</dt><dd>{row.execution.hostId} / {row.execution.runId}</dd>
      <dt>State since</dt><dd>{row.stateSince ? new Date(row.stateSince).toLocaleString() : 'Unknown'}</dd><dt>Source</dt><dd>{row.observation?.source ?? 'Unknown'}</dd></dl>{row.progress ? <p>{row.progress.summary}{row.progress.evidence.map(source => <span key={source}>{source}</span>)}</p> : null}</details>
  </div>
}
