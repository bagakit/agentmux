import { useMemo } from 'react'
import type { MotePresenceReading } from '@agentmux/core/mote-preferences'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { useAppStore } from '../store'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { moteHeartbeatPresentation } from '../lib/mote-heartbeat-presentation'

function Stamp({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
}

/** A reading of the original Host schedule. Appearance never supplies execution facts. */
export function MoteHeartbeatStatus({ scope, reading, loading, issue, onRefresh, actions, controls, detailsActions, visible = true, unavailable = false }: {
  scope: MoteWorkfaceScope; reading?: MotePresenceReading | undefined; loading?: boolean | undefined; issue?: string | null | undefined
  onRefresh(): void; actions?: import('react').ReactNode; controls?: import('react').ReactNode; detailsActions?: import('react').ReactNode; visible?: boolean
  unavailable?: boolean
}) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const target = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic, bindings), [scope.workspace, scope.topic, bindings])
  const icon = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  const schedule = reading?.schedule
  const status = unavailable ? 'unconfirmed' : schedule?.status === 'stopped' ? 'stopped' : reading?.status ?? (loading ? 'unread' : 'unconfirmed')
  const title = { active: schedule?.lastOutcome === 'unknown' ? 'Delivery needs checking' : 'Heartbeat scheduled', paused: 'Heartbeat paused', disabled: 'Heartbeat off', unbound: 'No heartbeat target confirmed yet', unconfirmed: 'Schedule not yet confirmed', stopped: 'Heartbeat stopped', unread: 'Reading the actual schedule' }[status]
  return <section className="mote-heartbeat" data-mote-maintenance-status={status} aria-label="Mote heartbeat" aria-busy={loading || undefined}>
    <header className="mote-heartbeat__identity">
      <span className="mote-heartbeat__portrait"><SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={target?.key}
        avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} visible={visible} /></span>
      <div><span className="mote-heartbeat__eyebrow">Mote heartbeat</span><h3>{scope.topic.title} keeps an eye on things</h3></div>
    </header>
    <p className="mote-heartbeat__purpose">Checks your work, goals and unfinished commitments. Stays quiet when nothing needs attention.</p>
    {controls ? <div className="mote-heartbeat__controls">{controls}</div> : null}
    <div className="mote-heartbeat__reading" role="status">
      <strong>{title}</strong>
      {schedule?.status === 'paused' ? <p>{moteHeartbeatPresentation(reading, false).detail}</p> : null}
      {schedule ? <dl>
        {schedule.everyMs && !controls ? <><dt>Interval</dt><dd>{schedule.everyMs / 60000} min</dd></> : null}
        <dt>Last check</dt><dd>{schedule.lastTickAt !== undefined ? <Stamp value={schedule.lastTickAt} /> : 'No recorded check yet'}</dd>
        {schedule.status === 'paused' ? <><dt>Paused since</dt><dd>{schedule.pause?.pausedAt !== undefined ? <Stamp value={schedule.pause.pausedAt} /> : 'Original pause time not recorded'}</dd></> : null}
        <dt>Result</dt><dd>{schedule.lastOutcome === 'unknown' ? 'Delivery unconfirmed' : schedule.lastOutcome === 'sent' ? 'Host accepted input · progress is in the conversation' : schedule.lastOutcome === 'skipped' ? 'No input sent' : 'No confirmed delivery yet'}</dd>
        {status === 'active' ? <><dt>Next opportunity</dt><dd><Stamp value={schedule.nextCheckAt} /></dd></> : null}
      </dl> : <p>{status === 'unbound' ? 'Start or choose this Mote’s main Agent to arrange automatic checks.' : status === 'disabled' ? 'Turn on heartbeat below to arrange automatic checks.' : 'Saved settings alone do not confirm that heartbeat is running.'}</p>}
    </div>
    {issue || !schedule && reading?.issue ? <p className="mote-heartbeat__issue" role="status">{issue ?? reading?.issue}</p> : null}
    <div className="mote-heartbeat__actions">{actions}<button type="button" className="small-button" disabled={loading} onClick={onRefresh}>{loading ? 'Reading…' : 'Refresh actual schedule'}</button></div>
    {schedule ? <details className="mote-heartbeat__details"><summary>Original schedule details</summary>
      {schedule.lastDecision ? <p>{schedule.lastDecision}</p> : null}
      {reading?.issue ? <p>{reading.issue}</p> : null}
      {schedule.pendingCompletion ? <p>Original input: <code>{schedule.pendingCompletion.operationId}</code>. An unconfirmed delivery is inspected before another input is considered.</p> : null}
      <pre>{JSON.stringify(schedule, null, 2)}</pre>
      {detailsActions}
    </details> : null}
  </section>
}
