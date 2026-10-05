/** Business input provenance owned by explicit Goal Start, separate from Run lifecycle. */
export type DemandDispatchIntent = {
  operationId: string
  agentSessionId: string
  hostId: string
  runId: string
  execution: 'finite' | 'continue'
  prompt: string
  loopId?: string
  alignmentRevision?: number
}
export type DemandDispatch = DemandDispatchIntent & {
  stage: 'prepared' | 'submitted' | 'confirmed' | 'unknown'
  preparedAt: number
  submittedAt?: number
  /** Reference to Core's durable original input fact; client success/activity is insufficient. */
  receipt?: { kind: 'core-prompt'; itemId: string; createdAt: number }
  issue?: string
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be a nonempty string`)
  return value
}
function time(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive timestamp`)
  return value
}
const intentKeys = ['operationId', 'agentSessionId', 'hostId', 'runId', 'execution', 'prompt', 'loopId', 'alignmentRevision']
export function parseDemandDispatchIntent(value: unknown): DemandDispatchIntent {
  const input = record(value, 'dispatch')
  if (Object.keys(input).some(key => !intentKeys.includes(key))) throw new Error('dispatch has unknown fields')
  if (input.execution !== 'finite' && input.execution !== 'continue') throw new Error('dispatch execution is invalid')
  if (input.execution === 'continue' && (input.loopId === undefined || input.alignmentRevision === undefined) || input.execution === 'finite' && (input.loopId !== undefined || input.alignmentRevision !== undefined)) throw new Error('dispatch continuation reference is inconsistent')
  if (input.alignmentRevision !== undefined && (typeof input.alignmentRevision !== 'number' || !Number.isSafeInteger(input.alignmentRevision) || input.alignmentRevision < 1)) throw new Error('dispatch alignment revision is invalid')
  return { operationId: text(input.operationId, 'dispatch.operationId'), agentSessionId: text(input.agentSessionId, 'dispatch.agentSessionId'),
    hostId: text(input.hostId, 'dispatch.hostId'), runId: text(input.runId, 'dispatch.runId'), execution: input.execution,
    prompt: text(input.prompt, 'dispatch.prompt'), ...(input.loopId === undefined ? {} : { loopId: text(input.loopId, 'dispatch.loopId') }),
    ...(input.alignmentRevision === undefined ? {} : { alignmentRevision: input.alignmentRevision as number }) }
}
export function parseDemandDispatch(value: unknown): DemandDispatch {
  const input = record(value, 'dispatch')
  if (Object.keys(input).some(key => ![...intentKeys, 'stage', 'preparedAt', 'submittedAt', 'receipt', 'issue'].includes(key))) throw new Error('dispatch has unknown fields')
  const intent = parseDemandDispatchIntent(Object.fromEntries(intentKeys.filter(key => input[key] !== undefined).map(key => [key, input[key]])))
  if (!['prepared', 'submitted', 'confirmed', 'unknown'].includes(String(input.stage))) throw new Error('dispatch stage is invalid')
  if ((input.stage === 'confirmed') !== (input.receipt !== undefined) || (input.stage !== 'prepared' && input.submittedAt === undefined)) throw new Error('dispatch stage lacks its original evidence')
  let receipt: DemandDispatch['receipt']
  if (input.receipt !== undefined) {
    const native = record(input.receipt, 'dispatch.receipt')
    if (Object.keys(native).some(key => !['kind', 'itemId', 'createdAt'].includes(key)) || native.kind !== 'core-prompt' || native.itemId !== `prompt:${intent.operationId}`) throw new Error('dispatch receipt belongs to another input')
    receipt = { kind: 'core-prompt', itemId: native.itemId, createdAt: time(native.createdAt, 'dispatch.receipt.createdAt') }
  }
  return { ...intent, stage: input.stage as DemandDispatch['stage'], preparedAt: time(input.preparedAt, 'dispatch.preparedAt'),
    ...(input.submittedAt === undefined ? {} : { submittedAt: time(input.submittedAt, 'dispatch.submittedAt') }),
    ...(receipt === undefined ? {} : { receipt }), ...(input.issue === undefined ? {} : { issue: text(input.issue, 'dispatch.issue') }) }
}
export function parseDemandDispatches(value: unknown): DemandDispatch[] {
  if (!Array.isArray(value)) throw new Error('dispatches must be an array')
  const dispatches = value.map(parseDemandDispatch)
  if (new Set(dispatches.map(item => item.operationId)).size !== dispatches.length) throw new Error('dispatches contain duplicate original operations')
  return dispatches
}
export function sameDemandDispatchIntent(left: DemandDispatchIntent, right: DemandDispatchIntent): boolean {
  return intentKeys.every(key => left[key as keyof DemandDispatchIntent] === right[key as keyof DemandDispatchIntent])
}
