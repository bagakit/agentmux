import { compactReferenceId } from '@agentmux/client-ui/display-name'
import type { GoalResponsibilityRow } from '@agentmux/core/goal-responsibility'
import { demandAgentReferenceLabel, type DemandAgentReference } from '@agentmux/demand/relations'
import type { GoalNextStepSource } from '../lib/goal-presentation'
import { GoalExecutionResponsibility } from './GoalResponsibilitySummary'
import { GoalEvidence } from './GoalEvidence'
import type { GoalStartRow } from '../lib/goal-start-presentation'
import { GoalContinuationAgent } from './GoalContinuationControl'

/** Shares the Goal's original observation, navigation and result review; never invents an A2A report. */
export function GoalStartWork({ rows, supervisorSessionId, active, openAgent, review, responsibilities, focus, primary, embedded = false }: {
  responsibilities?: ReadonlyMap<string, GoalResponsibilityRow> | undefined; focus?: GoalNextStepSource | undefined; primary?: boolean; embedded?: boolean;
  rows: GoalStartRow[]; supervisorSessionId: DemandAgentReference | null | undefined; active: boolean
  openAgent: (sessionId: string, hostId?: string) => Promise<void>; review: () => Promise<void>
}) {
  return rows.map(({ start, observation, next, issue }) => <article className="goal-delegation__item" key={start.operationId} data-goal-work-operation={start.operationId} data-goal-work-kind="start">
    <strong data-goal-current-conclusion={focus?.kind === 'start' && focus.operationId === start.operationId ? true : undefined} data-goal-current-source={focus?.kind === 'start' && focus.operationId === start.operationId ? 'start' : undefined}>{next}</strong>
    <p className="goal-delegation__identity">Agent <span>{'target' in start ? <strong title={demandAgentReferenceLabel(start.target)}>{compactReferenceId(start.target.execution.agentSessionId)} · Runtime {compactReferenceId(start.target.execution.runtimeId)}</strong> : <GoalContinuationAgent agentSessionId={start.agentSessionId} hostId={start.hostId} active={active} size={14} />}</span>{!embedded ? <> · Follow-up {supervisorSessionId
      ? <span>{typeof supervisorSessionId === 'string' ? <GoalContinuationAgent agentSessionId={supervisorSessionId} active={active} size={14} /> : <strong title={demandAgentReferenceLabel(supervisorSessionId)}>{compactReferenceId(supervisorSessionId.execution.agentSessionId)} @ {compactReferenceId(supervisorSessionId.execution.runtimeId)}</strong>}</span> : 'needs an assigned Supervisor'}</> : null}</p>
    <GoalExecutionResponsibility row={responsibilities?.get(`start:${start.operationId}`)} />
    {!embedded && issue && issue !== responsibilities?.get(`start:${start.operationId}`)?.reason && (observation?.attention?.state === 'confirmed' || issue !== observation?.attention?.reason) ? <p className="goals-service" role="status">{issue}</p> : null}
    {embedded && observation?.input.state !== 'confirmed' && (!responsibilities?.get(`start:${start.operationId}`) || responsibilities.get(`start:${start.operationId}`)?.binding === 'confirmed') ? <p className="goals-caption">Original input unconfirmed</p> : null}
    {observation?.goalResult ? <p className={embedded ? 'goals-caption' : 'goals-service'}>Goal-level results are available. Their association with this Start is unknown.</p> : null}
    {embedded && observation?.attention ? <p className="goals-caption">Supervisor reminder {observation.attention.state === 'confirmed' ? 'received' : observation.attention.state}.
      {start.attention && observation.attention.state !== 'confirmed' ? <button type="button" className="small-button" onClick={() => void openAgent(start.attention!.supervisorAgentSessionId, start.attention!.hostId)}>Open original Supervisor</button> : null}
    </p> : !embedded && observation?.attention?.state === 'confirmed' ? <details className="goal-delegation__notice"><summary>Supervisor reminder received</summary><p>{observation.attention.reason} Goal results and human review remain separate.</p></details> : !embedded && observation?.attention ? <p className="goals-service" role="status">Supervisor reminder {observation.attention.state}. {observation.attention.reason} Reminder receipt does not accept this Goal.
      {start.attention ? <button type="button" className="small-button"
        onClick={() => void openAgent(start.attention!.supervisorAgentSessionId, start.attention!.hostId)}>Open original Supervisor</button> : null}
    </p> : null}
    <div className="goal-delegation__actions">
      {'target' in start ? <span className="goals-caption">Original Source member · current execution needs its exact Source entry</span> : <button type="button" className={primary !== false && focus?.kind === 'start' && focus.operationId === start.operationId && !observation?.goalResult ? 'primary-button' : 'small-button'} title={`Host ${start.hostId} · Session ${start.agentSessionId}`}
        onClick={() => void openAgent(start.agentSessionId, start.hostId)}>Open original Agent</button>}
      {observation?.goalResult ? <button type="button" className={primary !== false && (focus === undefined || focus.kind === 'start' && focus.operationId === start.operationId) ? 'primary-button' : 'small-button'} onClick={() => void review()}>Review results</button> : null}
    </div>
    <details className="goal-delegation__source"><summary>Original Start and input</summary>
      {embedded && issue && issue !== responsibilities?.get(`start:${start.operationId}`)?.reason && issue !== observation?.attention?.reason ? <p>{issue}</p> : null}
      {embedded && observation?.attention ? <p>Supervisor reminder {observation.attention.state}. {observation.attention.reason} Reminder receipt does not accept this Goal.</p> : null}
      <dl>{embedded ? <><dt>Follow-up</dt><dd>{supervisorSessionId ? demandAgentReferenceLabel(supervisorSessionId) : 'Needs an assigned Supervisor'}</dd></> : null}{'target' in start ? <><dt>Source member</dt><dd><code>{JSON.stringify(start.target)}</code></dd></> : <><dt>Host</dt><dd>{start.hostId}</dd><dt>Worker</dt><dd>{start.agentSessionId}</dd></>}<dt>Original Run</dt><dd>{start.runId}</dd>
        <dt>Start operation</dt><dd>{start.operationId}</dd><dt>Input observation</dt><dd>{observation?.input.state ?? 'unknown'}</dd>
        {start.receipt ? <><dt>Retained Core receipt</dt><dd>{start.receipt.kind === 'core-input' ? start.receipt.inputKey.submissionId : start.receipt.itemId}</dd></> : null}
        <dt>Result basis</dt><dd>{start.resultBasis ? 'Captured at this Start' : 'Unknown for this original Start'}</dd></dl>
      <pre>{start.prompt}</pre>
      {observation?.goalResult ? <div className="goal-delegation__checks"><p>{observation.goalResult.grounding.summary}</p>
        {observation.goalResult.grounding.checks.map(check => <div key={check.criterionId}><strong>{check.criterionId} · {check.outcome}</strong>
          {check.note ? <p>{check.note}</p> : null}<GoalEvidence evidence={check.evidence} criterion={check.criterionId} /></div>)}
      </div> : null}
    </details>
  </article>)
}
