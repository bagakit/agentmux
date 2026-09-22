import type { BrowserOperation } from '../shared/browser-operation.js'
import type { BrowserStepEvidenceRead } from '../shared/browser-step-evidence.js'
import { BROWSER_RESULT_MAX_READ_BYTES, type BrowserResultArtifactChunk, type BrowserResultArtifactReference,
  type BrowserResultReadOptions } from '../shared/browser-result-artifact.js'
import type { BrowserDownloadChunk, BrowserDownloadReadOptions, BrowserDownloadReceipt, BrowserDownloadReference } from '../shared/browser-download.js'
import type { BrowserStructuredSource } from '../shared/browser-structured-output.js'
import { BROWSER_OUTCOME_LIMITS, parseBrowserOutcomeCriteriaRequest,
  type BrowserOutcomeAssetRun, type BrowserOutcomeConditionResult, type BrowserOutcomeEvaluation, type BrowserOutcomeHumanFact,
  type BrowserOutcomeRegistration, type BrowserRegisteredOutcomeCriterion } from '../shared/browser-outcome-criteria.js'
import { parseBrowserStructuredOutputDocument, parseBrowserStructuredOutputRequest } from './browser-structured-output.js'

export type BrowserOutcomeCurrent = {
  workspaceId: string | null; browserId: string; navigationId: string
  /** The actual selected execution and its journal operations, never a nearest/historical version. */
  assetRun: (BrowserOutcomeAssetRun & { operationIds: string[] }) | null
}
export interface BrowserOutcomeHost {
  current(): BrowserOutcomeCurrent | Promise<BrowserOutcomeCurrent>
  getOperation(operationId: string): Promise<BrowserOperation | null>
  getStepEvidence(operationId: string, sequence: number): Promise<BrowserStepEvidenceRead>
  readStepResult(operationId: string, sequence: number, options: BrowserResultReadOptions): Promise<BrowserResultArtifactChunk>
  /** Existing exact document/view owner proof. URL or CDP channel equality is insufficient. */
  isStructuredSourceCurrent(source: BrowserStructuredSource): Promise<boolean>
  getDownloads?(): Promise<BrowserDownloadReceipt[]>
  readDownload?(reference: BrowserDownloadReference, options: BrowserDownloadReadOptions): Promise<BrowserDownloadChunk>
  getHumanCheckpoint?(run: BrowserOutcomeAssetRun, checkpointId: string): Promise<BrowserOutcomeHumanFact | null>
}

