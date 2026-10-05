import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'

/** Client action facts, independent of the host's UI and of Agent/Run health. */
export type AgentMuxMoteContextReference = {
  displayWorkspaceId: string; groupId: string; tabId: string; regionId: string
}
export type AgentMuxMoteContextScope = { hostId: string; directoryPath: string; topicId: string; tabId: string | null }
export type AgentMuxMoteContextEvidenceTarget = {
  domain: 'mote.context.client'
  /** The client reader route, not the resource Host below. */
  hostId: string
  scope: AgentMuxMoteContextScope
} & ({ action: 'prepare' } | { action: 'open-space'; reference: AgentMuxMoteContextReference | null })
export type AgentMuxMoteContextCapturedTarget = AgentMuxMoteContextScope & {
  workspaceId: string; reference: AgentMuxMoteContextReference | null
}
export type AgentMuxMoteContextEvidence = {
  kind: 'mote-context-client'
  operation: {
    target: AgentMuxMoteContextCapturedTarget
    action: 'prepare' | 'open-space'
    state: 'pending' | 'confirmed' | 'unconfirmed'
    startedAt: number
    settledAt: number | null
    failure: null | {
      step: 'ensure-mote' | 'read-discussion' | 'open-space'
      observedAt: number
      target: AgentMuxMoteContextCapturedTarget
    }
  }
  /** Only the actually retained cause string; never a reconstructed Error/stack. */
  original: { cause: string } | null
  coverage: 'latest-per-scope-action'
  omissions: Array<'raw-query-budget'>
}
export type AgentMuxMoteContextObservation = {
  schema: 'agentmux.mote-context-observation.v1'
  target: AgentMuxMoteContextEvidenceTarget
  data: AgentMuxMoteContextEvidence | null
  raw: { retention: 'retained' | 'not-retained' | 'unknown'; returned: 'included' | 'withheld' | 'unavailable'; truncated: null }
  issue: 'query-budget' | null
}

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength
const bad = (): never => { throw new AgentMuxError('Mote context observation does not satisfy its contract.', 'CONTROL_PROTOCOL_ERROR') }
const object = (v: unknown, fields: readonly string[]) => {
  const p = rpcRecord(v, fields, 'CONTROL_PROTOCOL_ERROR')
  if (fields.some(key => !Object.hasOwn(p, key))) bad()
  return p
}
const id = (v: unknown, nullable = false) => {
  if (nullable && v === null) return
  if (typeof v !== 'string' || !v.trim() || /[\0\r\n]/u.test(v) || new TextEncoder().encode(v).byteLength > 512) bad()
}
const time = (v: unknown, nullable = false) => {
  if (nullable && v === null) return
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) bad()
}
export function parseMoteContextReference(v: unknown): AgentMuxMoteContextReference | null {
  if (v === null) return null
  const p = object(v, ['displayWorkspaceId', 'groupId', 'tabId', 'regionId'])
  for (const key of Object.keys(p)) id(p[key])
  return p as AgentMuxMoteContextReference
}
function scope(v: unknown, captured = false) {
  const p = object(v, ['hostId', 'directoryPath', 'topicId', 'tabId', ...(captured ? ['workspaceId', 'reference'] : [])])
  for (const key of ['hostId', 'directoryPath', 'topicId']) id(p[key])
  id(p.tabId, true)
  if (captured) { id(p.workspaceId); parseMoteContextReference(p.reference) }
  return p
}
export function parseMoteContextEvidenceTarget(v: unknown): AgentMuxMoteContextEvidenceTarget {
  const r = rpcRecord(v, undefined, 'CONTROL_PROTOCOL_ERROR')
  const p = object(r, ['domain', 'hostId', 'scope', 'action', ...(r.action === 'open-space' ? ['reference'] : [])])
  if (p.domain !== 'mote.context.client' || (p.action !== 'prepare' && p.action !== 'open-space')) bad()
  id(p.hostId); scope(p.scope)
  if (p.action === 'open-space') parseMoteContextReference(p.reference)
  if (bytes(p) > 1024) bad()
  return p as AgentMuxMoteContextEvidenceTarget
}
export function moteContextReferenceMatches(a: AgentMuxMoteContextReference | null, b: AgentMuxMoteContextReference | null): boolean {
  return a === null || b === null ? a === b : a.displayWorkspaceId === b.displayWorkspaceId &&
    a.groupId === b.groupId && a.tabId === b.tabId && a.regionId === b.regionId
}
/** Validate read-back facts, not merely a map key supplied by a client. */
export function moteContextOperationMatches(query: AgentMuxMoteContextEvidenceTarget,
  operation: Pick<AgentMuxMoteContextEvidence['operation'], 'action' | 'target'>): boolean {
  const a = query.scope, b = operation.target
  return query.action === operation.action && a.hostId === b.hostId && a.directoryPath === b.directoryPath &&
    a.topicId === b.topicId && a.tabId === b.tabId &&
    (query.action !== 'open-space' || moteContextReferenceMatches(query.reference, b.reference))
}
export function parseMoteContextEvidence(v: unknown, query: AgentMuxMoteContextEvidenceTarget,
  includeRaw: boolean): AgentMuxMoteContextEvidence {
  const p = object(v, ['kind', 'operation', 'original', 'coverage', 'omissions'])
  if (p.kind !== 'mote-context-client' || p.coverage !== 'latest-per-scope-action') bad()
  const op = object(p.operation, ['target', 'action', 'state', 'startedAt', 'settledAt', 'failure'])
  scope(op.target, true); time(op.startedAt); time(op.settledAt, true)
  if (!['prepare', 'open-space'].includes(op.action as string) || !['pending', 'confirmed', 'unconfirmed'].includes(op.state as string)) bad()
  if (!moteContextOperationMatches(query, op as AgentMuxMoteContextEvidence['operation'])) bad()
  if (op.failure !== null) {
    const f = object(op.failure, ['step', 'observedAt', 'target'])
    time(f.observedAt); scope(f.target, true)
    if (!(op.action === 'prepare' ? ['ensure-mote', 'read-discussion'] : ['open-space']).includes(f.step as string)) bad()
    if (!moteContextOperationMatches(query, { action: op.action as 'prepare' | 'open-space', target: f.target as AgentMuxMoteContextCapturedTarget })) bad()
  }
  if (p.original !== null) {
    if (!includeRaw || op.failure === null) bad()
    const original = object(p.original, ['cause']); if (typeof original.cause !== 'string') bad()
  }
  if (!Array.isArray(p.omissions) || p.omissions.length > 1 || p.omissions.some(v => v !== 'raw-query-budget')) bad()
  return p as AgentMuxMoteContextEvidence
}
export function parseMoteContextObservation(v: unknown, query: AgentMuxMoteContextEvidenceTarget,
  includeRaw: boolean): AgentMuxMoteContextObservation {
  const p = object(v, ['schema', 'target', 'data', 'raw', 'issue'])
  if (p.schema !== 'agentmux.mote-context-observation.v1') bad()
  const target = parseMoteContextEvidenceTarget(p.target)
  const a = target.scope, b = query.scope
  if (target.hostId !== query.hostId || target.action !== query.action || a.hostId !== b.hostId ||
    a.directoryPath !== b.directoryPath || a.topicId !== b.topicId || a.tabId !== b.tabId ||
    (target.action === 'open-space' && query.action === 'open-space' && !moteContextReferenceMatches(target.reference, query.reference))) bad()
  if (p.data !== null) parseMoteContextEvidence(p.data, query, includeRaw)
  const raw = object(p.raw, ['retention', 'returned', 'truncated'])
  if (!['retained', 'not-retained', 'unknown'].includes(raw.retention as string) ||
    !['included', 'withheld', 'unavailable'].includes(raw.returned as string) || raw.truncated !== null) bad()
  const original = p.data === null ? null : (p.data as AgentMuxMoteContextEvidence).original
  if (raw.returned === 'included' ? !includeRaw || !original || raw.retention !== 'retained' : original !== null) bad()
  if (p.issue !== null && (p.issue !== 'query-budget' || p.data !== null || raw.returned === 'included')) bad()
  if (p.data === null && p.issue === null && (raw.retention !== 'unknown' || raw.returned !== 'unavailable')) bad()
  return p as AgentMuxMoteContextObservation
}
