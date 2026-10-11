import { parseConversationLandmarkWrite, type ConversationItemRef, type ConversationLandmarkWrite } from '@agentmux/core/conversation'
/** Pending client input only. Core remains the sole point and acknowledged-operation owner. */
export type ConversationLandmarkIntents = Record<string, ConversationLandmarkWrite>
const originalRecordKey = (reference: ConversationItemRef): string => JSON.stringify(['record', reference.hostId, reference.agentSessionId, reference.source.kind, ...(reference.source.kind === 'native' ? [reference.source.providerId, reference.source.nativeSessionId] : []), reference.source.recordId])
export const conversationLandmarkRecordKey = (reference: ConversationItemRef, routeHostId?: string): string => routeHostId === undefined ? originalRecordKey(reference) : JSON.stringify(['route', routeHostId, originalRecordKey(reference)])
export function conversationLandmarkIntentKey(value: ConversationLandmarkWrite): string {
  const input = parseConversationLandmarkWrite(value)
  return input.change.kind === 'create' ? conversationLandmarkRecordKey(input.change.point.reference, input.change.point.routeHostId)
    : JSON.stringify(['point', input.hostId, input.agentSessionId, input.change.id])
}