function sameRun(a: BrowserOutcomeAssetRun, b: BrowserOutcomeAssetRun): boolean {
  return a.runId === b.runId && a.assetId === b.assetId && a.version === b.version
}
function sameArtifact(a: BrowserResultArtifactReference, b: BrowserResultArtifactReference): boolean {
  return a.kind === b.kind && a.id === b.id && a.workspaceId === b.workspaceId && a.browserId === b.browserId &&
    a.operationId === b.operationId && a.navigationId === b.navigationId && a.format === b.format &&
    a.byteLength === b.byteLength && a.capturedAt === b.capturedAt && a.maxReadBytes === b.maxReadBytes
}
function sameSource(a: BrowserStructuredSource, b: BrowserStructuredSource): boolean {
  return a.workspaceId === b.workspaceId && a.browserId === b.browserId && a.operationId === b.operationId &&
    a.navigationId === b.navigationId && a.document === b.document && a.documentUrl === b.documentUrl && a.url === b.url &&
    a.scope.kind === b.scope.kind && a.scope.within === b.scope.within && a.scope.withinRef === b.scope.withinRef
}
function sameDownload(a: BrowserDownloadReference, b: BrowserDownloadReference): boolean {
  return a.kind === b.kind && a.id === b.id && a.workspaceId === b.workspaceId && a.browserId === b.browserId &&
    a.operationId === b.operationId && a.navigationId === b.navigationId && a.url === b.url && a.path === b.path &&
    a.revision === b.revision && a.byteLength === b.byteLength && a.filename === b.filename && a.mime === b.mime && a.capturedAt === b.capturedAt
}
function conditionValue(condition: BrowserRegisteredOutcomeCriterion) {
  if (condition.kind === 'field-equals') return { kind: condition.kind, key: condition.key, expected: condition.expected }
  if (condition.kind === 'download-readable') return { kind: condition.kind, path: condition.path }
  return { kind: condition.kind, checkpointId: condition.checkpointId }
}
function result(condition: BrowserRegisteredOutcomeCriterion, status: BrowserOutcomeConditionResult['status'], reason: string): BrowserOutcomeConditionResult {
  return { criterion: conditionValue(condition), status, reason }
}
function ownsExecution(registration: BrowserOutcomeRegistration, current: BrowserOutcomeCurrent): boolean {
  return registration.context.workspaceId !== null && current.workspaceId === registration.context.workspaceId &&
    current.browserId === registration.context.browserId &&
    (registration.assetRun ? current.assetRun !== null && sameRun(registration.assetRun, current.assetRun) : current.assetRun === null)
}
async function operationFor(registration: BrowserOutcomeRegistration, condition: Exclude<BrowserRegisteredOutcomeCriterion, { kind: 'human-checkpoint' }>, host: BrowserOutcomeHost): Promise<BrowserOperation> {
  const current = await host.current()
  if (!ownsExecution(registration, current) || (registration.assetRun
    ? !current.assetRun!.operationIds.includes(condition.producer.operationId)
    : condition.producer.operationId !== registration.context.operationId ||
      condition.producer.navigationId !== registration.context.navigationId)) throw new Error('Unbound producer')
  const operation = await host.getOperation(condition.producer.operationId)
  if (!operation || operation.id !== condition.producer.operationId || operation.browserId !== registration.context.browserId) {
    throw new Error('Producer is unavailable')
  }
  return operation
}

