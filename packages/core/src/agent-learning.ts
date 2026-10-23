import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'

/** Host business data. Core transports this contract; it does not own learning or knowledge. */
export type AgentLearningSource = { hostId: string; agentSessionId: string }
export type AgentLearningTarget = {
  kind: 'mote' | 'topic'; topicId: string; spaceId: string; zoneId: string
  expectedResource: { hostId: string; workspaceId: string; workspacePath: string }
}
export type AgentLearningWorker = {
  agentSessionId: string; createOperationId: string; executorId: string
  state: 'prepared' | 'unknown' | 'created' | 'retired' | 'not-applied'
  runId?: string; initialPrompt: 'not-requested' | 'confirmed' | 'unconfirmed' | 'unknown'
  context: 'confirmed' | 'unconfirmed' | 'unknown'
}
export type AgentLearningBinding = {
  operationId: string; ownerRuntimeId: string; source: AgentLearningSource
  candidateRevision: number; candidateDigest: string; target: AgentLearningTarget; executorId: string
}
export type AgentLearningOperation = {
  operationId: string; ownerRuntimeId: string; source: AgentLearningSource; revision: number
  proposer: AgentLearningWorker; candidate: { content: string; author: 'proposer' | 'editor' } | null
  approved: AgentLearningBinding | null; learner: AgentLearningWorker | null
  issues: Array<{ step: 'extraction' | 'learning'; code: string; message: string }>
  unavailable: Array<{ step: 'extraction' | 'learning'; code: string; message: string }>
}
export type AgentLearningConfirm = {
  hostId: string; operationId: string; expectedRevision: number; target: AgentLearningTarget
  ownerRuntimeId: string; candidateDigest: string; executorId: string; confirmationId: string
}
export type AgentLearningParamsMap = {
  'agent.learning.prepare': { operationId: string; source: AgentLearningSource; executorId: string }
  'agent.learning.ls': { hostId: string; agentSessionId?: string; cursor?: string; limit?: number }
  'agent.learning.inspect': { hostId: string; operationId: string }
  'agent.learning.propose': { hostId: string; operationId: string; expectedRevision: number; content: string }
  'agent.learning.revise': { hostId: string; operationId: string; expectedRevision: number; content: string }
  'agent.learning.continue': { hostId: string; operationId: string; step: 'extraction' | 'learning' }
  'agent.learning.confirm': AgentLearningConfirm
  /** Narrow live App adapter, not an Agent or ordinary transport approval capability. */
  'agent.learning.confirmation': { confirmationId: string; binding: AgentLearningBinding }
}
export type AgentLearningResultMap = {
  'agent.learning.prepare': { operation: AgentLearningOperation }
  'agent.learning.ls': { ownerRuntimeId: string; operations: AgentLearningOperation[]; nextCursor: string | null }
  'agent.learning.inspect': { operation: AgentLearningOperation | null }
  'agent.learning.propose': { operation: AgentLearningOperation }
  'agent.learning.revise': { operation: AgentLearningOperation }
  'agent.learning.continue': { operation: AgentLearningOperation }
  'agent.learning.confirm': { operation: AgentLearningOperation }
  'agent.learning.confirmation': { confirmationId: string; binding: AgentLearningBinding }
}
export type AgentLearningMethod = keyof AgentLearningParamsMap
export interface AgentLearningPort {
  call<M extends AgentLearningMethod>(method: M, input: AgentLearningParamsMap[M], context: AgentMuxRpcCallContext): Promise<AgentLearningResultMap[M]>
}
export const AGENT_LEARNING_METHODS = {
  'agent.learning.prepare': 'long', 'agent.learning.ls': 'short', 'agent.learning.inspect': 'short',
  'agent.learning.propose': 'short', 'agent.learning.revise': 'short', 'agent.learning.confirm': 'long',
  'agent.learning.continue': 'long',
  'agent.learning.confirmation': 'short'
} as const
export const isAgentLearningMethod = (value: unknown): value is AgentLearningMethod => typeof value === 'string' && Object.hasOwn(AGENT_LEARNING_METHODS, value)
type Code = 'INVALID_CONTROL_REQUEST' | 'CONTROL_PROTOCOL_ERROR'
const invalid = (code: Code): never => { throw new AgentMuxError('Learning requires the exact original operation, source, candidate revision and target.', code) }
const text = (value: unknown, code: Code): string => {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/u.test(value)) return invalid(code)
  return value
}
const count = (value: unknown, code: Code): number => Number.isSafeInteger(value) && Number(value) >= 1 ? value as number : invalid(code)
const body = (value: unknown, code: Code): string => typeof value === 'string' && value.length > 0 && !value.includes('\0') ? value : invalid(code)
function source(value: unknown, code: Code): AgentLearningSource {
  const p = rpcRecord(value, ['hostId', 'agentSessionId'], code)
  return { hostId: text(p.hostId, code), agentSessionId: text(p.agentSessionId, code) }
}
export function parseAgentLearningTarget(value: unknown, code: Code = 'INVALID_CONTROL_REQUEST'): AgentLearningTarget {
  const p = rpcRecord(value, ['kind', 'topicId', 'spaceId', 'zoneId', 'expectedResource'], code)
  if (p.kind !== 'mote' && p.kind !== 'topic') return invalid(code)
  const r = rpcRecord(p.expectedResource, ['hostId', 'workspaceId', 'workspacePath'], code)
  return { kind: p.kind, topicId: text(p.topicId, code), spaceId: text(p.spaceId, code), zoneId: text(p.zoneId, code),
    expectedResource: { hostId: text(r.hostId, code), workspaceId: text(r.workspaceId, code), workspacePath: body(r.workspacePath, code) } }
}
function binding(value: unknown, code: Code): AgentLearningBinding {
  const p = rpcRecord(value, ['operationId', 'ownerRuntimeId', 'source', 'candidateRevision', 'candidateDigest', 'target', 'executorId'], code)
  if (typeof p.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(p.candidateDigest)) return invalid(code)
  return { operationId: text(p.operationId, code), ownerRuntimeId: text(p.ownerRuntimeId, code), source: source(p.source, code),
    candidateRevision: count(p.candidateRevision, code), candidateDigest: p.candidateDigest, target: parseAgentLearningTarget(p.target, code), executorId: text(p.executorId, code) }
}
function worker(value: unknown, code: Code): AgentLearningWorker {
  const p = rpcRecord(value, ['agentSessionId', 'createOperationId', 'executorId', 'state', 'runId', 'initialPrompt', 'context'], code)
  if (typeof p.state !== 'string' || !['prepared', 'unknown', 'created', 'retired', 'not-applied'].includes(p.state) ||
    typeof p.initialPrompt !== 'string' || !['not-requested', 'confirmed', 'unconfirmed', 'unknown'].includes(p.initialPrompt) ||
    typeof p.context !== 'string' || !['confirmed', 'unconfirmed', 'unknown'].includes(p.context)) return invalid(code)
  return { agentSessionId: text(p.agentSessionId, code), createOperationId: text(p.createOperationId, code), executorId: text(p.executorId, code),
    state: p.state as AgentLearningWorker['state'], initialPrompt: p.initialPrompt as AgentLearningWorker['initialPrompt'],
    context: p.context as AgentLearningWorker['context'], ...(p.runId === undefined ? {} : { runId: text(p.runId, code) }) }
}
export function parseAgentLearningOperation(value: unknown): AgentLearningOperation {
  const code: Code = 'CONTROL_PROTOCOL_ERROR'
  const p = rpcRecord(value, ['operationId', 'ownerRuntimeId', 'source', 'revision', 'proposer', 'candidate', 'approved', 'learner', 'issues', 'unavailable'], code)
  let candidate: AgentLearningOperation['candidate'] = null
  if (p.candidate !== null) {
    const c = rpcRecord(p.candidate, ['content', 'author'], code)
    if (typeof c.content !== 'string' || !c.content.trim() || c.content.includes('\0') || c.author !== 'proposer' && c.author !== 'editor') return invalid(code)
    candidate = { content: c.content, author: c.author }
  }
  const issues = (value: unknown): AgentLearningOperation['issues'] => {
    if (!Array.isArray(value)) return invalid(code)
    return value.map(item => { const r = rpcRecord(item, ['step', 'code', 'message'], code)
      if (r.step !== 'extraction' && r.step !== 'learning') return invalid(code)
      if (typeof r.message !== 'string' || r.message.includes('\0')) return invalid(code)
      return { step: r.step, code: text(r.code, code), message: r.message } })
  }
  const result: AgentLearningOperation = { operationId: text(p.operationId, code), ownerRuntimeId: text(p.ownerRuntimeId, code), source: source(p.source, code), revision: count(p.revision, code),
    proposer: worker(p.proposer, code), candidate, approved: p.approved === null ? null : binding(p.approved, code), learner: p.learner === null ? null : worker(p.learner, code),
    issues: issues(p.issues), unavailable: issues(p.unavailable) }
  if (result.approved && (!candidate || result.approved.operationId !== result.operationId || result.approved.ownerRuntimeId !== result.ownerRuntimeId ||
    JSON.stringify(result.approved.source) !== JSON.stringify(result.source)) || result.learner && !result.approved) return invalid(code)
  return result
}
export function parseAgentLearningParams<M extends AgentLearningMethod>(method: M, value: unknown): AgentLearningParamsMap[M] {
  const code: Code = 'INVALID_CONTROL_REQUEST'
  const fields = method === 'agent.learning.prepare' ? ['operationId', 'source', 'executorId']
    : method === 'agent.learning.ls' ? ['hostId', 'agentSessionId', 'cursor', 'limit']
    : method === 'agent.learning.inspect' ? ['hostId', 'operationId']
    : method === 'agent.learning.continue' ? ['hostId', 'operationId', 'step']
    : method === 'agent.learning.confirm' ? ['hostId', 'operationId', 'expectedRevision', 'ownerRuntimeId', 'candidateDigest', 'target', 'executorId', 'confirmationId']
    : method === 'agent.learning.confirmation' ? ['confirmationId', 'binding'] : ['hostId', 'operationId', 'expectedRevision', 'content']
  const p = rpcRecord(value, fields, code), result: Record<string, unknown> = {}
  for (const key of fields) {
    if (method === 'agent.learning.ls' && key !== 'hostId' && p[key] === undefined) continue
    result[key] = key === 'source' ? source(p[key], code) : key === 'target' ? parseAgentLearningTarget(p[key], code)
      : key === 'binding' ? binding(p[key], code) : key === 'expectedRevision' || key === 'limit' ? count(p[key], code)
      : key === 'content' ? typeof p[key] === 'string' && (p[key] as string).trim() && !(p[key] as string).includes('\0') ? p[key] : invalid(code) : text(p[key], code)
  }
  if (method === 'agent.learning.ls' && Number(result.limit ?? 30) > 100) return invalid(code) // One bounded RPC page, not a durable capacity.
  if (method === 'agent.learning.confirm' && !/^[a-f0-9]{64}$/u.test(result.candidateDigest as string)) return invalid(code)
  if (method === 'agent.learning.continue' && result.step !== 'extraction' && result.step !== 'learning') return invalid(code)
  return result as AgentLearningParamsMap[M]
}
export function parseAgentLearningResult<M extends AgentLearningMethod>(method: M, value: unknown, input: AgentLearningParamsMap[M]): AgentLearningResultMap[M] {
  const code: Code = 'CONTROL_PROTOCOL_ERROR'
  if (method === 'agent.learning.confirmation') {
    const p = rpcRecord(value, ['confirmationId', 'binding'], code), actual = { confirmationId: text(p.confirmationId, code), binding: binding(p.binding, code) }
    if (JSON.stringify(actual) !== JSON.stringify(input)) return invalid(code)
    return actual as AgentLearningResultMap[M]
  }
  if (method === 'agent.learning.ls') {
    const p = rpcRecord(value, ['ownerRuntimeId', 'operations', 'nextCursor'], code)
    if (!Array.isArray(p.operations) || p.operations.length > ((input as AgentLearningParamsMap['agent.learning.ls']).limit ?? 30)) return invalid(code)
    const operations = p.operations.map(parseAgentLearningOperation)
    const query = input as AgentLearningParamsMap['agent.learning.ls']
    if (operations.some(operation => operation.ownerRuntimeId !== p.ownerRuntimeId || operation.source.hostId !== query.hostId ||
      query.agentSessionId !== undefined && operation.source.agentSessionId !== query.agentSessionId) ||
      new Set(operations.map(operation => operation.operationId)).size !== operations.length) return invalid(code)
    return { ownerRuntimeId: text(p.ownerRuntimeId, code), operations, nextCursor: p.nextCursor === null ? null : text(p.nextCursor, code) } as AgentLearningResultMap[M]
  }
  const p = rpcRecord(value, ['operation'], code), operation = p.operation === null && method === 'agent.learning.inspect' ? null : parseAgentLearningOperation(p.operation)
  if (operation && operation.operationId !== (input as { operationId: string }).operationId) return invalid(code)
  if (operation && method === 'agent.learning.prepare' && JSON.stringify(operation.source) !== JSON.stringify((input as AgentLearningParamsMap['agent.learning.prepare']).source)) return invalid(code)
  if (operation && method !== 'agent.learning.prepare' && operation.source.hostId !== (input as { hostId: string }).hostId) return invalid(code)
  if (operation && (method === 'agent.learning.propose' || method === 'agent.learning.revise')) {
    const original = input as AgentLearningParamsMap['agent.learning.propose']
    if (operation.revision !== original.expectedRevision + 1 || operation.candidate?.content !== original.content ||
      operation.candidate.author !== (method === 'agent.learning.propose' ? 'proposer' : 'editor')) return invalid(code)
  }
  if (operation && method === 'agent.learning.confirm') {
    const original = input as AgentLearningConfirm
    if (!operation.approved || operation.approved.ownerRuntimeId !== original.ownerRuntimeId || operation.approved.candidateDigest !== original.candidateDigest || operation.approved.candidateRevision !== original.expectedRevision || operation.approved.executorId !== original.executorId ||
      JSON.stringify(operation.approved.target) !== JSON.stringify(original.target)) return invalid(code)
  }
  return { operation } as AgentLearningResultMap[M]
}
