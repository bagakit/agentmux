/** Portable Capsule contracts. Object IDs identify resources; they grant no authority. */
export type CapsuleStorageMode = 'managed' | 'path'
export type CapsuleMode = 'isolated' | 'injected'
export type CapsuleTheme = 'follow' | 'none'
export type CapsuleRouting = 'file' | 'spa'
export interface CapsuleTarget {
  hostId: string
  agentSessionId: string
}
export interface CapsuleSource {
  toolId?: string
  executionId?: string
  agentSessionId?: string
}
export interface CapsuleCaller {
  hostId: string
  agentSessionId?: string
}
export interface CapsuleRecord {
  capsuleId: string
  title: string
  revision: number
  storageMode: CapsuleStorageMode
  contentRoot: string
  sourcePath: string
  entry: string
  routing: CapsuleRouting
  mode: CapsuleMode
  theme: CapsuleTheme
  port: number
  createdAt: number
  updatedAt: number
  source?: CapsuleSource
  caller?: CapsuleCaller
  target?: CapsuleTarget
}
export interface CapsuleConfig {
  revision: number
  contentRoot: string
  defaultStorageMode: CapsuleStorageMode
  defaultMode: CapsuleMode
  defaultTheme: CapsuleTheme
}
export interface CapsuleIssue {
  code: string
  stage: 'registry' | 'content' | 'endpoint' | 'operation' | 'injection' | 'interaction' | 'config'
  message: string
  recovery: string
  capsuleId?: string
}
export type CapsuleEndpoint =
  | { status: 'available'; url: string; port: number; instanceId: string; observedAt: number }
  | { status: 'unavailable'; port: number; observedAt: number; issue: CapsuleIssue }
export type CapsuleContent =
  | { status: 'available'; observedAt: number }
  | { status: 'unavailable'; observedAt: number; issue: CapsuleIssue }
