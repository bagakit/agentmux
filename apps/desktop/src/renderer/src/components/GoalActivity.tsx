import type { DemandProjection } from '../lib/global-demand-board'

/** Original recorded decisions are evidence, never inferred motives from activity prose. */
export function GoalActivity({ demand }: { demand: Pick<DemandProjection, 'id' | 'activities' | 'decisions'> }) {
  const timeline = [
    ...(demand.activities ?? []).map(activity => ({ key: `activity:${activity.id}`, at: activity.createdAt,
      label: activity.kind, text: activity.message, decision: undefined })),
    ...(demand.decisions ?? []).map(decision => ({ key: `decision:${decision.id}`, at: decision.createdAt,
      label: 'Decision', text: decision.decision, decision }))
  ].sort((left, right) => right.at - left.at)
  return timeline.length ? <details className="goals-activity" key={demand.id}>
    <summary>Activity<span>{timeline.length}</span></summary>
    {timeline.map(entry => <div className="goals-activity__row" key={entry.key}>
      <time dateTime={new Date(entry.at).toISOString()}>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(entry.at)}</time>
      <div className="goals-activity__content"><b>{entry.label}</b> <span>{entry.text}</span>
        {entry.decision ? <details className="goals-activity__decision" data-decision-id={entry.decision.id}>
          <summary>Decision details</summary>
          <dl><dt>Question</dt><dd>{entry.decision.question || 'Not recorded'}</dd>
            <dt>Rationale</dt><dd>{entry.decision.rationale || 'Not recorded'}</dd>
            <dt>Recorded actor</dt><dd>{entry.decision.actorId || 'Unknown'}</dd></dl>
        </details> : null}
      </div>
    </div>)}
  </details> : null
}
