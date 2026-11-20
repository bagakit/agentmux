import { renderAmuxProtocol } from './amux-protocol.js'
import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { isObjectId } from './object-id.js'
import { parseSpaceAuthorityRef, spaceIdentityString, type SpaceAuthorityRef, type SpaceAuthoritySource } from './space-reference.js'

export type SpaceLinkAddress = { runtimeId: string; linkId: string }
export type SpaceLinkTarget = SpaceAuthorityRef & { eventId?: string }
export type SpaceLinkRecord = { target: SpaceLinkTarget; address: SpaceLinkAddress }
export const SPACE_LINK_RESOURCE = 'owned:space-object-links'
export const SPACE_LINK_METHODS = { 'space.link.ensure': 'long', 'space.link.resolve': 'short' } as const
export type SpaceLinkMethod = keyof typeof SPACE_LINK_METHODS
export type SpaceLinkParams = {
  'space.link.ensure': { target: SpaceLinkTarget; operationId: string }
  'space.link.resolve': { address: SpaceLinkAddress }
}
export type SpaceLinkResult = {
  'space.link.ensure': SpaceLinkRecord & { operationId: string; url: string; source: SpaceAuthoritySource; diskDurability: 'confirmed' }
  'space.link.resolve': { address: SpaceLinkAddress; target: SpaceLinkTarget | null; source: SpaceAuthoritySource }
}
export function parseSpaceLinkAddress(value: unknown, code = 'INVALID_CONTROL_REQUEST'): SpaceLinkAddress {
  const p = rpcRecord(value, ['runtimeId', 'linkId'], code)
  if (!isObjectId(p.linkId)) throw new AgentMuxError('Use the exact original public Space link ID.', code)
  return { runtimeId: spaceIdentityString(p.runtimeId, 'Original link Runtime', code), linkId: p.linkId }
}
export function parseSpaceLinkTarget(value: unknown, code = 'INVALID_CONTROL_REQUEST'): SpaceLinkTarget {
  const p = rpcRecord(value, ['runtimeId', 'spaceId', 'eventId'], code)
  const reference = parseSpaceAuthorityRef({ runtimeId: p.runtimeId, spaceId: p.spaceId }, code)
  return { ...reference, ...(p.eventId === undefined ? {} : { eventId: spaceIdentityString(p.eventId, 'Original Mote event', code) }) }
}
export function formatSpaceLink(address: SpaceLinkAddress): string {
  const p = parseSpaceLinkAddress(address)
  return renderAmuxProtocol('link', 'wire', { target: 'mote/' + p.linkId + '?runtime=' + encodeURIComponent(p.runtimeId) })
}
export function parseSpaceLinkParams<M extends SpaceLinkMethod>(method: M, value: unknown): SpaceLinkParams[M] {
  const p = rpcRecord(value, method === 'space.link.ensure' ? ['target', 'operationId'] : ['address'])
  return (method === 'space.link.ensure' ? { target: parseSpaceLinkTarget(p.target), operationId: spaceIdentityString(p.operationId, 'Original link publication') }
    : { address: parseSpaceLinkAddress(p.address) }) as SpaceLinkParams[M]
}
export function parseSpaceLinkResult<M extends SpaceLinkMethod>(method: M, value: unknown, input: SpaceLinkParams[M]): SpaceLinkResult[M] {
  const code = 'CONTROL_PROTOCOL_ERROR', ensure = method === 'space.link.ensure'
  const p = rpcRecord(value, ensure ? ['target','address','operationId','url','source','diskDurability'] : ['address','target','source'], code)
  const address = parseSpaceLinkAddress(p.address, code), source = rpcRecord(p.source, ['runtimeId','ownerInstanceId'], code)
  spaceIdentityString(source.ownerInstanceId, 'Original link owner', code)
  const expectedRuntime = ensure ? (input as SpaceLinkParams['space.link.ensure']).target.runtimeId : (input as SpaceLinkParams['space.link.resolve']).address.runtimeId
  if (source.runtimeId !== expectedRuntime || address.runtimeId !== expectedRuntime) throw new AgentMuxError('The link answer names another original Runtime.', code)
  const target = p.target === null && !ensure ? null : parseSpaceLinkTarget(p.target, code)
  if (target && target.runtimeId !== expectedRuntime) throw new AgentMuxError('The link target names another original Runtime.', code)
  if (ensure) {
    const expected = input as SpaceLinkParams['space.link.ensure']
    if (!target || target.spaceId !== expected.target.spaceId || target.eventId !== expected.target.eventId || p.operationId !== expected.operationId ||
      p.diskDurability !== 'confirmed' || p.url !== formatSpaceLink(address)) throw new AgentMuxError('The original link publication is unconfirmed or names another target.', code)
  } else if (address.linkId !== (input as SpaceLinkParams['space.link.resolve']).address.linkId) throw new AgentMuxError('Another public Space link was resolved.', code)
  return { ...p, address, target, source } as SpaceLinkResult[M]
}
/** Private spatial metadata; ordinary graph writers cannot publish or remap addresses. */
export function spaceLinkDocument(value: unknown): { records: Record<string, SpaceLinkTarget>; operations: Record<string, string> } {
  if (value === undefined) return { records: {}, operations: {} }
  const code = 'SPACE_LINK_STATE_UNCONFIRMED', p = rpcRecord(value, ['records','operations'], code)
  const records = rpcRecord(p.records, undefined, code), operations = rpcRecord(p.operations, undefined, code), targets = new Set<string>()
  for (const [id,target] of Object.entries(records)) {
    if (!isObjectId(id)) throw new AgentMuxError('The original link record is invalid; its bytes are kept.', code)
    const parsed = parseSpaceLinkTarget(target, code), key = JSON.stringify([parsed.runtimeId,parsed.spaceId,parsed.eventId ?? null])
    if (targets.has(key)) throw new AgentMuxError('Original public link bindings conflict; no target was guessed.', code)
    targets.add(key)
  }
  for (const [operation,id] of Object.entries(operations)) if (!operation || typeof id !== 'string' || !Object.hasOwn(records,id)) throw new AgentMuxError('The original link publication record is unconfirmed.', code)
  return p as { records: Record<string, SpaceLinkTarget>; operations: Record<string,string> }
}
