import { AgentMuxError } from './errors.js'
import { rpcRecord, rpcString } from './rpc-data.js'
import { parseSpaceMemberIdentity } from './space-member.js'
import type { PinnedSpaceMemberIdentity } from './space-member.js'
import { parseNameChangeRecord, type AgentMuxDisplayLabelSource, type AgentMuxNameChangeRecord } from './display-label.js'

/** Source occurrence and local label ownership are distinct finite operations. */
export type SpaceMemberNameTarget = { target: PinnedSpaceMemberIdentity; object: 'agent' | 'tab' }
export type AgentNameTarget = { runtimeId: string; agentSessionId: string; createOperationId: string }
export type NameChange = { kind: 'rename'; operationId: string; name: string | null; expectedNameRevision: number; source: 'manual' | 'launch' | 'derived' }
  | { kind: 'confirm'; operationId: string }
export type NameObservation = {
  target: { runtimeId: string; kind: 'agent-session' | 'tab'; id: string }
  current: { override: string | null; source: AgentMuxDisplayLabelSource | null; nameRevision: number }
  record: AgentMuxNameChangeRecord | null
  /** Reading an applied record never manufactures the original durable-write ACK. */
  diskAcknowledgement: 'not-observed'
}
export type NameChangeResult = Omit<NameObservation, 'diskAcknowledgement'> & {
  record: AgentMuxNameChangeRecord; changed: boolean; applied: boolean
  save: { diskDurability: 'confirmed' | 'unconfirmed'; issue: string | null }
}
export const NAME_CONTROL_METHODS = {
  'space.member.name.inspect': 'short', 'space.member.name.change': 'long',
  'agent.name.inspect': 'short', 'agent.name.change': 'long',
} as const
export type NameControlMethod = keyof typeof NAME_CONTROL_METHODS
export type NameControlParams = {
  'space.member.name.inspect': SpaceMemberNameTarget & { operationId?: string }
  'space.member.name.change': SpaceMemberNameTarget & { change: NameChange }
  'agent.name.inspect': AgentNameTarget & { operationId?: string }
  'agent.name.change': AgentNameTarget & { change: NameChange }
}
export type NameControlResults = {
  'space.member.name.inspect': NameObservation; 'space.member.name.change': NameChangeResult
  'agent.name.inspect': NameObservation; 'agent.name.change': NameChangeResult
}
export function isNameControlMethod(method: string): method is NameControlMethod { return Object.hasOwn(NAME_CONTROL_METHODS, method) }
function invalid(message: string): never { throw new AgentMuxError(message, 'NAME_CHANGE_INVALID') }
export function parseNameChange(value: unknown): NameChange {
  const p = rpcRecord(value, ['kind', 'operationId', 'name', 'expectedNameRevision', 'source'])
  const operationId = rpcString(p.operationId, 'Original name operation')
  if (p.kind === 'confirm') {
    rpcRecord(value, ['kind', 'operationId'])
    return { kind: 'confirm', operationId }
  }
  if (p.kind !== 'rename' || !(p.name === null || typeof p.name === 'string') ||
    !Number.isSafeInteger(p.expectedNameRevision) || Number(p.expectedNameRevision) < 0 ||
    p.source !== 'manual' && p.source !== 'launch' && p.source !== 'derived') invalid('An exact name, revision and writer source are required.')
  return { kind: 'rename', operationId, name: p.name, expectedNameRevision: p.expectedNameRevision as number, source: p.source }
}
export function parseNameControlParams<M extends NameControlMethod>(method: M, value: unknown): NameControlParams[M] {
  const member = method.startsWith('space.member.'), change = method.endsWith('.change')
  const p = rpcRecord(value, [...(member ? ['target', 'object'] : ['runtimeId', 'agentSessionId', 'createOperationId']), change ? 'change' : 'operationId'])
  const action = change ? { change: parseNameChange(p.change) } : p.operationId === undefined ? {} : { operationId: rpcString(p.operationId, 'Original name operation') }
  if (member) {
    const target = parseSpaceMemberIdentity(p.target)
    if (!target.expectedAdmission || p.object !== 'agent' && p.object !== 'tab') invalid('Name operations require the original member C/L and exact Agent or Tab role.')
    return { target: { ...target, expectedAdmission: target.expectedAdmission }, object: p.object, ...action } as NameControlParams[M]
  }
  return { runtimeId: rpcString(p.runtimeId, 'Original label Runtime'), agentSessionId: rpcString(p.agentSessionId, 'Original local Agent Session'),
    createOperationId: rpcString(p.createOperationId, 'Original local Agent creation operation'), ...action } as NameControlParams[M]
}
export function parseNameControlResult<M extends NameControlMethod>(method: M, value: unknown, input: NameControlParams[M]): NameControlResults[M] {
  const change = method.endsWith('.change'), p = rpcRecord(value, ['target', 'current', 'record', ...(change ? ['changed', 'applied', 'save'] : ['diskAcknowledgement'])])
  const target = rpcRecord(p.target, ['runtimeId', 'kind', 'id']), current = rpcRecord(p.current, ['override', 'source', 'nameRevision'])
  const member = 'target' in input, runtimeId = member ? input.object === 'tab' ? input.target.reference.runtimeId : input.target.runtimeId : input.runtimeId
  const id = member ? input.object === 'agent' ? input.target.agentSessionId : undefined : input.agentSessionId
  if (target.runtimeId !== runtimeId || target.kind !== (member && input.object === 'tab' ? 'tab' : 'agent-session') || id !== undefined && target.id !== id ||
    !(current.override === null || typeof current.override === 'string') || !(current.source === null || ['manual', 'launch', 'derived', 'retained'].includes(String(current.source))) ||
    !Number.isSafeInteger(current.nameRevision) || Number(current.nameRevision) < 0) invalid('This name reply does not describe the original owner and target.')
  rpcString(target.id, 'Original name target')
  const record = p.record === null ? null : parseNameChangeRecord(p.record)
  const operationId = 'change' in input ? input.change.operationId : input.operationId
  if (record && (record.target.kind !== target.kind || record.target.id !== target.id || operationId !== undefined && record.id !== operationId)) invalid('This name record belongs to another original operation or target.')
  if (change) {
    const save = rpcRecord(p.save, ['diskDurability', 'issue'])
    if (!record || typeof p.changed !== 'boolean' || typeof p.applied !== 'boolean' ||
      save.diskDurability !== 'confirmed' && save.diskDurability !== 'unconfirmed' || !(save.issue === null || typeof save.issue === 'string')) invalid('The original name write receipt is unconfirmed.')
  } else if (p.diskAcknowledgement !== 'not-observed') invalid('A name read cannot acknowledge a previous write.')
  return structuredClone(p) as NameControlResults[M]
}
/** Only the Source schema owner derives this exact local handler input. */
export function memberAgentNameInput(input: NameControlParams['space.member.name.inspect'] | NameControlParams['space.member.name.change']):
  NameControlParams['agent.name.inspect'] | NameControlParams['agent.name.change'] {
  if (input.object !== 'agent' || input.target.expectedAdmission.kind !== 'creation') throw new AgentMuxError('An external association L is not the original local Agent creation C. Use its independent Coordinator witness.', 'SPACE_MEMBER_EXTERNAL_COORDINATOR')
  return { runtimeId: input.target.runtimeId, agentSessionId: input.target.agentSessionId, createOperationId: input.target.expectedAdmission.operationId,
    ...('change' in input ? { change: input.change } : input.operationId === undefined ? {} : { operationId: input.operationId }) }
}
