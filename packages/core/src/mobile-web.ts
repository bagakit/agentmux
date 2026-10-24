import type { AgentMuxClientIncidentCode } from './client-incident.js'
import type { DiagnosticEvidenceRef } from '@agentmux/diagnostic-evidence'

/** Public phone Web facts. Page reports are observations, never device administration. */
export type MobileWebProducer = { devicePrincipalId: string; documentId: string }
export type MobileAssetRelease = {
  buildId: string
  digest: string
  bytes: number
  fileCount: number
}
export type MobileAssetsInspectParams = {
  hostId: string
  operationId?: string
  client?: MobileWebProducer
}
export type MobileAssetsActivateParams = {
  hostId: string
  operationId: string
  /** Literal relative directory inside the authenticated author's execution Workspace. */
  candidatePath: string
  candidateDigest: string
  expectedActiveRevision: number
}
export type MobileAssetsLoadedParams = {
  documentId: string
  buildId: string | null
  /** Original document URL namespace; never filled from the currently active release. */
  namespaceDigest: string | null
  occurrenceId: string
  observedAt: number
}
export type MobileAssetsLoadedReceipt = {
  hostId: string
  producer: MobileWebProducer
  hostInstanceId: string
  buildId: string | null
  namespaceDigest: string | null
  occurrenceId: string
  observedAt: number
  receivedAt: number
  accepted: boolean
  reason: 'capacity' | null
}
export type MobileAssetsActivationReceipt = {
  operationId: string
  hostInstanceId: string
  inputDigest: string
  expectedActiveRevision: number
  status: 'active' | 'rejected' | 'not-admitted'
  reason: 'busy' | 'capacity' | 'stale-revision' | 'candidate-invalid' | 'source-changed' | null
  candidate: MobileAssetRelease | null
  activeRevision: number
  /** This owner changes an in-memory HTTP snapshot; no disk publication is claimed. */
  persistence: 'not-requested'
  observedAt: number
}
export type MobileAssetsInspection = {
  hostId: string
  hostInstanceId: string
  active: (MobileAssetRelease & { revision: number }) | null
  retained: MobileAssetRelease[]
  retention: 'active-and-previous'
  operation: {
    operationId: string
    availability: 'found' | 'in-flight' | 'not-retained'
    receipt: MobileAssetsActivationReceipt | null
  } | null
  /** Bounded discovery of actually accepted page reports; not the Host device registry. */
  clients: MobileAssetsLoadedReceipt[]
  client: {
    target: MobileWebProducer
    availability: 'found' | 'not-retained'
    loaded: MobileAssetsLoadedReceipt | null
    namespace: 'retained' | 'not-retained' | 'unknown'
  } | null
  coverage: {
    lifetime: 'current-host-instance'
    operationsRetained: number
    operationsEvicted: number
    loadedRetained: number
    loadedRejected: number
  }
  observedAt: number
}
export type MobileAssetsParamsMap = {
  'app.mobile.assets.inspect': MobileAssetsInspectParams
  'app.mobile.assets.activate': MobileAssetsActivateParams
  'app.mobile.assets.loaded': MobileAssetsLoadedParams
}
export type MobileAssetsResultMap = {
  'app.mobile.assets.inspect': MobileAssetsInspection
  'app.mobile.assets.activate': MobileAssetsActivationReceipt
  'app.mobile.assets.loaded': MobileAssetsLoadedReceipt
}
export type MobileAssetsMethod = keyof MobileAssetsParamsMap
export type MobileAssetManifest = {
  schema: 'agentmux.mobile-web-release.v1'
  buildId: string
  files: Array<{ path: string; bytes: number; digest: string }>
  digest: string
}
export type MobileAssetsActivationAuthority = {
  hostId: string
  agentSessionId: string
  runId: string
  workspacePath: string
  assertCurrent(): Promise<void>
}
/** Borrowed original Host owner. No client, file or HTTP implementation enters Core. */
export type MobileAssetsPort = {
  inspect(params: MobileAssetsInspectParams): MobileAssetsInspection
  activate(params: MobileAssetsActivateParams, authority: MobileAssetsActivationAuthority): Promise<MobileAssetsActivationReceipt>
  loaded(params: MobileAssetsLoadedParams, devicePrincipalId: string): MobileAssetsLoadedReceipt
}

/** Finite original protocol observations. Arbitrary error text is never a report field. */
export type MobileWebObservation =
  | { kind: 'catalog-partial'; source: 'space.ls'; code: null; issueCount: number; spaceIds: string[]; omittedCount: number }
  | { kind: 'catalog-failed'; source: 'space.ls'; code: AgentMuxClientIncidentCode | null }
  | { kind: 'connection-state'; source: 'connection-state'; code: null; state: 'lost' | 'retrying' | 'restored' | 'unrecoverable'; boundary: 'consumer-core' | 'core-ctxmux' | null }
export type MobileWebReportParams = {
  documentId: string
  buildId: string | null
  namespaceDigest: string | null
  occurrenceId: string
  observedAt: number
  observation: MobileWebObservation
  reporter: { droppedCount: number; queuedCount: number; queuedBytes: number }
}
export type MobileWebReportReceipt = {
  hostId: string
  producer: MobileWebProducer
  accepted: boolean
  logId: string | null
  recordRef: DiagnosticEvidenceRef | null
  /** Admission is not the archive's eventual durable write acknowledgement. */
  persistence: 'unconfirmed'
}
export type MobileWebReportPort = {
  report(params: MobileWebReportParams, devicePrincipalId: string): MobileWebReportReceipt
}
