import { connectionDiagnosisSourceCodes, type ConnectionDeliverySourceObservation } from './connection-diagnosis-source.js'
import type { ConnectionObservation } from './connections-contract.js'
import type { RoomBindingScope } from './room-binding-contract.js'
import type { ConnectionDelivery, ConnectionDeliveryCoverage, ConnectionDeliveryObservation } from './connection-delivery-contract.js'
import type { AgentInputSubmissionReceipt, AgentInputWaitReason } from './agent-input-wait.js'

export const connectionDiagnosisWindowLimit = 5
export type ConnectionDiagnosisWindow = { after?: string; afterContent?: string; beforeIngressId?: string }
export type ConnectionDiagnosisInput = ConnectionDiagnosisWindow & {
  executionHostId: string; agentSessionId: string; bindingId?: string; bindingRevision?: number; afterBindingId?: string
}
export type ConnectionDiagnosisReading<T> = { value: T | null; issue: 'read-unavailable' | 'target-unconfirmed' | null; retained?: true }
export type ConnectionDiagnosisTarget = {
  bindingId: string; bindingRevision: number; publicationRevision: number; connectionId: string; domain: string; appId: string
  externalConversationId: string; executionHostId: string; agentSessionId: string
}
export type ConnectionDiagnosisAssociation = { sourceKey: string | null; recordKey: string | null; eventKey: string | null; partKey: string | null }
export type ConnectionDiagnosisDelivery = {
  kind: 'conversation' | 'permission' | 'binding-notice'
  association: ConnectionDiagnosisAssociation
  operationId: string; state: ConnectionDelivery['state']; receipt: NonNullable<ConnectionDelivery['receipt']>['state'] | null
  platformMessageId: string | null; reason: ConnectionDelivery['reason'] | null; resourceUpload: NonNullable<ConnectionDelivery['resourceUpload']>['state'] | null
}
export const connectionDiagnosisIntakeCodes = ['INGRESS_ACTOR_NOT_AUTHORIZED', 'INGRESS_BINDING_UNAVAILABLE', 'INGRESS_INPUT_OUTSIDE_SCOPE', 'INGRESS_ADDRESSING_UNCONFIRMED', 'INGRESS_AUTHORITY_REVISED', 'INGRESS_CONNECTION_UNAVAILABLE', 'INGRESS_SERVICE_DISABLED', 'INGRESS_SERVICE_UNCONFIRMED', 'INGRESS_STORAGE_UNCONFIRMED', 'INGRESS_TARGET_UNCONFIRMED', 'INGRESS_ACTION_UNSUPPORTED', 'INGRESS_CONTENT_UNSUPPORTED', 'INGRESS_CORE_UNAVAILABLE', 'INGRESS_CLAIM_UNAVAILABLE'] as const
export const connectionDiagnosisRecordingCodes = [...connectionDiagnosisIntakeCodes, 'EXTERNAL_RECORD_AUTHORITY_UNAVAILABLE', 'EXTERNAL_RECORD_TARGET_UNCONFIRMED', 'EXTERNAL_RECORD_CONFLICT', 'EXTERNAL_RECORD_UNAVAILABLE', 'INVALID_EXTERNAL_CONVERSATION'] as const
export { connectionDiagnosisSourceCodes } from './connection-diagnosis-source.js'
export type ConnectionDiagnosisGap = Pick<ConnectionDeliveryCoverage['gaps'][number], 'reason'> & {
  /** Diagnostic equality key; the original durable gap ID can contain private source identity. */
  gapKey: string
  code: typeof connectionDiagnosisSourceCodes[number] | null
  codeRecorded: boolean
  sourceKind: 'captured' | 'native' | 'native-unavailable' | null
  association: ConnectionDiagnosisAssociation
}
export type ConnectionDiagnosisIntake = {
  ingressId: string; sourceConnectionId: string; kind: 'message' | 'action'; state: 'received' | 'refused' | 'claimed'
  code: typeof connectionDiagnosisIntakeCodes[number] | null; codeRecorded: boolean
  bindingId: string | null; bindingRevision: number | null; targetConnectionId: string | null
  scope: 'current-binding' | 'other-binding' | 'group-event'; inputOperationId: string | null
  recording: { state: 'recorded' | 'unavailable' | 'refused' | 'not-started'; code?: typeof connectionDiagnosisRecordingCodes[number] } | null
  coreStatus: AgentInputSubmissionReceipt['status'] | 'saved' | 'bytes-accepted' | 'hook-written' | 'acp-acknowledged' | null
  coreObservation: 'not-started' | 'observed' | 'unavailable'; nativeAdoption: 'unknown' | null
  context?: import('./ingress-contract.js').ConnectionIngressContextObservation
  waiting: { phase: AgentInputWaitReason['phase']; reason: AgentInputWaitReason['reason']; wake: AgentInputWaitReason['wake'] } | null
}
export type ConnectionGroupDiagnosis = {
  target: ConnectionDiagnosisTarget; window: ConnectionDiagnosisWindow; limit: number
  adapterService: ConnectionDiagnosisReading<{ adapterId: string; enabled: boolean; revision: number }>
  connection: ConnectionDiagnosisReading<{ revision: number; enabled: boolean } & ConnectionObservation>
  binding: ConnectionDiagnosisReading<{ state: 'active' | 'paused' | 'detached'; currentRevision: number | null; scope: RoomBindingScope; activeInputGrants: number; activeAnswerGrants: number; activePermissionGrants: number }>
  outgoing: ConnectionDiagnosisReading<{
    after: string | null; afterContent: string | null; next: string | null; deliveries: ConnectionDiagnosisDelivery[]
    observation: ConnectionDeliveryObservation | null
    sourceObservation: ConnectionDeliverySourceObservation | null
    effectObservation: ConnectionDeliveryObservation | null
    coverage: { state: ConnectionDeliveryCoverage['state']; nextContent: string | null; gaps: ConnectionDiagnosisGap[]; originCount: number; omittedGapCount: number } | null
  }>
  incoming: ConnectionDiagnosisReading<{ beforeIngressId: string | null; next: string | null; rows: ConnectionDiagnosisIntake[] }>
}
/** A bounded local projection, not an atomic history or platform readiness check. */
export type ConnectionDiagnosis = {
  target: ConnectionDiagnosisInput
  service: ConnectionDiagnosisReading<{ enabled: boolean; revision: number }>
  groups: ConnectionDiagnosisReading<{ items: ConnectionGroupDiagnosis[]; nextBindingId: string | null }>
}
export type GroupDiagnosis = ConnectionGroupDiagnosis & Pick<ConnectionDiagnosis, 'service'>
export type ConnectionDiagnosisParamsMap = { 'connection.diagnose': ConnectionDiagnosisInput }
export type ConnectionDiagnosisResultMap = { 'connection.diagnose': ConnectionDiagnosis }
