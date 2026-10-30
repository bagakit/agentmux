import { originalInputExplanation } from './original-input-presentation'
import type { ConnectionDiagnosisGap, ConnectionDiagnosisIntake, ConnectionDelivery, ConnectionDeliverySourceObservation } from '@agentmux/core/connections'

export type ConnectorExplanation = { title: string; detail: string }
const missingCause = (recorded: boolean) => recorded ? 'A reason was recorded, but its safe detail is not available here.' : 'No finer reason was recorded.'

/** Presentation of original typed facts only. These descriptions never authorize recovery. */
export function connectorSourceExplanation(source: ConnectionDeliverySourceObservation | null | undefined): ConnectorExplanation {
  if (source?.state === 'ready') return { title: 'Conversation read confirmed', detail: 'This confirms this reading only; earlier delivery results are separate.' }
  if (source?.code === 'AGENT_SESSION_HISTORY_BUSY') return { title: 'Conversation reading is busy', detail: 'Other reads are still running. This read did not complete; check the current result.' }
  if (source?.code === 'AGENT_SESSION_HISTORY_TIMEOUT' || source?.code === 'AGENT_SESSION_HISTORY_OBSERVATION_TIMEOUT') return { title: 'Conversation read timed out', detail: 'This read did not finish within its observation window. Existing receipts are kept.' }
  if (source?.code === 'AGENT_SESSION_HISTORY_BUDGET' || source?.code === 'AGENT_SESSION_HISTORY_TOO_LARGE') return { title: 'Source reading exceeded its page budget', detail: 'This limit applies to the current reading window. Original history is kept for bounded continuation.' }
  if (source?.code === 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') return { title: 'Saved conversation source changed', detail: 'The saved reading position no longer matches this conversation. Messages and the unread range are kept for review.' }
  if (source?.code === 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE') return { title: 'Conversation identity unavailable', detail: 'This conversation’s identity could not be obtained. Existing messages and the Agent are kept.' }
  if (source?.code === 'AGENT_CONVERSATION_VERSION_UNAVAILABLE' || source?.code === 'AGENT_CONVERSATION_VIEW_EXPIRED' || source?.code === 'AGENT_SESSION_HISTORY_INVALID_CURSOR') return { title: 'Original reading window unavailable', detail: 'This original window could not continue. Check the current source result; original messages are kept.' }
  if (source?.code === 'CONVERSATION_AUTHOR_CONFLICT') return { title: 'Original author facts conflict', detail: 'The source has conflicting recorded authors. No author was inferred.' }
  if (source?.code === 'CONVERSATION_ANCHOR_UNREAD' || source?.code === 'CONVERSATION_OBSERVED_TARGET_UNREAD' || source?.code === 'CONVERSATION_QUESTION_TARGET_UNREAD') return { title: 'Original referenced record is unread', detail: 'The exact referenced record has not been read. Existing independent content remains available.' }
  if (source?.reason === 'storage-unconfirmed') return { title: 'Source reading record unavailable', detail: 'This reading could not confirm the local source record. Earlier receipts are kept.' }
  if (source?.code) return { title: 'Conversation read incomplete', detail: 'The read reported a specific issue. Its recorded code is available in the reading details.' }
  return { title: source ? 'Conversation read incomplete' : 'Conversation reading unavailable', detail: missingCause(source?.codeRecorded === true) }
}

export function connectorGapExplanation(gap: Pick<ConnectionDiagnosisGap, 'reason' | 'code' | 'codeRecorded'>): ConnectorExplanation {
  const source = gap.code ? connectorSourceExplanation({ state: 'unavailable', reason: 'source-gap', code: gap.code, codeRecorded: gap.codeRecorded, checkpointKey: null }) : null
  if (gap.reason === 'source-gap' && source) return source
  const title = ({ 'public-content-unconfirmed': 'Some content is not ready to share', 'transport-unsupported': 'This content is unsupported by the channel',
    'resource-unavailable': 'Original content resource is unreadable', 'start-cut-unconfirmed': 'Original sharing boundary is unconfirmed', 'source-gap': 'Original content source has a reading gap',
    'version-unavailable': 'Original content version is unavailable' })[gap.reason]
  return { title, detail: (source ? source.title + '.' : missingCause(gap.codeRecorded)) + ' Other messages can still be delivered.' }
}


export function connectorIntakeExplanation(row: ConnectionDiagnosisIntake): ConnectorExplanation {
  if (row.coreObservation === 'unavailable') return { title: 'Original input receipt unreadable', detail: 'This input receipt could not be read. The original received event is kept.' }
  if (row.inputOperationId) return originalInputExplanation(row.coreStatus, row.waiting)
  if (row.state === 'refused') {
    const title = row.code === 'INGRESS_CONTENT_UNSUPPORTED' ? 'This message content is unsupported' : row.code === 'INGRESS_QUESTION_ANSWER_INVALID' ? 'Original question answers did not validate' :
      row.code === 'INGRESS_ACTOR_NOT_AUTHORIZED' ? 'This sender was not authorized when received' : row.code === 'INGRESS_ACTION_UNSUPPORTED' ? 'This group action is unsupported' : 'Original request was refused'
    return { title, detail: 'No Agent input was recorded for this event. ' + (row.code ? 'Its recorded reason is available in the original details.' : missingCause(row.codeRecorded)) }
  }
  return { title: row.recording?.state === 'recorded' ? 'Original conversation message recorded' : 'Original event recording unconfirmed', detail: 'No Agent submission was recorded for this event.' }
}

export function connectorDeliveryExplanation(value: { state: ConnectionDelivery['state']; receipt: NonNullable<ConnectionDelivery['receipt']>['state'] | null; reason: ConnectionDelivery['reason'] | null }): ConnectorExplanation {
  if (value.receipt === 'unknown' || value.state === 'unknown') return { title: 'Delivery result unconfirmed', detail: 'This request may have taken effect. Check its receipt; do not send it again.' }
  if (value.receipt === 'not-applied' || value.state === 'not-applied') {
    const title = value.reason === 'rate-limited' ? 'Platform rate limit' : value.reason === 'unsupported-format' ? 'Platform rejected this message format' :
      value.reason === 'thread-unavailable' ? 'Original group or reply target unavailable' : value.reason === 'platform-rejected' ? 'Platform rejected this request' :
      value.reason === 'adapter-unavailable' ? 'Channel adapter unavailable' : value.reason === 'platform-unavailable' ? 'Platform unavailable' : 'Original request did not take effect'
    return { title, detail: 'Check this receipt for the next available action.' }
  }
  if (value.receipt === 'confirmed') return { title: 'Delivered', detail: 'This confirms this request only.' }
  if (value.state === 'superseded') return { title: 'Superseded', detail: 'This does not settle other earlier requests.' }
  if (value.state === 'pending') return { title: 'Delivery pending', detail: 'No delivery receipt is recorded yet.' }
  return { title: 'Original delivery result unavailable', detail: 'Check this original operation. No outcome is inferred from this page.' }
}
