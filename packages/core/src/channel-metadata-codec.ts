import { AgentMuxError } from './errors.js'
import { rpcRecord } from './rpc-data.js'
import { parseConnectionActor, parseConnectionApplication } from './room-binding-codec.js'
import { channelActorKey, parseChannelActorProfileObservation } from './channel-profile.js'
import type { ConnectionApplication } from './connections-contract.js'
import type { ChannelConversationProfileObservation, ChannelMetadataEntry, ChannelMetadataMethod, ChannelMetadataParamsMap, ChannelMetadataResultMap, ChannelMetadataSubject } from './channel-metadata-contract.js'

export const CHANNEL_METADATA_RPC_METHODS = { 'connection.metadata.get': 'long', 'connection.metadata.ls': 'long', 'connection.metadata.refresh': 'long', 'connection.metadata.clear': 'long' } as const
export const isChannelMetadataMethod = (value: unknown): value is ChannelMetadataMethod => typeof value === 'string' && Object.hasOwn(CHANNEL_METADATA_RPC_METHODS, value)
const fail = (): never => { throw new AgentMuxError('Channel metadata does not describe the exact original subject.', 'INVALID_CHANNEL_METADATA') }
const object = (value: unknown, fields: string[]) => rpcRecord(value, fields, 'INVALID_CHANNEL_METADATA')
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) return fail(); return value }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max) return fail(); return Number(value) }
const application = parseConnectionApplication
export function channelMetadataSubjectKey(subject: ChannelMetadataSubject): string { return subject.kind === 'actor' ? 'actor:' + channelActorKey(subject.actor) : 'conversation:' + JSON.stringify(subject.externalConversationId) }
export function parseChannelMetadataSubject(value: unknown): ChannelMetadataSubject {
  const p = object(value, ['kind', 'actor', 'externalConversationId'])
  if (p.kind === 'actor' && p.externalConversationId === undefined) return { kind: 'actor', actor: parseConnectionActor(p.actor) }
  if (p.kind === 'conversation' && p.actor === undefined) return { kind: 'conversation', externalConversationId: text(p.externalConversationId) }
  return fail()
}
export function parseChannelConversationProfileObservation(value: unknown): ChannelConversationProfileObservation {
  const p = object(value, ['application', 'externalConversationId', 'state', 'profile', 'checkedAt', 'freshness', 'reason'])
  const app = application(p.application), externalConversationId = text(p.externalConversationId)
  const { actor: _actor, ...observation } = parseChannelActorProfileObservation({ actor: { application: app, idType: 'conversation', userId: externalConversationId }, state: p.state, profile: p.profile, checkedAt: p.checkedAt, freshness: p.freshness, ...(p.reason === undefined ? {} : { reason: p.reason }) })
  return { application: app, externalConversationId, ...observation }
}
export function parseChannelMetadataEntry(value: unknown, app: ConnectionApplication): ChannelMetadataEntry {
  const p = object(value, ['subject', 'observation', 'cacheRevision']), subject = parseChannelMetadataSubject(p.subject)
  const observation = subject.kind === 'actor' ? parseChannelActorProfileObservation(p.observation) : parseChannelConversationProfileObservation(p.observation)
  const observedApp = 'actor' in observation ? observation.actor.application : observation.application
  if (observedApp.domain !== app.domain || observedApp.appId !== app.appId) return fail()
  if (subject.kind === 'actor' ? !('actor' in observation) || channelActorKey(subject.actor) !== channelActorKey(observation.actor)
    : !('externalConversationId' in observation) || subject.externalConversationId !== observation.externalConversationId) return fail()
  return { subject, observation, cacheRevision: p.cacheRevision === null ? null : text(p.cacheRevision) }
}
export function parseChannelMetadataParams<M extends ChannelMetadataMethod>(method: M, value: unknown): ChannelMetadataParamsMap[M] {
  const list = method === 'connection.metadata.ls', clear = method === 'connection.metadata.clear', write = clear || method === 'connection.metadata.refresh'
  const p = object(value, ['connectionId', ...(write ? ['expectedConnectionRevision'] : []), ...(list ? ['kind', 'limit', 'cursor'] : ['subject']), ...(clear ? ['expectedCacheRevision'] : [])])
  const scope = { connectionId: text(p.connectionId), ...(write ? { expectedConnectionRevision: integer(p.expectedConnectionRevision) } : {}) }
  if (list) {
    if (!['actor', 'conversation'].includes(String(p.kind))) return fail()
    return { ...scope, kind: p.kind, ...(p.limit === undefined ? {} : { limit: integer(p.limit, 100) }), ...(p.cursor === undefined ? {} : { cursor: text(p.cursor) }) } as ChannelMetadataParamsMap[M]
  }
  return { ...scope, subject: parseChannelMetadataSubject(p.subject), ...(clear ? { expectedCacheRevision: p.expectedCacheRevision === null ? null : text(p.expectedCacheRevision) } : {}) } as ChannelMetadataParamsMap[M]
}
export function parseChannelMetadataResult<M extends ChannelMetadataMethod>(method: M, value: unknown, input: ChannelMetadataParamsMap[M]): ChannelMetadataResultMap[M] {
  const list = method === 'connection.metadata.ls', clear = method === 'connection.metadata.clear'
  const p = object(value, ['connectionId', 'connectionRevision', 'application', ...(list ? ['entries', 'next'] : ['entry']), ...(clear ? ['cleared'] : [])])
  const app = application(p.application), scope = { connectionId: text(p.connectionId), connectionRevision: integer(p.connectionRevision), application: app }
  if (scope.connectionId !== input.connectionId || 'expectedConnectionRevision' in input && scope.connectionRevision !== input.expectedConnectionRevision) return fail()
  if (list) {
    const original = input as ChannelMetadataParamsMap['connection.metadata.ls']
    if (!Array.isArray(p.entries) || p.entries.length > (original.limit ?? 30)) return fail()
    const entries = (p.entries as unknown[]).map(entry => parseChannelMetadataEntry(entry, app))
    if (entries.some(entry => entry.subject.kind !== original.kind) || new Set(entries.map(entry => channelMetadataSubjectKey(entry.subject))).size !== entries.length) return fail()
    return { ...scope, entries, next: p.next === null ? null : text(p.next) } as ChannelMetadataResultMap[M]
  }
  const entry = parseChannelMetadataEntry(p.entry, app), original = input as ChannelMetadataParamsMap['connection.metadata.get']
  if (channelMetadataSubjectKey(entry.subject) !== channelMetadataSubjectKey(original.subject) || clear && typeof p.cleared !== 'boolean') return fail()
  return { ...scope, entry, ...(clear ? { cleared: p.cleared } : {}) } as ChannelMetadataResultMap[M]
}