async function fieldCondition(registration: BrowserOutcomeRegistration,
  condition: Extract<BrowserRegisteredOutcomeCriterion, { kind: 'field-equals' }>, host: BrowserOutcomeHost): Promise<BrowserOutcomeConditionResult> {
  const operation = await operationFor(registration, condition, host)
  const { operationId, sequence, navigationId } = condition.producer
  if (!Number.isSafeInteger(sequence) || sequence < 1 || (await host.current()).navigationId !== navigationId) throw new Error('Observation is not current')
  const step = operation.steps.find(item => item.sequence === sequence)
  if (step?.method !== 'extractStructured' || step.status !== 'completed') throw new Error('No completed extraction step')
  const evidence = await host.getStepEvidence(operationId, sequence)
  const items = evidence.items.filter(item => item.content.kind === 'structured-output')
  if (evidence.status !== 'available' || evidence.operationId !== operationId || evidence.sequence !== sequence || items.length !== 1) throw new Error('Extraction evidence is unavailable')
  const item = items[0]!
  const linked = step.evidence?.find(reference => reference.id === item.reference.id)
  if (!linked || linked.kind !== item.reference.kind || linked.capturedAt !== item.reference.capturedAt ||
      linked.byteLength !== item.reference.byteLength || linked.truncated !== item.reference.truncated ||
      linked.operationId !== operationId || linked.sequence !== sequence || linked.browserId !== registration.context.browserId ||
      linked.navigationId !== navigationId || item.reference.kind !== 'structured-output' || item.reference.operationId !== operationId ||
      item.reference.sequence !== sequence || item.reference.browserId !== registration.context.browserId ||
      item.reference.navigationId !== navigationId || item.content.kind !== 'structured-output') throw new Error('Unjoined evidence')
  const receipt = item.content.receipt
  const artifact = receipt.artifact
  if (receipt.kind !== 'browser-structured-output' || !['complete', 'partial'].includes(receipt.status) ||
      receipt.artifactStatus !== 'available' || !artifact || artifact.kind !== 'browser-result-artifact' || artifact.format !== 'json' ||
      artifact.operationId !== operationId || artifact.navigationId !== navigationId ||
      artifact.browserId !== registration.context.browserId || artifact.workspaceId !== registration.context.workspaceId ||
      receipt.source.operationId !== operationId || receipt.source.navigationId !== navigationId ||
      receipt.source.browserId !== registration.context.browserId || receipt.source.workspaceId !== registration.context.workspaceId ||
      !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1 || artifact.byteLength > BROWSER_OUTCOME_LIMITS.documentBytes) throw new Error('Untrusted extraction source')
  const requested = parseBrowserStructuredOutputRequest(condition.producer.request)
  const field = requested.fields.find(value => value.key === condition.key)
  if (!field || field.type !== typeof condition.expected) throw new Error('Condition does not match the declared field type')
  const parts: Buffer[] = []
  let offset = 0
  while (offset < artifact.byteLength) {
    const chunk = await host.readStepResult(operationId, sequence, { offset, maxBytes: BROWSER_RESULT_MAX_READ_BYTES })
    const bytes = Buffer.from(chunk.data, 'base64')
    const end = offset + bytes.length
    if (!sameArtifact(chunk.reference, artifact) || chunk.encoding !== 'base64' || chunk.offset !== offset ||
        chunk.totalBytes !== artifact.byteLength || chunk.returnedBytes !== bytes.length || bytes.length < 1 ||
        bytes.length > BROWSER_RESULT_MAX_READ_BYTES || end > artifact.byteLength || bytes.toString('base64') !== chunk.data ||
        chunk.nextOffset !== (end < artifact.byteLength ? end : null)) throw new Error('Incomplete result continuation')
    parts.push(bytes); offset = end
  }
  const document = parseBrowserStructuredOutputDocument(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))))
  if (JSON.stringify(document.request) !== JSON.stringify(requested) || !sameSource(document.source, receipt.source)) throw new Error('Document differs from the registered request or source')
  if (!(await host.isStructuredSourceCurrent(document.source)) || (await host.current()).navigationId !== navigationId) throw new Error('The original document changed')
  const observed = document.fields.find(value => value.key === condition.key)
  if (observed?.status === 'observed') return result(condition, observed.value === condition.expected ? 'passed' : 'not-met',
    observed.value === condition.expected ? 'The registered field equals the declared value.' : 'The registered field has a different value.')
  if (observed?.status === 'missing' || observed?.status === 'type-error') return result(condition, 'not-met', 'The complete observation did not contain the declared typed value.')
  return result(condition, 'unavailable', 'This field was ambiguous, incomplete or unavailable. Inspect its recorded extraction; no action was repeated.')
}

