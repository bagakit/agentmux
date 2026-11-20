import type { ConversationLandmarkPage, ConversationRef } from '@agentmux/core/conversation'

const key = (scope: ConversationRef) => JSON.stringify([scope.hostId, scope.agentSessionId])
type Observer = (page: ConversationLandmarkPage) => void
const readers = new Map<string, Set<Observer>>()

/** Only reading tools for this exact scope see confirmed metadata writes. */
export function observeLandmarkWrites(scope: ConversationRef, observe: Observer): () => void {
  const id = key(scope), listeners = readers.get(id) ?? new Set<Observer>()
  readers.set(id, listeners)
  listeners.add(observe)
  return () => {
    listeners.delete(observe)
    if (!listeners.size) readers.delete(id)
  }
}

export function publishLandmarkWrite(page: ConversationLandmarkPage): void {
  for (const observe of readers.get(key(page)) ?? []) observe(page)
}
