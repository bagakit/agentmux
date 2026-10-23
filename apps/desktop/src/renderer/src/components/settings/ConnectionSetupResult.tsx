import { useEffect, useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { ConnectionObservation, ConnectionRecord, ConnectionStage } from '@agentmux/core/connections'
import { api } from '../../lib/api'
import type { ConnectionSettingsPort } from '../../lib/connection-settings-port'

const labels = { authentication: 'Application credentials', transport: 'Live connection', intake: 'Receiving messages', delivery: 'Group delivery' } as const
const stage = (value: ConnectionStage) => value.state === 'ready' ? 'Confirmed' : value.state === 'disabled' ? 'Paused' : value.state === 'unavailable' ? 'Needs attention' : 'Not confirmed'
const scope = (record: ConnectionRecord) => JSON.stringify([record.config.connectionId, record.config.adapterId, record.config.application, record.revision])
const sameApplication = (left: ConnectionRecord, right: ConnectionRecord) => left.config.connectionId === right.config.connectionId &&
  left.config.adapterId === right.config.adapterId && left.config.application.domain === right.config.application.domain && left.config.application.appId === right.config.application.appId

export function connectionSummary(record: ConnectionRecord): string {
  if (!record.config.enabled) return 'Application paused'
  const { authentication, transport, intake } = record.observation
  // A failed probe cannot take away a live connection confirmed by its owner.
  if (transport.state === 'ready') return intake.state === 'ready' ? 'Connected · messages received' : 'Connected · receiving not yet confirmed'
  if (transport.state === 'disabled') return 'Automatic chat sync is paused'
  if (authentication.state === 'unavailable') return 'Connection check needs attention'
  if (authentication.state === 'ready') return 'Credentials accepted · live connection not yet confirmed'
  return 'Saved · connection not yet confirmed'
}

type Reading = { key: string; source: typeof api.connections.call; record: ConnectionRecord | null; issue: string; notice: string }

/** One visible reading window on the existing Connection owner; saved receipts stay immutable. */
export function ConnectionSetupResult({ record, active = true, connections = api.connections }: { record: ConnectionRecord; active?: boolean; connections?: ConnectionSettingsPort }) {
  const key = scope(record), source = connections.call
  const [reading, setReading] = useState<Reading | null>(null), [busy, setBusy] = useState<string | null>(null)
  const occurrence = useRef(0), target = useRef({ key, source, active })
  target.current = { key, source, active }
  const visible = reading?.key === key && reading.source === source ? reading : null
  const current = visible?.record ?? null
  const pending = busy === key
  async function read(check: boolean) {
    const request = ++occurrence.current
    const accepts = () => request === occurrence.current && target.current.active && target.current.key === key && target.current.source === source
    setBusy(key)
    try {
      const observed = check ? await source('connection.test', { connectionId: record.config.connectionId })
        : (await source('connection.inspect', { connectionId: record.config.connectionId })).connection
      // Only this read is refused. The saved bot and its existing capabilities remain available.
      if (!observed || !sameApplication(observed, record) || observed.revision < record.revision) throw new Error('The current result could not be matched to this saved application.')
      if (accepts()) setReading(previous => {
        const known = previous?.key === key && previous.source === source ? previous.record : null
        return { key, source, record: known && known.revision > observed.revision ? known : observed, issue: '', notice: check ? 'Connection checked. The current result is shown above.' : '' }
      })
    } catch (error) {
      if (accepts()) setReading(previous => ({ key, source, record: previous?.key === key && previous.source === source ? previous.record : null, issue: presentError(error), notice: '' }))
    } finally { if (accepts()) setBusy(null) }
  }
  useEffect(() => {
    if (active) void read(false)
    return () => { occurrence.current++ }
  }, [active, key, source])
  if (!active) return null
  const title = current ? connectionSummary(current) : pending ? 'Reading the current connection…' : 'Saved · current connection not confirmed'
  const detail = current?.observation.transport.state === 'ready'
    ? 'The live connection is confirmed. Group access and delivery are checked separately for each Agent.'
    : current && (!current.config.enabled || current.observation.transport.state === 'disabled')
      ? 'Your bot and groups are kept. Review the application or automatic chat sync setting to resume.'
      : 'Check this same bot here. This does not create another bot or send a message.'
  return <div className="settings-pane-stack" data-connection-setup-result={record.config.connectionId}>
    <div className="connector-connection-state" role="status"><strong>{visible?.issue && current ? 'Last confirmed: ' : ''}{title}</strong><span>{detail}</span></div>
    <div className="connector-editor-actions"><button data-connection-check className="primary-button" disabled={pending} onClick={() => void read(true)}>{pending ? 'Checking…' : 'Check connection'}</button></div>
    {visible?.issue ? <p className="connector-check-feedback" role="status">The current connection could not be confirmed. Your saved bot and original setup are kept; you can check again.</p> : current?.observation.authentication.state === 'unavailable' ? <p className="connector-check-feedback" role="status">The credential check needs attention. {current.observation.transport.state === 'ready' ? 'The live connection remains confirmed.' : 'Your saved bot is kept.'} Check again here for a current result.</p> : visible?.notice ? <p className="connector-check-feedback" role="status">{visible.notice}</p> : null}
    <details className="connector-diagnostics"><summary>Connection details</summary>
      <dl className="connector-identity" aria-label="Saved application identity"><div><dt>Platform</dt><dd>{record.config.application.domain}</dd></div><div><dt>App ID</dt><dd><code>{record.config.application.appId}</code></dd></div></dl>
      {!current ? <p className="settings-group-note">The save receipt is kept. Current connection checks have not been confirmed here.</p> : null}
      <dl className="connector-stage-list">{(Object.keys(labels) as Array<keyof ConnectionObservation>).map(name => <div key={name} data-connection-stage={name} data-state={current?.observation[name].state ?? 'unknown'}><dt>{labels[name]}</dt><dd>{!current ? 'Not confirmed' : name === 'delivery' && current.observation[name].state === 'unknown' && current.observation[name].reason === 'not-started' ? 'View delivery in each Agent’s Shared group details' : <>{stage(current.observation[name])}{current.observation[name].reason ? <span className="connector-stage-reason">{current.observation[name].reason}</span> : null}</>}</dd></div>)}</dl>
      {visible?.issue ? <p className="connector-enrollment__technical">{visible.issue}</p> : null}
    </details>
  </div>
}
