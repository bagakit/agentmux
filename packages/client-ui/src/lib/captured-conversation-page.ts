import type { AgentTimelineItem, AgentTimelineSnapshot, AgentSessionHistoryReadInput, AgentSessionHistoryReadPage } from '@agentmux/core'
import { consumeJsonReadEntry, parseAgentSessionHistoryReadPage, type JsonReadAssembly } from '@agentmux/core/conversation'
import { normalizeAgentTimelineItem } from '@agentmux/core/timeline'

export type CapturedConversationPage = {
  snapshot: AgentTimelineSnapshot
  nextCursor: string | null
  revision: string
}
/** Original source IO continuation only; roles/order/association belong to Core projection. */
export async function readCapturedConversationPage(
  read: (input: AgentSessionHistoryReadInput) => Promise<AgentSessionHistoryReadPage>,
  input: Omit<AgentSessionHistoryReadInput, 'source'>,
  active: () => boolean = () => true
): Promise<CapturedConversationPage> {
  let cursor = input.cursor, pending: JsonReadAssembly | undefined, revision: string | undefined
  let stream: AgentSessionHistoryReadPage['capturedStream']
  const items: AgentTimelineItem[] = []
  const cursors = new Set<string>()
  for (;;) {
    if (!active()) throw new Error('Original captured reading was cancelled; its cursor is retained.')
    const request = { ...input, source: 'captured' as const, ...(cursor ? { cursor } : {}) }
    const page = parseAgentSessionHistoryReadPage(await read(request), request)
    if (!active()) throw new Error('Original captured reading was cancelled; its cursor is retained.')
    if (revision !== undefined && (revision !== page.revision || stream?.epoch !== page.capturedStream?.epoch)) throw new Error('Captured source changed during one record; the original reading is retained.')
    revision = page.revision; stream = page.capturedStream
    const scopeKey = JSON.stringify([input.hostId, input.agentSessionId, page.sourceHostId, 'captured', stream?.epoch, revision])
    for (const entry of page.items) {
      const result = consumeJsonReadEntry({ scopeKey, entry, ...(pending ? { pending } : {}), maxTotalBytes: 12 * 1024 * 1024 })
      if (result.kind === 'pending') { pending = result.pending; continue }
      const item = normalizeAgentTimelineItem(result.value)
      if (item.agentSessionId !== input.agentSessionId || entry.kind === 'fragment' && entry.itemId !== item.id) throw new Error('Captured record belongs to another original source.')
      items.push(item); pending = undefined
    }
    if (!pending) return { snapshot: { ...(page.sourceHostId ? { sourceHostId: page.sourceHostId } : {}), agentSessionId: input.agentSessionId, revision: stream?.revision ?? 0, items: items.reverse(),
      ...(stream ? { stream: { ...stream, positions: [] } } : {}) }, nextCursor: page.nextCursor, revision: page.revision }
    if (!page.nextCursor || cursors.has(page.nextCursor)) throw new Error('Captured record fragments are incomplete; the original cursor is retained.')
    cursors.add(page.nextCursor); cursor = page.nextCursor
  }
}

/** Same original ID is a source update, never another utterance or a text/time join. */
export function retainCapturedItems(earlier: readonly AgentTimelineItem[], current: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  const latest = new Map(current.map(item => [item.id, item]))
  const known = new Set(earlier.map(item => item.id))
  return [...earlier.map(item => latest.get(item.id) ?? item), ...current.filter(item => !known.has(item.id))]
}

/** Reading-only admission in the original window owner, not a source/input capability. */
export function canReplaceCapturedWindow(viewport: HTMLElement | null, snapshot: AgentTimelineSnapshot, preserveAnchor: boolean): boolean {
  if (!viewport) return true
  const retained = new Set(snapshot.items.map(item => JSON.stringify([snapshot.agentSessionId, 'captured', item.id])))
  const selection = viewport.ownerDocument.defaultView?.getSelection(), range = selection && !selection.isCollapsed && selection.rangeCount ? selection.getRangeAt(0) : null
  const bounds = viewport.getBoundingClientRect()
  let anchorSeen = false
  for (const node of viewport.querySelectorAll<HTMLElement>('[data-message-source-key]')) {
    const key = node.dataset.messageSourceKey
    if (!key) continue
    let identity: unknown
    try { identity = JSON.parse(key) } catch { continue }
    if (!Array.isArray(identity) || identity[0] !== snapshot.agentSessionId) continue
    const rect = node.getBoundingClientRect(), visible = bounds.height > 0 && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
    const captured = identity[1] === 'captured'
    if (!anchorSeen && visible) {
      anchorSeen = true
      if (preserveAnchor && captured && !retained.has(key)) return false
    }
    if (captured && !retained.has(key) && range) {
      try { if (range.intersectsNode(node)) return false } catch { return false }
    }
  }
  return true
}
