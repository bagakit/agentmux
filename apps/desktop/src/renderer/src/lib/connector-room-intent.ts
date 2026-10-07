import { parseConnectionParams, parseRoomBindingTarget, type ConnectionParamsMap, type RoomBindingTarget } from '@agentmux/core/connections'

type Effect = 'connection.room.create' | 'connection.room.link.create' | 'connection.bind' | 'connection.binding.relink' | 'connection.binding.pause' | 'connection.grant'
/** Submitted UI correlation only. Original effects and receipts remain with their Core/Host owners. */
export type ConnectorRoomIntent = { [M in Effect]: {
  target: RoomBindingTarget; method: M; input: ConnectionParamsMap[M]; phase: 'not-dispatched' | 'may-have-dispatched'
} & (M extends 'connection.room.link.create' ? { replacesOperationId?: string } : {}) }[Effect]
const effects: readonly string[] = ['connection.room.create', 'connection.room.link.create', 'connection.bind', 'connection.binding.relink', 'connection.binding.pause', 'connection.grant']
export const sameConnectorTarget = (a: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>, b: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>) => a.executionHostId === b.executionHostId && a.agentSessionId === b.agentSessionId
export function restoredConnectorRoomIntents(value: unknown): Record<string, ConnectorRoomIntent> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, ConnectorRoomIntent> = {}
  for (const [key, raw] of Object.entries(value)) {
    try {
      const entry = raw as ConnectorRoomIntent
      if (!effects.includes(entry.method)) continue
      const input = parseConnectionParams(entry.method, entry.input), target = parseRoomBindingTarget(entry.target)
      if (key !== input.operationId || 'executionHostId' in input && (!sameConnectorTarget(input, target) || input.regionAnchor.regionId !== target.regionAnchor.regionId)) continue
      let lineage: { replacesOperationId?: string } = {}
      if (entry.method === 'connection.room.link.create' && entry.replacesOperationId !== undefined) {
        try {
          const previous = parseConnectionParams('connection.room.link.inspect', { operationId: entry.replacesOperationId }).operationId
          if (previous !== input.operationId) lineage = { replacesOperationId: previous }
        } catch { /* Invalid presentation lineage never removes an otherwise exact original intent. */ }
      }
      // Missing old phase never authorizes a first effect.
      result[key] = { method: entry.method, input, target, phase: entry.phase === 'not-dispatched' ? 'not-dispatched' : 'may-have-dispatched', ...lineage } as ConnectorRoomIntent
    } catch { /* Keep original Host facts; invalid client correlation never dispatches. */ }
  }
  return result
}

/** This is a targeted UI invalidation, never a Binding fact or a permission grant. */
const changed = new EventTarget()
export function invalidateConnectorTarget(target: RoomBindingTarget) { changed.dispatchEvent(new CustomEvent('changed', { detail: { executionHostId: target.executionHostId, agentSessionId: target.agentSessionId } })) }
export function observeConnectorTarget(target: Pick<RoomBindingTarget, 'executionHostId' | 'agentSessionId'>, read: () => void) {
  const listener = (event: Event) => { if (sameConnectorTarget(target, (event as CustomEvent<RoomBindingTarget>).detail)) read() }
  changed.addEventListener('changed', listener)
  return () => changed.removeEventListener('changed', listener)
}
