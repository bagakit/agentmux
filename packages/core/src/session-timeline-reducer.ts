import { AgentMuxError } from './errors.js'
import type { AgentTimelineItem, AgentTimelineMutation } from './types.js'

export const MAX_TIMELINE_ITEMS_PER_WINDOW = 200

function sameItemSemantics(left: AgentTimelineItem, right: AgentTimelineItem): boolean {
  const { createdAt: _leftCreatedAt, updatedAt: _leftUpdatedAt, ...leftSemantics } = left
  const { createdAt: _rightCreatedAt, updatedAt: _rightUpdatedAt, ...rightSemantics } = right
  return JSON.stringify(leftSemantics) === JSON.stringify(rightSemantics)
}

// Inputs and activity share one ordered durable history, but cannot evict each other.
function retainTimelineWindows(items: AgentTimelineItem[]): AgentTimelineItem[] {
  let inputs = 0
  let activity = 0
  const retained: AgentTimelineItem[] = []
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    const count = item.kind === 'user_message' ? ++inputs : ++activity
    if (count <= MAX_TIMELINE_ITEMS_PER_WINDOW) retained.push(item)
  }
  return retained.reverse()
}

/** Internal: callers normalize the owned items and mutation before applying them. */
export function applyNormalizedTimelineMutation(
  items: AgentTimelineItem[],
  mutation: AgentTimelineMutation
): AgentTimelineItem[] {
  if (mutation.type === 'append') {
    const existing = items.find((item) => item.id === mutation.item.id)
    if (existing) {
      if (sameItemSemantics(existing, mutation.item)) return items
      throw new AgentMuxError('Timeline item identity conflicts with existing content.', 'AGENT_TIMELINE_ID_CONFLICT')
    }
    return retainTimelineWindows([...items, structuredClone(mutation.item)])
  }
  if (mutation.type === 'upsert') {
    const index = items.findIndex((item) => item.id === mutation.item.id)
    if (index < 0) {
      // A settled event whose earlier observation was evicted still supplies a complete item.
      return retainTimelineWindows([...items, structuredClone(mutation.item)])
    }
    const previous = items[index]!
    // Older Hook observations must not revert a completed item or fail the whole Hook.
    if (mutation.item.updatedAt < previous.updatedAt) return items
    const next: AgentTimelineItem = { ...structuredClone(mutation.item), createdAt: previous.createdAt }
    if (sameItemSemantics(previous, next)) return items
    const updated = [...items]
    updated[index] = next
    return retainTimelineWindows(updated)
  }
  const index = items.findIndex((item) => item.id === mutation.itemId)
  if (index < 0) {
    throw new AgentMuxError('Timeline update target is unavailable.', 'UNKNOWN_AGENT_TIMELINE_ITEM')
  }
  const previous = items[index]!
  if (mutation.updatedAt < previous.updatedAt) {
    throw new AgentMuxError('Timeline update is stale.', 'STALE_AGENT_TIMELINE_ITEM')
  }
  const next: AgentTimelineItem = {
    ...previous,
    updatedAt: mutation.updatedAt,
    ...(mutation.status === undefined ? {} : { status: mutation.status }),
    ...(mutation.title === undefined ? {} : { title: mutation.title }),
    ...(mutation.content === undefined ? {} : { content: mutation.content }),
    ...(mutation.toolName === undefined ? {} : { toolName: mutation.toolName }),
    ...(mutation.toolInput === undefined ? {} : { toolInput: mutation.toolInput }),
    ...(mutation.toolOutput === undefined ? {} : { toolOutput: mutation.toolOutput }),
    ...(mutation.eventName === undefined ? {} : { eventName: mutation.eventName })
  }
  if (sameItemSemantics(previous, next)) return items
  const updated = [...items]
  updated[index] = next
  return updated
}
