import type { ReactNode } from 'react'
import type { RoomBindingInspection, RoomBindingMappingDifference, RoomBindingOperation } from '@agentmux/core/connections'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { ConnectorEntityIdentity, ConnectorIdentityField } from './ConnectorEntityIdentity'

const StatusIcon = semanticIconComponent('object.link')
const differenceLabels: Record<RoomBindingMappingDifference, string> = {
  connection: 'Another bot connection', audience: 'Another group', target: 'Another Agent conversation',
  scope: 'Different sharing settings', source: 'Different conversation source', 'input-target': 'Different input target'
}

/** Presents the original receipt and the owner's bounded current observation; owns no binding decisions. */
export function ConnectorBindingRecovery({ operationId, operation, inspection, refused, preparing, canContinue, requestedGroup, agentName, botName, busy, onInspect, onReview, onContinue }: {
  operationId: string; operation: RoomBindingOperation | null | undefined; inspection: RoomBindingInspection | undefined; refused: boolean; preparing: boolean; canContinue: boolean
  requestedGroup: ReactNode; agentName: string; botName: string
  busy: boolean; onInspect(): void; onReview(): void; onContinue(): void
}) {
  const code = operation?.state === 'refused' ? operation.code : undefined
  const conflict = code === 'ROOM_BINDING_MAPPING_CONFLICT' ? inspection?.mappingConflict : undefined
  const state = refused ? 'refused' : preparing || canContinue ? 'preparing' : 'unknown'
  const explanation = refused
    ? code === 'ROOM_BINDING_MAPPING_CONFLICT'
      ? conflict?.current.length ? 'An existing group connection conflicts with this request. Review the current connection below before choosing a group.'
        : conflict ? 'The original request was refused because a connection conflicted. No conflicting connection was found in the latest check. Review your selection before submitting a new request.'
        : 'The original request conflicts with an existing group connection. Its current details are not available yet. Check status for details, or review your group selection.'
      : 'The original request was refused. Review your group selection and the receipt below before submitting a new request.'
    : state === 'preparing' ? preparing ? 'This original request has not finished. Continue setup using the same request.' : 'This request has not been sent. Continue setup to send the original request.'
      : 'The original request is kept. Check its status before submitting another connection request.'
  return <section className="connector-binding-recovery" aria-label="Group setup status" data-binding-recovery data-state={state}>
    <div className="connector-binding-recovery__heading"><span className="connector-binding-recovery__icon"><StatusIcon size={21} aria-hidden="true" /></span><div>
      <span className="connector-binding-recovery__eyebrow">{refused ? 'Connection refused' : state === 'preparing' ? preparing ? 'Setup in progress' : 'Setup not sent' : 'Awaiting confirmation'}</span>
      <h3>{refused ? 'Group connection was not saved' : state === 'preparing' ? 'Continue this group setup' : 'Connection result is not confirmed'}</h3>
    </div></div>
    <p className="agent-connector-note">{explanation}</p>
    <div className="connector-binding-recovery__request"><span className="connector-binding-recovery__label">Requested group</span>{requestedGroup}<p className="agent-connector-note">For <strong>{agentName}</strong> · via {botName}</p></div>
    {conflict?.current.length ? <div className="connector-binding-recovery__current"><h4>Current connections</h4>{conflict.current.map(({ binding, differences }) => <div key={binding.bindingId} className="connector-binding-recovery__relationship">
      <ConnectorEntityIdentity identityKey={binding.bindingId} kind="group" missingName={!differences.includes('audience') ? 'This requested group' : 'Another connected group'} compact
        secondary={<ConnectorIdentityField identityKey={binding.bindingId} label="Group ID" value={binding.externalConversationId} compact />} />
      <div className="connector-binding-recovery__target"><strong>{!differences.includes('target') ? agentName : 'Another Agent conversation'}</strong><ConnectorIdentityField identityKey={binding.bindingId} label="Session" value={binding.agentSessionId} compact /><span>Agent Host · {binding.executionHostId}</span></div>
      <p>{differences.length ? differences.map(difference => differenceLabels[difference]).join(' · ') : 'This group and conversation already have a saved connection.'}</p>
    </div>)}</div> : null}
    <div className="agent-connector-link-actions connector-binding-recovery__actions">
      {refused ? <button type="button" className="primary-button" disabled={busy} onClick={onReview}>Review group selection</button> : canContinue ? <button type="button" className="primary-button" disabled={busy} onClick={onContinue}>Continue setup</button> : null}
      <button type="button" className={refused || canContinue ? 'small-button' : 'primary-button'} disabled={busy} onClick={onInspect}>Check status</button>
    </div>
    <details className="agent-connector-disclosure connector-binding-recovery__receipt"><summary>Setup receipt details</summary><div className="connector-setup-section__body">
      <ConnectorIdentityField identityKey={operationId} label="Operation" value={operationId} />
      <ConnectorIdentityField identityKey={operationId} label="Original result" value={operation ? operation.state : 'Unknown'} />
      {code ? <ConnectorIdentityField identityKey={operationId} label="Reason code" value={code} /> : null}
      {conflict ? <p className="agent-connector-note">Current connections are from the latest inspection. The original refusal is unchanged.</p> : null}
    </div></details>
  </section>
}
