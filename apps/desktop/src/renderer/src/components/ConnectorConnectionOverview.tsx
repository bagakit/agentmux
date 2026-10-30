import { useEffect, useRef, useState, type ReactNode } from 'react'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import type { ConnectionRecord, RoomBinding } from '@agentmux/core/connections'
import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { api } from '../lib/api'
import type { GroupDiagnosis } from '../lib/group-diagnosis'
import { connectorConnectionPresentation } from '../lib/connector-connection-presentation'
import { ConnectorReceiverControl } from './ConnectorReceiverControl'
import '../styles/connector-connection-overview.css'

const OnlineIcon = semanticIconComponent('action.confirm'), UnknownIcon = semanticIconComponent('status.unknown'), LinkIcon = semanticIconComponent('object.connection')
/** One action surface over original owners. Local state is only this click's feedback, never connection health. */
export function ConnectorConnectionOverview({ binding, connection, report, hostingTarget, onCheck, onNavigate, compact = false, render }: {
  binding: RoomBinding; connection?: ConnectionRecord | undefined; report: GroupDiagnosis | null; hostingTarget?: ConnectionHostingTarget | null | undefined
  onCheck(): void; onNavigate?(section: 'overview' | 'diagnostics' | 'sharing' | 'sync' | 'channel-settings'): void; compact?: boolean
  render?(view: { overview: ReactNode; diagnostics: ReactNode; action: ReactNode; feedback: ReactNode }): ReactNode
}) {
  const model = connectorConnectionPresentation(report), key = JSON.stringify([hostingTarget, binding.connectionId, binding.bindingId, binding.revision])
  const current = useRef(key), live = useRef(true), flight = useRef<string | null>(null); current.current = key
  const [busy, setBusy] = useState(false), [feedback, setFeedback] = useState('')
  useEffect(() => { live.current = true; setBusy(false); setFeedback(''); return () => { live.current = false } }, [key])
  async function recoverSource() {
    if (flight.current === key || !hostingTarget) return
    const original = key, scope = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }, host = structuredClone(hostingTarget)
    flight.current = original; setBusy(true); setFeedback('')
    try {
      const result = await api.connections.call('connection.delivery.source.recover', scope, host)
      if (!live.current || current.current !== original) return
      setFeedback(result.disposition === 'joined' ? 'Joined the current sync work.' : result.disposition === 'requested' ? 'Sync recovery requested.' : 'Sync is disabled for this scope.')
      onCheck()
    } catch { if (live.current && current.current === original) setFeedback('Recovery reply unconfirmed. The same group is kept; try this request again.') }
    finally { if (flight.current === original) flight.current = null; if (live.current && current.current === original) setBusy(false) }
  }
  const Icon = model.state === 'online' ? OnlineIcon : model.state === 'unknown' ? UnknownIcon : LinkIcon
  const surface = (receiver: { primary: ReactNode; diagnostics: ReactNode; feedback?: ReactNode }) => {
    const primary = model.primary
    const button = primary !== 'check' ? <button className="primary-button" type="button" disabled={busy || primary === 'source' && !hostingTarget} data-source-recovery-action={primary === 'source' ? 'recover' : undefined} onClick={() => primary === 'source' ? void recoverSource() : onNavigate?.(primary)}>{busy ? 'Requesting…' : model.actionLabel}</button> :
      receiver.primary ?? <button className="primary-button" type="button" onClick={() => model.state === 'stopped' && compact && onNavigate ? onNavigate('overview') : onCheck()}>{model.state === 'stopped' && compact ? 'Open recovery' : model.actionLabel}</button>
    const overview = <section className={'connector-connection-overview' + (compact ? ' connector-connection-overview--compact' : '')} data-receiving-state={model.state}>
      {!compact && model.state === 'unknown' ? <small className="connector-connection-overview__caption">Bot connection</small> : null}
      <h3><span className="connector-connection-overview__symbol"><Icon size={compact ? 17 : 25} /></span><span>{model.title}</span></h3>
      {!compact ? <p>{model.scope}</p> : null}
      {model.hint ? <small className="connector-connection-overview__hint">{model.hint}</small> : null}
      <div className="connector-connection-overview__action">{button}</div>
      {receiver.feedback}
      {feedback ? <small role="status">{feedback}</small> : null}
    </section>
    return render ? render({ overview, diagnostics: receiver.diagnostics, action: button, feedback: <>{receiver.feedback}{feedback ? <small role="status">{feedback}</small> : null}</> }) : overview
  }
  // Compact lists do not inspect every bot's retained operation. Its honest entry
  // opens the original recovery surface; source wake itself needs no bot capability read.
  if (compact && !connection) return surface({ primary: null, diagnostics: null })
  return <ConnectorReceiverControl binding={binding} connection={connection} observed={report?.connection} hostingTarget={hostingTarget} onRefresh={onCheck} render={surface} />
}
