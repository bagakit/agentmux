import type { GoalStartRow } from '../lib/goal-start-presentation'
import { GoalContinuationAgent } from './GoalContinuationControl'

/** Shares the Goal's original observation, navigation and result review; never invents an A2A report. */
export function GoalStartWork({ rows, supervisorSessionId, active, openAgent, review }: {
  rows: GoalStartRow[]; supervisorSessionId: string | null | undefined; active: boolean
  openAgent: (sessionId: string) => Promise<void>; review: () => Promise<void>
}) {
  return rows.map(({ start, observation, next, issue }) => <article className="goal-delegation__item" key={start.operationId}>
    <strong>{next}</strong>
    <p className="goal-delegation__identity">Agent <span><GoalContinuationAgent agentSessionId={start.agentSessionId} hostId={start.hostId} active={active} size={14} /></span> · Follow-up {supervisorSessionId
      ? <span><GoalContinuationAgent agentSessionId={supervisorSessionId} active={active} size={14} /></span> : 'needs an assigned Supervisor'}</p>
    {issue ? <p className="goals-service" role="status">{issue}</p> : null}
    {observation?.goalResult ? <p className="goals-service">Goal-level results are available. Their association with this Start is unknown.</p> : null}
    {observation?.attention?.state === 'confirmed' ? <details className="goal-delegation__notice"><summary>Supervisor reminder received</summary><p>{observation.attention.reason} Goal results and human review remain separate.</p></details> : observation?.attention ? <p className="goals-service" role="status">Supervisor reminder {observation.attention.state}. {observation.attention.reason} Reminder receipt does not accept this Goal.
      {start.attention ? <button type="button" className="goals-button"
        onClick={() => void openAgent(start.attention!.supervisorAgentSessionId)}>Open original Supervisor</button> : null}
    </p> : null}
    <div className="goal-delegation__actions">
      <button type="button" className="goals-button" title={`Host ${start.hostId} · Session ${start.agentSessionId}`}
        onClick={() => void openAgent(start.agentSessionId)}>Open original Agent</button>
      {observation?.goalResult ? <button type="button" className="goals-button goals-button--primary" onClick={() => void review()}>Review results</button> : null}
    </div>
    <details className="goal-delegation__source"><summary>Original Start and input</summary>
      <dl><dt>Host</dt><dd>{start.hostId}</dd><dt>Worker</dt><dd>{start.agentSessionId}</dd><dt>Original Run</dt><dd>{start.runId}</dd>
        <dt>Start operation</dt><dd>{start.operationId}</dd><dt>Input observation</dt><dd>{observation?.input.state ?? 'unknown'}</dd>
        {start.receipt ? <><dt>Retained Core receipt</dt><dd>{start.receipt.itemId}</dd></> : null}
        <dt>Result basis</dt><dd>{start.resultBasis ? 'Captured at this Start' : 'Unknown for this original Start'}</dd></dl>
      <pre>{start.prompt}</pre>
      {observation?.goalResult ? <div className="goal-delegation__checks"><p>{observation.goalResult.grounding.summary}</p>
        {observation.goalResult.grounding.checks.map(check => <div key={check.criterionId}><strong>{check.criterionId} · {check.outcome}</strong>
          {check.note ? <p>{check.note}</p> : null}{check.evidence.map(evidence => <span key={evidence}>{evidence}</span>)}</div>)}
      </div> : null}
    </details>
  </article>)
}
