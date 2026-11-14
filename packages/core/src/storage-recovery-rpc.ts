import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { isAbsolute } from 'node:path'
import type { AgentMuxStorageRecovery, RecoveryGeneration, RecoveryGap, RecoveryStatus, RecoverySourceMember, RecoveryRestoreMember, RecoveryPreparation } from './storage-recovery.js'
import type { RestorePreflight, RestoreObservation } from './storage-restore.js'

export const STORAGE_RECOVERY_METHODS = {
  'storage.backup.create': 'long', 'storage.backup.list': 'long',
  'storage.backup.inspect': 'long', 'storage.recovery.status': 'short',
  'storage.source.capture': 'long', 'storage.source.release': 'long', 'storage.source.inspect': 'short',
  'storage.source.prepare': 'long', 'storage.source.restore': 'long',
  'storage.restore.preflight': 'long', 'storage.restore.apply': 'long', 'storage.restore.inspect': 'long', 'storage.backup.import': 'long'
} as const
export type StorageRecoveryMethod = keyof typeof STORAGE_RECOVERY_METHODS
export type StorageRecoveryParamsMap = {
  'storage.backup.create': Record<string, never>
  'storage.backup.list': Record<string, never>
  'storage.backup.inspect': { generationId: string }
  'storage.recovery.status': Record<string, never>
  'storage.source.capture': { captureId: string }
  'storage.source.release': { captureId: string }
  'storage.source.inspect': Record<string, never>
  'storage.source.prepare': { captureId: string; members: RecoveryRestoreMember[] }
  'storage.source.restore': { member: RecoveryRestoreMember }
  'storage.restore.preflight': RestorePreflight
  'storage.restore.apply': { operationId: string }
  'storage.restore.inspect': { operationId: string }
  'storage.backup.import': { sourcePath: string; sha256: string }
}
export type StorageRecoveryResultMap = {
  'storage.backup.create': { generation: RecoveryGeneration }
  'storage.backup.list': { generations: RecoveryGeneration[] }
  'storage.backup.inspect': { generation: RecoveryGeneration }
  'storage.recovery.status': { status: RecoveryStatus }
  'storage.source.capture': StorageRecoveryExport
  'storage.source.release': { released: boolean }
  'storage.source.inspect': { revision: string }
  'storage.source.prepare': { captureId: string; result: RecoveryPreparation }
  'storage.source.restore': { outcome: 'restored' | 'same' | 'conflict' }
  'storage.restore.preflight': { operation: RestoreObservation }
  'storage.restore.apply': { operation: RestoreObservation }
  'storage.restore.inspect': { operation: RestoreObservation }
  'storage.backup.import': { generation: RecoveryGeneration }
}
/** Borrow the original owner; no public path, source, manifest or signing material is accepted. */
export type StorageRecoveryPort = Pick<AgentMuxStorageRecovery, 'capture' | 'list' | 'inspect' | 'status' | 'restorePreflight' | 'restoreApply' | 'restoreInspect' | 'importSessionBackup'>
/** Private local source bridge only; these paths never enter public backup metadata. */
export type StorageRecoveryExport = { captureId: string; revision: string; members: RecoverySourceMember[]; gaps: RecoveryGap[] }
export type StorageRecoveryExportsPort = {
  inspect(): Promise<{ revision: string }>
  capture(captureId: string): Promise<StorageRecoveryExport>
  release(captureId: string): Promise<{ released: boolean }>
  prepare(captureId: string, members: RecoveryRestoreMember[]): Promise<{ captureId: string; result: RecoveryPreparation }>
  restore(member: RecoveryRestoreMember): Promise<'restored' | 'same' | 'conflict'>
}
export function isStorageRecoveryMethod(method: string): method is StorageRecoveryMethod { return Object.hasOwn(STORAGE_RECOVERY_METHODS, method) }
function invalid(): never { throw new AgentMuxError('The original storage recovery owner returned invalid facts.', 'CONTROL_PROTOCOL_ERROR') }
function identifier(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/u.test(value)) throw new AgentMuxError('An exact recovery generation ID is required.', code)
  return value
}
function string(value: unknown): string { if (typeof value !== 'string' || !value || value.includes('\0')) return invalid(); return value }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid(); return value as number }
export function parseStorageRecoveryParams<M extends StorageRecoveryMethod>(method: M, value: unknown): StorageRecoveryParamsMap[M] {
  if (method === 'storage.source.prepare') {
    const p = rpcRecord(value, ['captureId', 'members'])
    if (!Array.isArray(p.members)) throw new AgentMuxError('Select the exact frozen original source members.', 'INVALID_CONTROL_REQUEST')
    const members = p.members.map(value => restoreMember(value, 'INVALID_CONTROL_REQUEST'))
    if (new Set(members.map(member => member.id)).size !== members.length || new Set(members.map(member => member.operationId)).size > 1) throw new AgentMuxError('One original operation must name each source member once.', 'INVALID_CONTROL_REQUEST')
    return { captureId: identifier(p.captureId, 'INVALID_CONTROL_REQUEST'), members } as StorageRecoveryParamsMap[M]
  }
  if (method === 'storage.source.restore') {
    const p = rpcRecord(value, ['member'])
    return { member: restoreMember(p.member, 'INVALID_CONTROL_REQUEST') } as StorageRecoveryParamsMap[M]
  }

  if (method === 'storage.backup.import') {
    const p = rpcRecord(value, ['sourcePath', 'sha256'])
    if (typeof p.sourcePath !== 'string' || !isAbsolute(p.sourcePath) || p.sourcePath.includes('\0') || !/^[a-f0-9]{64}$/u.test(String(p.sha256))) throw new AgentMuxError('Select the exact original local SQLite file and SHA256.', 'INVALID_CONTROL_REQUEST')
    return { sourcePath: p.sourcePath, sha256: String(p.sha256) } as StorageRecoveryParamsMap[M]
  }
  if (method === 'storage.restore.apply' || method === 'storage.restore.inspect') {
    const p = rpcRecord(value, ['operationId']); return { operationId: identifier(p.operationId, 'INVALID_CONTROL_REQUEST') } as StorageRecoveryParamsMap[M]
  }
  if (method === 'storage.restore.preflight') {
    const p = rpcRecord(value, ['operationId', 'generationId', 'manifestHash', 'selectors', 'inputs'])
    if (typeof p.manifestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(p.manifestHash) || p.selectors !== undefined && !Array.isArray(p.selectors)) throw new AgentMuxError('An exact original manifest digest and selectors are required.', 'INVALID_CONTROL_REQUEST')
    return { operationId: identifier(p.operationId, 'INVALID_CONTROL_REQUEST'), generationId: identifier(p.generationId, 'INVALID_CONTROL_REQUEST'), manifestHash: p.manifestHash,
      ...(p.selectors === undefined ? {} : { selectors: (p.selectors as unknown[]).map(item => { const s = rpcRecord(item, ['sourceId', 'memberId']); return { sourceId: string(s.sourceId), memberId: string(s.memberId) } }) }),
      ...(p.inputs === undefined ? {} : { inputs: (() => { if (!Array.isArray(p.inputs)) throw new AgentMuxError('Original input selectors must be an array.', 'INVALID_CONTROL_REQUEST'); return p.inputs.map(item => { const s = rpcRecord(item, ['agentSessionId', 'runId', 'submissionId']); return { agentSessionId: string(s.agentSessionId), runId: string(s.runId), submissionId: string(s.submissionId) } }) })() }) } as StorageRecoveryParamsMap[M]
  }
  const source = method === 'storage.source.capture' || method === 'storage.source.release'
  const p = rpcRecord(value, method === 'storage.backup.inspect' ? ['generationId'] : source ? ['captureId'] : [])
  return (method === 'storage.backup.inspect' ? { generationId: identifier(p.generationId, 'INVALID_CONTROL_REQUEST') }
    : source ? { captureId: identifier(p.captureId, 'INVALID_CONTROL_REQUEST') } : {}) as StorageRecoveryParamsMap[M]
}
function sourceMember(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): RecoverySourceMember {
  const member = rpcRecord(value, ['id', 'file', 'target', 'kind', 'capturedAt', 'revision'], code)
  const text = (value: unknown): string => { if (typeof value !== 'string' || !value || value.includes('\0')) throw new AgentMuxError('The exact original source member is unconfirmed.', code); return value }
  const file = text(member.file), target = text(member.target)
  if (!isAbsolute(file) || !isAbsolute(target) || !['file', 'session-database'].includes(member.kind as string) || !Number.isSafeInteger(member.capturedAt) || Number(member.capturedAt) < 0) throw new AgentMuxError('The original source member requires exact local paths and kind.', code)
  return { id: text(member.id), file, target, kind: member.kind as RecoverySourceMember['kind'], capturedAt: member.capturedAt as number,
    ...(member.revision === undefined ? {} : { revision: text(member.revision) }) }
}
function restoreMember(value: unknown, code = 'CONTROL_PROTOCOL_ERROR'): RecoveryRestoreMember {
  const member = rpcRecord(value, ['id', 'file', 'target', 'kind', 'capturedAt', 'revision', 'sha256', 'operationId', 'originalSHA256'], code)
  if (typeof member.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(member.sha256)) throw new AgentMuxError('The exact original source digest is required.', code)
  if (member.originalSHA256 !== undefined && !/^[a-f0-9]{64}$/u.test(String(member.originalSHA256))) throw new AgentMuxError('The admitted original source digest is invalid.', code)
  const { sha256: _sha256, operationId: _operationId, originalSHA256, ...base } = member
  return { ...sourceMember(base, code), sha256: member.sha256, operationId: identifier(member.operationId, code), ...(originalSHA256 === undefined ? {} : { originalSHA256: String(originalSHA256) }) }
}
function preparation(value: unknown, original: RecoveryRestoreMember[]): RecoveryPreparation {
  const p = rpcRecord(value, ['state', 'members', 'metadata', 'selectors'], 'CONTROL_PROTOCOL_ERROR')
  if (p.state === 'unavailable') {
    if (p.members !== undefined || p.metadata !== undefined || !Array.isArray(p.selectors) || p.selectors.length === 0) return invalid()
    return { state: 'unavailable', selectors: p.selectors.map(value => {
      const s = rpcRecord(value, ['memberId', 'agentSessionId', 'reason'], 'CONTROL_PROTOCOL_ERROR')
      if (s.memberId !== undefined && !original.some(member => member.id === s.memberId)) return invalid()
      return { ...(s.memberId === undefined ? {} : { memberId: string(s.memberId) }), ...(s.agentSessionId === undefined ? {} : { agentSessionId: string(s.agentSessionId) }), reason: string(s.reason) }
    }) }
  }
  if (p.state !== 'prepared' || p.selectors !== undefined || !Array.isArray(p.members) || p.members.length !== original.length) return invalid()
  const members = p.members.map(value => restoreMember(value))
  if (new Set(members.map(member => member.id)).size !== members.length || members.some(member => {
    const before = original.find(value => value.id === member.id)
    return !before || member.target !== before.target || member.kind !== before.kind || member.operationId !== before.operationId || member.capturedAt !== before.capturedAt || member.originalSHA256 !== before.originalSHA256
  })) return invalid()
  let metadata: Record<string, string | number | boolean> | undefined
  if (p.metadata !== undefined) {
    if (!p.metadata || typeof p.metadata !== 'object' || Array.isArray(p.metadata) || Object.values(p.metadata).some(value => !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value))) return invalid()
    metadata = { ...p.metadata as Record<string, string | number | boolean> }
  }
  return { state: 'prepared', members, ...(metadata ? { metadata } : {}) }
}
function gap(value: unknown): RecoveryGap {
  const p = rpcRecord(value, ['sourceId', 'memberId', 'code'], 'CONTROL_PROTOCOL_ERROR')
  return { sourceId: string(p.sourceId), ...(p.memberId === undefined ? {} : { memberId: string(p.memberId) }), code: string(p.code) }
}
function generation(value: unknown): RecoveryGeneration {
  const p = rpcRecord(value, ['generationId', 'namespace', 'createdAt', 'memberCount', 'gaps', 'manifestHash', 'coverage', 'verification'], 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(p.gaps) || typeof p.manifestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(p.manifestHash)) return invalid()
  if (p.verification !== undefined && !['members', 'manifest-only'].includes(String(p.verification))) return invalid()
  return { generationId: identifier(p.generationId), namespace: string(p.namespace), createdAt: count(p.createdAt), memberCount: count(p.memberCount), ...(p.verification === undefined ? {} : { verification: p.verification as 'members' | 'manifest-only' }),
    gaps: p.gaps.map(gap), manifestHash: p.manifestHash, ...(p.coverage === undefined ? {} : { coverage: (() => {
      if (!Array.isArray(p.coverage)) return invalid()
      return p.coverage.map(value => { const m = rpcRecord(value, ['sourceId', 'memberId', 'kind'], 'CONTROL_PROTOCOL_ERROR')
        if (!['file', 'session-database'].includes(String(m.kind))) return invalid()
        return { sourceId: string(m.sourceId), memberId: string(m.memberId), kind: m.kind as RecoverySourceMember['kind'] }
      }) })() }) }
}
function status(value: unknown): RecoveryStatus {
  const p = rpcRecord(value, ['state', 'lastGeneration', 'pending', 'issue'], 'CONTROL_PROTOCOL_ERROR')
  if (!['idle', 'capturing', 'unavailable'].includes(p.state as string) || typeof p.pending !== 'boolean' || p.issue !== null && typeof p.issue !== 'string') return invalid()
  return { state: p.state as RecoveryStatus['state'], lastGeneration: p.lastGeneration === null ? null : generation(p.lastGeneration), pending: p.pending, issue: p.issue as string | null }
}
export function parseStorageRecoveryResult<M extends StorageRecoveryMethod>(method: M, value: unknown, params: StorageRecoveryParamsMap[M]): StorageRecoveryResultMap[M] {
  if (method === 'storage.source.prepare') {
    const p = rpcRecord(value, ['captureId', 'result'], 'CONTROL_PROTOCOL_ERROR'), input = params as StorageRecoveryParamsMap['storage.source.prepare']
    if (p.captureId !== input.captureId) return invalid()
    return { captureId: identifier(p.captureId), result: preparation(p.result, input.members) } as StorageRecoveryResultMap[M]
  }
  if (method === 'storage.source.restore') {
    const p = rpcRecord(value, ['outcome'], 'CONTROL_PROTOCOL_ERROR')
    if (!['restored', 'same', 'conflict'].includes(p.outcome as string)) return invalid()
    return { outcome: p.outcome } as StorageRecoveryResultMap[M]
  }

  if (method.startsWith('storage.restore.')) {
    const p = rpcRecord(value, ['operation'], 'CONTROL_PROTOCOL_ERROR'), o = rpcRecord(p.operation, ['operationId', 'generationId', 'manifestHash', 'state', 'items'], 'CONTROL_PROTOCOL_ERROR')
    if (o.operationId !== (params as { operationId: string }).operationId || !['prepared', 'applying', 'complete', 'unavailable', 'unknown'].includes(String(o.state)) || !Array.isArray(o.items) || !/^[a-f0-9]{64}$/u.test(String(o.manifestHash))) return invalid()
    const operation: RestoreObservation = { operationId: identifier(o.operationId), generationId: identifier(o.generationId), manifestHash: String(o.manifestHash), state: o.state as RestoreObservation['state'], items: o.items.map(value => {
      const i = rpcRecord(value, ['sourceId', 'memberId', 'state', 'code'], 'CONTROL_PROTOCOL_ERROR')
      if (!['missing', 'same', 'retained-current', 'unavailable', 'restored', 'unknown'].includes(String(i.state))) return invalid()
      return { sourceId: string(i.sourceId), memberId: string(i.memberId), state: i.state as RestoreObservation['items'][number]['state'], ...(i.code === undefined ? {} : { code: string(i.code) }) }
    }) }
    return { operation } as StorageRecoveryResultMap[M]
  }
  if (method === 'storage.source.inspect') {
    const p = rpcRecord(value, ['revision'], 'CONTROL_PROTOCOL_ERROR')
    return { revision: string(p.revision) } as StorageRecoveryResultMap[M]
  }
  if (method === 'storage.source.capture') {
    const p = rpcRecord(value, ['captureId', 'revision', 'members', 'gaps'], 'CONTROL_PROTOCOL_ERROR')
    if (p.captureId !== (params as StorageRecoveryParamsMap['storage.source.capture']).captureId || !Array.isArray(p.members) || !Array.isArray(p.gaps)) return invalid()
    const members = p.members.map(value => sourceMember(value))
    if (new Set(members.map(member => member.id)).size !== members.length) return invalid()
    return { captureId: identifier(p.captureId), revision: string(p.revision), members, gaps: p.gaps.map(gap) } as StorageRecoveryResultMap[M]
  }
  if (method === 'storage.source.release') {
    const p = rpcRecord(value, ['released'], 'CONTROL_PROTOCOL_ERROR')
    if (typeof p.released !== 'boolean') return invalid()
    return { released: p.released } as StorageRecoveryResultMap[M]
  }
  const p = rpcRecord(value, [method === 'storage.backup.list' ? 'generations' : method === 'storage.recovery.status' ? 'status' : 'generation'], 'CONTROL_PROTOCOL_ERROR')
  if (method === 'storage.recovery.status') return { status: status(p.status) } as StorageRecoveryResultMap[M]
  if (method === 'storage.backup.list') {
    if (!Array.isArray(p.generations)) return invalid()
    const generations = p.generations.map(generation)
    if (new Set(generations.map(value => value.generationId)).size !== generations.length) return invalid()
    return { generations } as StorageRecoveryResultMap[M]
  }
  const result = generation(p.generation)
  if (method === 'storage.backup.inspect' && result.generationId !== (params as StorageRecoveryParamsMap['storage.backup.inspect']).generationId) return invalid()
  return { generation: result } as StorageRecoveryResultMap[M]
}
