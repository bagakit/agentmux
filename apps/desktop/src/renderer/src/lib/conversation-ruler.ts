import type { AgentSessionHistoryItem, AgentSessionHistoryPage } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { speakerOfUserMessage, type ConversationSpeaker } from '@agentmux/client-ui/conversation-speaker'
import { speakerOf } from './conversation-speaker'
import { createRulerScale } from './activity-ruler'
import type { ConversationAxisItem, RulerAxisItem } from './conversation-axis'

export type RulerRecord = {
  id: string
  kind: 'ruler-record'
  recordedAt?: number
  speaker: ConversationSpeaker | null
  target: { kind: 'native'; source: string; recordId: string } | { kind: 'observed'; index: number }
  record: AgentSessionHistoryItem | Exclude<ConversationAxisItem, RulerRecord>
}
export const RULER_WINDOWS = { '6h': 6 * 3_600_000, '12h': 12 * 3_600_000, '24h': 24 * 3_600_000,
  '3d': 3 * 86_400_000, '7d': 7 * 86_400_000, all: Infinity }
export type RulerWindow = keyof typeof RULER_WINDOWS

/** References only. The committed reading surfaces keep their own source order and bodies. */
export function conversationRulerRecords(sessionId: string | undefined, page: AgentSessionHistoryPage | null | undefined,
  observed: readonly Exclude<ConversationAxisItem, RulerRecord>[]): RulerRecord[] {
  const native = page && page.agentSessionId === sessionId ? page : undefined
  const users = new Map(projectSessionUserMessages({ agentSessionId: sessionId ?? '', historyPage: native }).map(m => [m.rawId, m]))
  const seen = new Set<string>()
  const records: RulerRecord[] = []
  if (native) for (const record of native.items) {
    if (seen.has(record.id)) continue
    seen.add(record.id)
    const source = JSON.stringify([native.source.providerId, native.source.nativeSessionId])
    const user = users.get(record.id)
    records.push({ id: JSON.stringify(['native', sessionId, source, record.id]), kind: 'ruler-record', record,
      ...(record.startedAt === undefined ? {} : { recordedAt: record.startedAt }),
      speaker: user ? speakerOfUserMessage(user) : record.kind === 'assistant-message' ? { role: 'agent', id: sessionId! }
        : record.kind === 'system-message' ? { role: 'system', id: native.source.providerId } : null,
      target: { kind: 'native', source, recordId: record.id } })
  }
  observed.forEach((record, index) => {
    const at = 'createdAt' in record ? record.createdAt : record.recordedAt
    records.push({ id: JSON.stringify(['observed', sessionId, record.id]), kind: 'ruler-record', record,
      ...(at === undefined ? {} : { recordedAt: at }), speaker: speakerOf(record), target: { kind: 'observed', index } })
  })
  return records
}

export function conversationRulerWindow(records: readonly RulerRecord[], window: RulerWindow, visible?: ReadonlySet<string>) {
  const known = records.filter(r => r.recordedAt !== undefined && Number.isFinite(r.recordedAt))
  const untimed = records.filter(r => r.recordedAt === undefined || !Number.isFinite(r.recordedAt))
  const latest = known.reduce((last, r) => Math.max(last, r.recordedAt!), -Infinity)
  const firstVisible = known.reduce((first, record) => visible?.has(record.id) ? Math.min(first, record.recordedAt!) : first, Infinity)
  const end = Number.isFinite(firstVisible) ? Math.min(latest, firstVisible + RULER_WINDOWS[window]) : latest
  // All-unknown records remain navigable in source order, without a fabricated time domain.
  const items = known.length === 0 ? [...records] : known.filter(r => r.recordedAt! >= end - RULER_WINDOWS[window] && r.recordedAt! <= end)
    .sort((a, b) => a.recordedAt! - b.recordedAt!)
  const scale = createRulerScale(items.map(r => r.recordedAt), 1)
  const recentStart = latest - 3_600_000
  return { items, untimed: known.length ? untimed : [], scale,
    recentFraction: scale.axis === 'temporal' ? (recentStart - scale.origin) / scale.span
      : known.length === 0 ? null : items[0]!.recordedAt! < recentStart ? Infinity : 0 }
}

/** At most 48 displayed bins; count is recorded density, never execution time. */
export function conversationRulerDensity(items: readonly RulerAxisItem[], width: number) {
  const scale = createRulerScale(items.map(r => 'createdAt' in r ? r.createdAt : r.recordedAt), 1)
  if (scale.axis !== 'temporal' || width <= 0) return []
  const count = Math.max(1, Math.min(48, Math.floor(width / 10)))
  const bins = Array<number>(count).fill(0)
  for (let index = 0; index < items.length; index++) bins[Math.min(count - 1, Math.floor(scale.fractionOf(index) * count))]!++
  const max = Math.max(...bins)
  return bins.map((value, index) => ({ count: value, left: index / count, width: 1 / count, strength: Math.sqrt(value / max) }))
}

/** Called only for a requested excerpt, never while projecting the overview. */
export function rulerRecordQuote(item: RulerAxisItem): string | null {
  const record = 'kind' in item && item.kind === 'ruler-record' ? item.record : item
  if ('content' in record) return record.content?.trim().slice(0, 280) || null
  if ('contentParts' in record) {
    let quote = ''
    for (const part of record.contentParts) if (part.kind === 'text' || part.kind === 'reasoning') {
      quote += (quote ? '\n' : '') + part.text.slice(0, 280 - quote.length)
      if (quote.length >= 280) break
    }
    return quote.trim() || ('title' in record ? record.title ?? null : null)
  }
  return null
}
