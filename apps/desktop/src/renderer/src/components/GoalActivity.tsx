import { useState } from 'react'
import { Button } from '@agentmux/client-ui/components/Button'
import type { DemandProjection } from '../lib/global-demand-board'

const RECENT = 6

/** Original recorded decisions are evidence, never inferred motives from activity prose. */
export function GoalActivity({ demand }: { demand: Pick<DemandProjection, 'id' | 'activities' | 'decisions'> }) {
  const [all, setAll] = useState(false)
  const timeline = [
    ...(demand.activities ?? []).map(activity => ({ key: `activity:${activity.id}`, at: activity.createdAt,
      label: activity.kind, text: activity.message, actorId: activity.actorId, decision: undefined })),
    ...(demand.decisions ?? []).map(decision => ({ key: `decision:${decision.id}`, at: decision.createdAt,
      label: 'Decision', text: decision.decision, actorId: decision.actorId, decision }))
  ].sort((left, right) => right.at - left.at)
  if (!timeline.length) return null
  const shown = all ? timeline : timeline.slice(0, RECENT)
  return <section className="goals-activity" key={demand.id} aria-label="Goal activity">
    <div className="goals-section-heading"><h2>Activity</h2><span className="goals-caption">{timeline.length}</span></div>
    <ol className="goals-activity__timeline">
      {shown.map(entry => <li className="goals-activity__row" key={entry.key} data-goal-activity-kind={entry.decision ? 'decision' : entry.label}>
        <div className="goals-activity__content"><b>{entry.label}</b>{entry.actorId ? <span className="goals-activity__actor"> · {entry.actorId}</span> : null}
          <time dateTime={new Date(entry.at).toISOString()}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(entry.at)}</time>
          <p>{entry.text}</p>
          {entry.decision ? <details className="goals-activity__decision" data-decision-id={entry.decision.id}>
            <summary>Decision details</summary>
            <dl><dt>Question</dt><dd>{entry.decision.question || 'Not recorded'}</dd>
              <dt>Rationale</dt><dd>{entry.decision.rationale || 'Not recorded'}</dd>
              <dt>Recorded actor</dt><dd>{entry.decision.actorId || 'Unknown'}</dd></dl>
          </details> : null}
        </div>
      </li>)}
    </ol>
    {timeline.length > RECENT ? <Button type="button" className="goals-activity__more" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? 'Show recent only' : `Show ${timeline.length - RECENT} earlier`}</Button> : null}
  </section>
}