export interface CapsuleInspection {
  record: CapsuleRecord
  content: CapsuleContent
  endpoint: CapsuleEndpoint
  issues: CapsuleIssue[]
}
export interface CapsuleCreateParams {
  operationId: string
  sourcePath: string
  title?: string
  storageMode?: CapsuleStorageMode
  mode?: CapsuleMode
  theme?: CapsuleTheme
  entry?: string
  routing?: CapsuleRouting
  source?: CapsuleSource
  target?: CapsuleTarget
}
export interface CapsuleChanges {
  title?: string
  sourcePath?: string
  mode?: CapsuleMode
  theme?: CapsuleTheme
  entry?: string
  routing?: CapsuleRouting
}
export interface CapsuleMutationResult extends CapsuleInspection {
  operationId: string
  status: 'committed'
}
export interface CapsuleRemoveResult {
  operationId: string
  status: 'committed'
  capsuleId: string
  deletedContent: boolean
}
export interface CapsuleConfigResult {
  operationId: string
  status: 'committed'
  config: CapsuleConfig
}
export type CapsuleOperationStatus = 'pending' | 'committed' | 'failed'
export interface CapsuleOperation {
  operationId: string
  capsuleId?: string
  method: CapsuleMethod
  status: CapsuleOperationStatus
  createdAt: number
  updatedAt: number
  result?: unknown
  issue?: CapsuleIssue
}
export interface CapsuleInteraction {
  interactionId: string
  capsuleId: string
  operationId: string
  revision: number
  question: string
  draft: string
  createdAt: number
  updatedAt: number
  target?: CapsuleTarget
  status: 'pending' | 'answered'
  answer?: string
  reply?: CapsuleReplyState
}
export interface CapsuleRenderingUnavailable {
  status: 'unavailable'
  reason: string
}
export interface CapsuleRenderingAvailable {
  status: 'available'
  browserId: string
  tabId: string
  regionId: string
  workspaceId?: string
}
export interface CapsuleOpenResult {
  operationId: string
  capsuleId: string
  endpoint: CapsuleEndpoint
  rendering: CapsuleRenderingUnavailable | CapsuleRenderingAvailable
}
export interface CapsuleReplyResult {
  operationId: string
  interaction: CapsuleInteraction
  delivery: CapsuleInputObservation
}
export type CapsuleJson = null | boolean | number | string | CapsuleJson[] | { [key: string]: CapsuleJson }
/** Saved producer metadata is data only. No value in this envelope supplies current authority. */
export interface CapsulePreparedReply {
  version: 1
  operationId: string
  capsuleId: string
  interactionId: string
  inputOperationId: string
  target: CapsuleTarget
  expectedRun: { runId: string }
  principal: { kind: 'user' | 'device'; id: string }
  prompt: string
  adapterData?: CapsuleJson
}
/** A projection of the original Core input receipt, never an Agent completion claim. */
export interface CapsuleInputObservation {
  status: 'unavailable' | 'submitted' | 'unknown'
  inputOperationId: string
  expectedRun: { runId: string }
  inputStatus?: 'waiting' | 'stopped' | 'terminal-confirmed' | 'admitted' | 'not-applied' | 'unknown'
  reason?: string
  receipt?: CapsuleJson
}
export interface CapsuleReplyState {
  operationId: string
  phase: 'prepared' | 'dispatch-started' | 'observed'
  delivery: CapsuleInputObservation
}
export interface CapsuleReplyPort {
  prepare(
    input: { interaction: CapsuleInteraction; answer: string; inputOperationId: string; operationId: string },
    context: CapsuleCallContext,
  ): Promise<CapsulePreparedReply>
  submit(prepared: CapsulePreparedReply, context: CapsuleCallContext): Promise<CapsuleInputObservation>
  inspect(
    prepared: CapsulePreparedReply,
    context?: CapsuleCallContext,
  ): Promise<CapsuleInputObservation | null>
}
export interface CapsulePresentationPort {
  open(
    params: CapsuleParamsMap['capsule.open'],
    context: CapsuleCallContext | undefined,
    resolved: CapsuleResultMap['capsule.resolve'],
  ): Promise<CapsuleOpenResult>
  /** Reads an original presentation operation; null never authorizes another open. */
  inspect?(
    params: CapsuleParamsMap['capsule.open'],
    context?: CapsuleCallContext,
  ): Promise<CapsuleOpenResult | null>
}
export interface CapsuleParamsMap {
  'capsule.ls': Record<string, never>
  'capsule.inspect': { capsuleId: string }
  'capsule.resolve': { capsuleId: string }
  'capsule.create': CapsuleCreateParams
  'capsule.update': {
    capsuleId: string
    operationId: string
    expectedRevision: number
    changes: CapsuleChanges
  }
  'capsule.remove': {
    capsuleId: string
    operationId: string
    expectedRevision: number
    deleteContent?: boolean
  }
  'capsule.operation.inspect': { operationId: string }
  'capsule.config.inspect': Record<string, never>
  'capsule.config.update': {
    operationId: string
    expectedRevision: number
    changes: Partial<Omit<CapsuleConfig, 'revision'>>
  }
  'capsule.open': { capsuleId: string; operationId: string; placement?: unknown }
  'capsule.interaction.request': { capsuleId: string; operationId: string; question: string; draft?: string }
  'capsule.interaction.ls': { capsuleId: string }
  'capsule.interaction.inspect': { capsuleId: string; interactionId: string }
  'capsule.interaction.draft': {
    capsuleId: string
    interactionId: string
    operationId: string
    expectedRevision: number
    draft: string
  }
  'capsule.interaction.reply': {
    capsuleId: string
    interactionId: string
    operationId: string
    expectedRevision: number
    answer: string
  }
}
export interface CapsuleResultMap {
  'capsule.ls': { capsules: CapsuleInspection[]; issues: CapsuleIssue[] }
  'capsule.inspect': CapsuleInspection
  'capsule.resolve': { capsuleId: string; endpoint: CapsuleEndpoint }
  'capsule.create': CapsuleMutationResult
  'capsule.update': CapsuleMutationResult
  'capsule.remove': CapsuleRemoveResult
  'capsule.operation.inspect': { operation: CapsuleOperation | null }
  'capsule.config.inspect': { config: CapsuleConfig }
  'capsule.config.update': CapsuleConfigResult
  'capsule.open': CapsuleOpenResult
  'capsule.interaction.request': { operationId: string; interaction: CapsuleInteraction }
  'capsule.interaction.ls': { interactions: CapsuleInteraction[]; issues: CapsuleIssue[] }
  'capsule.interaction.inspect': { interaction: CapsuleInteraction }
  'capsule.interaction.draft': { operationId: string; interaction: CapsuleInteraction }
  'capsule.interaction.reply': CapsuleReplyResult
}
export type CapsuleMethod = keyof CapsuleParamsMap
export const CAPSULE_METHODS = {
  'capsule.ls': 'short',
  'capsule.inspect': 'short',
  'capsule.resolve': 'short',
  'capsule.create': 'long',
  'capsule.update': 'long',
  'capsule.remove': 'long',
  'capsule.operation.inspect': 'short',
  'capsule.config.inspect': 'short',
  'capsule.config.update': 'long',
  'capsule.open': 'long',
  'capsule.interaction.request': 'long',
  'capsule.interaction.ls': 'short',
  'capsule.interaction.inspect': 'short',
  'capsule.interaction.draft': 'long',
  'capsule.interaction.reply': 'long',
} as const satisfies Record<CapsuleMethod, 'short' | 'long'>
export interface CapsuleCallContext {
  caller?: CapsuleCaller
  principal?: { kind: 'user' | 'device'; id: string }
  signal?: AbortSignal
}
export interface CapsulePort {
  call<M extends CapsuleMethod>(
    method: M,
    params: CapsuleParamsMap[M],
    context?: CapsuleCallContext,
  ): Promise<CapsuleResultMap[M]>
}
/** Host binding is per exact document, not an authority inferred from HTTP or page declarations. */
export interface CapsuleDocumentBinding {
  capsuleId: string
  revision: number
  browserId: string
  documentId: string
}
export interface CapsuleInjectionPort {
  /** A failed optional injection must leave original content readable. No generic RPC or human reply channel. */
  html(binding: { record: CapsuleRecord; url: string }): Promise<string | null>
}
export interface CapsuleSdkCapabilities {
  version: 1
  theme: boolean
  interaction: boolean
  humanReply: false
}
export interface CapsuleSdkTheme {
  mode: 'light' | 'dark'
  tokens: Record<string, string>
}
export interface CapsuleSdk {
  capabilities(): Promise<CapsuleSdkCapabilities>
  theme(): Promise<CapsuleSdkTheme | null>
  onThemeChanged(listener: (theme: CapsuleSdkTheme | null) => void): () => void
  createOperationId(): string
  request(question: string, draft?: string, operationId?: string): Promise<CapsuleInteraction>
  read(interactionId: string): Promise<CapsuleInteraction>
  saveDraft(
    interactionId: string,
    expectedRevision: number,
    draft: string,
    operationId?: string,
  ): Promise<CapsuleInteraction>
  inspectOperation(operationId: string): Promise<CapsuleOperation | null>
}
