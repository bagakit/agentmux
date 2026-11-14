import { useMemo } from 'react'
import type { MotePresenceReading } from '@agentmux/core/mote-preferences'
import { Button } from '@agentmux/client-ui/components/Button'
import type { MoteWorkfaceScope } from '../lib/mote-workface'
import { topicSpaceIconTarget } from '../lib/space-object-appearance'
import { useAppStore } from '../store'
import { SpaceObjectIcon } from './SpaceObjectIcon'
import { moteHeartbeatPresentation } from '../lib/mote-heartbeat-presentation'
import { originalMoteHeartbeatReport, type MoteHeartbeatReports } from '../lib/mote-heartbeat-report'
import { moteConnectionTarget } from '../lib/mote-connection-default'

function Stamp({ value }: { value: number }) {
  return <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
}

/** A reading of the original Host schedule. Appearance never supplies execution facts. */
export function MoteHeartbeatStatus({ scope, reading, reports, onOpenPath, loading, issue, onRefresh, actions, controls, settings = false, detailsActions, visible = true, unavailable = false }: {
  scope: MoteWorkfaceScope; reading?: MotePresenceReading | undefined; loading?: boolean | undefined; issue?: string | null | undefined
  onRefresh(): void; actions?: import('react').ReactNode; controls?: import('react').ReactNode; detailsActions?: import('react').ReactNode; visible?: boolean
  unavailable?: boolean
  settings?: boolean
  reports?: MoteHeartbeatReports | undefined
  onOpenPath?: ((path: string) => Promise<unknown>) | undefined
}) {
  const bindings = useAppStore(state => state.spaceZoneBindings)
  const resourceTarget = useMemo(() => moteConnectionTarget(scope, bindings), [scope, bindings])
  const target = useMemo(() => topicSpaceIconTarget(scope.workspace, scope.topic, bindings), [scope.workspace, scope.topic, bindings])
  const icon = useAppStore(state => target ? state.spaceObjectIcons[target.key] ?? null : null)
  const schedule = reading?.schedule
  const input = reading?.input, ref = schedule?.lastInputRef
  const report = originalMoteHeartbeatReport(ref, schedule?.loopId, reports)
  const guidance = reading?.guidance
  const native = input?.nativeResult.state
  const resultLabel = native === 'completed' ? 'This input finished' : native === 'failed' ? 'This input failed' : native === 'interrupted' ? 'This input was interrupted' : 'Execution result unconfirmed'
  const deliveryLabel = input?.delivery === 'native-admitted' ? 'Input accepted' : input?.delivery === 'terminal-confirmed' ? 'Sent · acceptance unconfirmed' : input?.delivery === 'not-applied' ? 'Confirmed not sent' : 'Delivery unconfirmed'
  const status = unavailable ? 'unconfirmed' : schedule?.status === 'stopped' ? 'stopped' : reading?.status ?? (loading ? 'unread' : 'unconfirmed')
  const title = { active: schedule?.lastOutcome === 'unknown' ? 'Delivery needs checking' : 'Heartbeat scheduled', paused: 'Heartbeat paused', disabled: 'Heartbeat off', unbound: 'No heartbeat target confirmed yet', unconfirmed: 'Schedule not yet confirmed', stopped: 'Heartbeat stopped', unread: 'Reading the actual schedule' }[status]
  const pauseExplanation = schedule?.status === 'paused' ? <p>{moteHeartbeatPresentation(reading, false).detail}</p> : null
  const readout = <div className="mote-heartbeat__reading" role="status">
      {!settings ? pauseExplanation : null}
      {schedule ? <dl>
        {schedule.everyMs && !controls ? <><dt>Interval</dt><dd>{schedule.everyMs / 60000} min</dd></> : null}
        <dt>Last check</dt><dd>{schedule.lastTickAt !== undefined ? <Stamp value={schedule.lastTickAt} /> : 'No recorded check yet'}<span className="mote-heartbeat__subline">{schedule.lastOutcome === 'unknown' ? 'Delivery unconfirmed' : schedule.lastOutcome === 'sent' ? 'Host accepted input' : schedule.lastOutcome === 'skipped' ? 'No input sent on this check' : 'No confirmed delivery yet'}</span></dd>
        {schedule.status === 'paused' && schedule.pause?.pausedAt !== undefined ? <><dt>Paused since</dt><dd><Stamp value={schedule.pause.pausedAt} /></dd></> : null}
        {ref ? <><dt>Last input</dt><dd><Stamp value={ref.preparedAt} /><span className="mote-heartbeat__subline">{deliveryLabel}</span></dd></> : null}
        {ref ? <><dt>Result</dt><dd>{resultLabel}</dd></> : null}
        {status === 'active' ? <><dt>Next opportunity</dt><dd><Stamp value={schedule.nextCheckAt} /></dd></> : null}
      </dl> : <p>{status === 'unbound' ? 'Start or choose this Mote’s main Agent to arrange automatic checks.' : status === 'disabled' ? 'Turn on heartbeat below to arrange automatic checks.' : 'Saved settings alone do not confirm that heartbeat is running.'}</p>}
    </div>
  return <section className="mote-heartbeat" data-mote-maintenance-status={status} data-settings={settings || undefined} aria-label="Mote heartbeat" aria-busy={loading || undefined}>
    {settings ? <header className="mote-heartbeat__settings-status" role="status">
      <h3>{title}</h3>
      {status === 'active' && schedule && schedule.lastOutcome !== 'unknown' ? <span>Next check <Stamp value={schedule.nextCheckAt} /></span> : null}
      {pauseExplanation}
    </header> : <>
    <header className="mote-heartbeat__identity">
      <span className="mote-heartbeat__portrait"><SpaceObjectIcon kind="mote" name={scope.topic.title} manualIcon={icon} avatarObjectKey={target?.key}
        avatarWorkspaceId={scope.workspace.id} avatarTopicId={scope.topic.id} visible={visible} /></span>
      <div><h3>{scope.topic.title}</h3><span className="mote-heartbeat__eyebrow">{title}</span></div>
    </header>
    <p className="mote-heartbeat__purpose">Keeps an eye on your goals, work and unfinished commitments.</p>
    </>}
    {controls ? <div className="mote-heartbeat__controls">{controls}</div> : null}
    {report && !settings ? <p className="mote-heartbeat__report-summary"><span>Agent report</span>{report.report.summary}</p> : null}
    {guidance ? <p className="mote-heartbeat__guidance-status">{!unavailable && guidance.adoptedRevision === guidance.availableRevision ? 'Current work cycle adopted' : 'Work cycle adoption not confirmed'}</p> : null}
    <div className="mote-heartbeat__actions">{actions}<Button type="button" disabled={loading} onClick={onRefresh}>{loading ? 'Reading…' : 'Refresh actual schedule'}</Button></div>
    {!settings ? readout : null}
    {ref ? <details className="mote-heartbeat__report"><summary>{report ? 'Report and saved Ideas' : 'Work report not confirmed'}</summary>
      {report ? <>{settings ? <p>{report.report.summary}</p> : null}<p className="mote-heartbeat__attribution">Reported by this Mote’s Agent · separate from input completion</p>
        {report.report.actions.map((action, index) => action.kind === 'idea' ? <div className="mote-heartbeat__idea" key={index}><span>{action.path}</span><small>{report.ideaEvidence.find(item => item.actionIndex === index)?.status === 'committed-note' ? 'Note commit confirmed' : report.ideaEvidence.find(item => item.actionIndex === index)?.status === 'observed-file' ? 'File revision observed' : 'Saved revision unconfirmed'}</small>
          {onOpenPath && resourceTarget && action.resource.hostId === resourceTarget.expectedResource.hostId && action.resource.workspaceId === resourceTarget.expectedResource.workspaceId && action.resource.workspacePath === resourceTarget.expectedResource.workspacePath && action.resource.zoneId === resourceTarget.zoneId ? <Button type="button" onClick={() => void onOpenPath(scope.rootPath + '/' + action.path)}>Open Idea</Button> : null}</div> : null)}
        <p>{report.report.inspected.some(item => item.sourceStatus === 'unconfirmed') ? 'Some declared sources remain unconfirmed.' : 'The report describes the Agent’s stated reading scope.'}</p></>
        : <p>{reports?.issue ?? (reports?.page?.next ? 'This bounded report page does not confirm a report for this input. Earlier reports remain in the original history.' : 'No report for this exact input was confirmed in this read. This does not mean nothing changed.')}</p>}
      {native === 'unsupported' ? <p>Your Agent can keep working in the original conversation. This Provider does not link terminal input to its exact execution result.</p> : input?.returnedIdle && native === 'unknown' ? <p>The original input returned idle. That alone does not confirm that it was processed or that work is complete.</p> : null}
    </details> : null}
    {issue || !schedule && reading?.issue ? <p className="mote-heartbeat__issue" role="status">{issue ?? reading?.issue}</p> : null}
    {schedule ? <details className="mote-heartbeat__details"><summary>Original schedule details</summary>
      {settings ? readout : null}
      {schedule.lastDecision ? <p>{schedule.lastDecision}</p> : null}
      {reading?.issue ? <p>{reading.issue}</p> : null}
      {schedule.pendingCompletion ? <p>Original input: <code>{schedule.pendingCompletion.operationId}</code>. An unconfirmed delivery is inspected before another input is considered.</p> : null}
      <dl><dt>Arrangement</dt><dd><code>{schedule.loopId}</code></dd>{ref ? <><dt>Original input</dt><dd><code>{ref.inputKey.attemptId ?? ref.inputKey.submissionId}</code></dd><dt>Prepared</dt><dd><Stamp value={ref.preparedAt} /></dd></> : <><dt>Original input</dt><dd>No retained input reference</dd></>}{schedule.status === 'paused' && schedule.pause?.pausedAt === undefined ? <><dt>Paused since</dt><dd>Original pause time not recorded</dd></> : null}</dl>
      {detailsActions}
    </details> : null}
  </section>
}
