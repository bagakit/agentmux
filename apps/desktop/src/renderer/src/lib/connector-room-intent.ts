import type { ConnectionHostingTarget } from '../../../shared/contracts'
import { readConnectionHostingTarget } from '../../../shared/connection-hosting-target'
import { parseConnectionParams, parseRecordedRoomBindingInput, parseRoomBindingTarget, type ConnectionParamsMap, type RoomBindingRecordedBindInput, type RoomBindingRecordedRelinkInput, type RoomBindingTarget } from '@agentmux/core/connections'
import { restoredConnectorMemberDrafts, type ConnectorMemberDrafts } from './connector-member-draft'

type Effect = 'connection.room.create' | 'connection.room.link.create' | 'connection.bind' | 'connection.binding.relink' | 'connection.binding.pause' | 'connection.binding.resume' | 'connection.binding.detach' | 'connection.grant' | 'connection.binding.member.inherit'
/** Unsaved UI intent only. Restoring a member draft never grants or dispatches access. */
export type ConnectorRoomDraft = {
  connectionId: string; bindingId: string | null; bindingRevision: number | null
  mode: 'create' | 'existing' | 'details'; name: string; group: string; members: string; memberType: string
  scope: 'mentions-and-replies' | 'all-messages'
  actorId: string; actorType: string
  memberDrafts?: ConnectorMemberDrafts
}
export const connectorRoomDraftKey = (target: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>, hostingTarget?: ConnectionHostingTarget, channel?: string) => JSON.stringify([target.executionHostId, target.agentSessionId, ...(hostingTarget ? [hostingTarget.hostId, hostingTarget.runtimeId, ...(channel ? [channel] : [])] : [])])
export function restoredConnectorRoomDrafts(value: unknown): Record<string, ConnectorRoomDraft> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, ConnectorRoomDraft] => {
    try {
      const target = JSON.parse(entry[0]), draft = entry[1] as ConnectorRoomDraft
      return Array.isArray(target) && (target.length === 2 || target.length === 4 || target.length === 5) && target.every(id => typeof id === 'string' && !!id) &&
        !!draft && typeof draft === 'object' && ['connectionId', 'name', 'group', 'members', 'memberType', 'actorId', 'actorType'].every(key => typeof Reflect.get(draft, key) === 'string') &&
        (draft.bindingId === null || typeof draft.bindingId === 'string') && (draft.bindingRevision === null || Number.isSafeInteger(draft.bindingRevision) && draft.bindingRevision > 0) &&
        ['create', 'existing', 'details'].includes(draft.mode) && ['mentions-and-replies', 'all-messages'].includes(draft.scope)
    } catch { return false }
  }).map(([key, draft]) => [key, { connectionId: draft.connectionId, bindingId: draft.bindingId, bindingRevision: draft.bindingRevision,
    mode: draft.mode, name: draft.name, group: draft.group, members: draft.members, memberType: draft.memberType, scope: draft.scope, actorId: draft.actorId, actorType: draft.actorType,
    ...(draft.memberDrafts ? { memberDrafts: restoredConnectorMemberDrafts(draft.memberDrafts) } : {}) }]))
}
/** Submitted UI correlation only. Original effects and receipts remain with their Core/Host owners. */
export type ConnectorRoomIntent = { [M in Effect]: {
  target: RoomBindingTarget; hostingTarget?: ConnectionHostingTarget; method: M; input: M extends 'connection.bind' ? RoomBindingRecordedBindInput : M extends 'connection.binding.relink' ? RoomBindingRecordedRelinkInput : ConnectionParamsMap[M]; phase: 'not-dispatched' | 'may-have-dispatched'
} & (M extends 'connection.room.link.create' ? { replacesOperationId?: string } : {}) }[Effect]
const effects: readonly string[] = ['connection.room.create', 'connection.room.link.create', 'connection.bind', 'connection.binding.relink', 'connection.binding.pause', 'connection.binding.resume', 'connection.binding.detach', 'connection.grant', 'connection.binding.member.inherit']
export const sameConnectorTarget = (a: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>, b: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>) => a.executionHostId === b.executionHostId && a.agentSessionId === b.agentSessionId
const intentTargets = new WeakMap<Readonly<Record<string, ConnectorRoomIntent>>, ReadonlySet<string>>()
const targetKey = (target: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>) => JSON.stringify([target.executionHostId, target.agentSessionId])
/** One derived index per immutable intent projection, shared by visible original Session consumers. */
export function hasConnectorRoomIntent(intents: Readonly<Record<string, ConnectorRoomIntent>>, target: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>): boolean {
  let indexed = intentTargets.get(intents)
  if (!indexed) {
    indexed = new Set(Object.values(intents).map(intent => targetKey(intent.target)))
    intentTargets.set(intents, indexed)
  }
  return indexed.has(targetKey(target))
}
export function restoredConnectorRoomIntents(value: unknown): Record<string, ConnectorRoomIntent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, ConnectorRoomIntent> = {}
  for (const [key, raw] of Object.entries(value)) {
    try {
      const entry = raw as ConnectorRoomIntent
      if (!effects.includes(entry.method)) continue
      const input = entry.method === 'connection.bind' || entry.method === 'connection.binding.relink'
        ? parseRecordedRoomBindingInput(entry.method, entry.input) : parseConnectionParams(entry.method, entry.input)
      const target = parseRoomBindingTarget(entry.target)
      if (key !== input.operationId || 'executionHostId' in input && (!sameConnectorTarget(input, target) || input.regionAnchor?.regionId !== target.regionAnchor?.regionId)) continue
      let lineage: { replacesOperationId?: string } = {}
      if (entry.method === 'connection.room.link.create' && entry.replacesOperationId !== undefined) {
        try {
          const previous = parseConnectionParams('connection.room.link.inspect', { operationId: entry.replacesOperationId }).operationId
          if (previous !== input.operationId) lineage = { replacesOperationId: previous }
        } catch { /* Invalid presentation lineage never removes an otherwise exact original intent. */ }
      }
      const hostingTarget = readConnectionHostingTarget(entry.hostingTarget)
      // Missing old phase or owner never authorizes a first effect.
      result[key] = { method: entry.method, input, target, ...(hostingTarget ? { hostingTarget } : {}), phase: entry.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched', ...lineage } as ConnectorRoomIntent
    } catch { /* Keep original Host facts; invalid client correlation never dispatches. */ }
  }
  return result
}

/** This is a targeted UI invalidation, never a Binding fact or a permission grant. */
const changed = new EventTarget()
export function invalidateConnectorTarget(target: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>) { changed.dispatchEvent(new CustomEvent('changed', { detail: { executionHostId: target.executionHostId, agentSessionId: target.agentSessionId } })) }
export function observeConnectorTarget(target: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>, read: () => void) {
  const listener = (event: Event) => { if (sameConnectorTarget(target, (event as CustomEvent<RoomBindingTarget>).detail)) read() }
  changed.addEventListener('changed', listener)
  return () => changed.removeEventListener('changed', listener)
}