async function downloadCondition(registration: BrowserOutcomeRegistration,
  condition: Extract<BrowserRegisteredOutcomeCriterion, { kind: 'download-readable' }>, host: BrowserOutcomeHost): Promise<BrowserOutcomeConditionResult> {
  await operationFor(registration, condition, host)
  if (!host.getDownloads || !host.readDownload) throw new Error('Download verification is unavailable')
  const receipts = (await host.getDownloads()).filter(receipt => receipt.operationId === condition.producer.operationId &&
    receipt.navigationId === condition.producer.navigationId && receipt.browserId === registration.context.browserId &&
    receipt.workspaceId === registration.context.workspaceId && receipt.path === condition.path)
  if (receipts.length !== 1) throw new Error('No unique registered download')
  const receipt = receipts[0]!
  if (receipt.status !== 'completed') return result(condition, 'not-met', 'The registered download has not completed. No trigger was repeated.')
  const reference = receipt.reference
  if (!reference || reference.kind !== 'browser-download-file' || reference.id !== receipt.id ||
      reference.workspaceId !== receipt.workspaceId || reference.browserId !== receipt.browserId ||
      reference.operationId !== receipt.operationId || reference.navigationId !== receipt.navigationId || reference.path !== receipt.path ||
      !reference.revision || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0) throw new Error('Unjoined download reference')
  // The unique Workspace owner verifies the whole file revision; T009 needs only a bounded readable slice.
  const chunk = await host.readDownload(reference, { offset: 0, maxBytes: 1 })
  const bytes = Buffer.from(chunk.data, 'base64')
  if (!sameDownload(chunk.reference, reference) || chunk.encoding !== 'base64' || chunk.offset !== 0 ||
      chunk.revision !== reference.revision || chunk.totalBytes !== reference.byteLength ||
      chunk.returnedBytes !== Math.min(1, reference.byteLength) || bytes.length !== chunk.returnedBytes ||
      bytes.toString('base64') !== chunk.data || chunk.nextOffset !== (reference.byteLength > 1 ? 1 : null)) throw new Error('Download is not readable at its recorded revision')
  return result(condition, 'passed', 'The completed registered file is readable at its recorded revision.')
}

async function humanCondition(registration: BrowserOutcomeRegistration,
  condition: Extract<BrowserRegisteredOutcomeCriterion, { kind: 'human-checkpoint' }>, host: BrowserOutcomeHost): Promise<BrowserOutcomeConditionResult> {
  if (!registration.assetRun || !host.getHumanCheckpoint) throw new Error('Human checkpoint facts are unavailable')
  const fact = await host.getHumanCheckpoint(registration.assetRun, condition.checkpointId)
  if (!fact) return result(condition, 'not-met', 'This checkpoint has no recorded trusted Continue event.')
  if (fact.origin !== 'trusted-ui' || fact.controlBefore !== 'human' || !sameRun(registration.assetRun, fact) ||
      fact.browserId !== registration.context.browserId || fact.checkpointId !== condition.checkpointId ||
      !Number.isFinite(fact.confirmedAt) || fact.confirmedAt < 0) throw new Error('Unjoined human checkpoint')
  return result(condition, 'passed', 'The existing control owner recorded trusted Continue for this exact run and checkpoint.')
}

/** Read existing facts only. Never executes page actions or creates a second journal/store/runtime. */
export async function evaluateBrowserOutcomeCriteria(registration: BrowserOutcomeRegistration, host: BrowserOutcomeHost): Promise<BrowserOutcomeEvaluation> {
  const base = { context: registration.context, ...(registration.assetRun ? { assetRun: registration.assetRun } : {}) }
  try { parseBrowserOutcomeCriteriaRequest({ criteria: registration.criteria.map(conditionValue) }) }
  catch { return { ...base, status: 'unavailable', conditions: [], warning: 'Declare one to eight supported conditions within the byte budget. Existing work remains; verification did not run.' } }
  const conditions: BrowserOutcomeConditionResult[] = []
  for (const condition of registration.criteria) {
    try {
      if (!ownsExecution(registration, await host.current())) throw new Error('Execution identity changed')
      const outcome = condition.kind === 'field-equals' ? await fieldCondition(registration, condition, host)
        : condition.kind === 'download-readable' ? await downloadCondition(registration, condition, host)
        : await humanCondition(registration, condition, host)
      if (!ownsExecution(registration, await host.current())) throw new Error('Execution identity changed while reading')
      conditions.push(outcome)
    } catch {
      conditions.push(result(condition, 'unavailable', 'Verification could not confirm this execution and its recorded source. Existing work remains; inspect the evidence or restore access, then verify again. No action was repeated.'))
    }
  }
  const status = conditions.length === 0 || conditions.some(condition => condition.status === 'unavailable') ? 'unavailable'
    : conditions.every(condition => condition.status === 'passed') ? 'passed' : 'not-met'
  return { ...base, status, conditions }
}
