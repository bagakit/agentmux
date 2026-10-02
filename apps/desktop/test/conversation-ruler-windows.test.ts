import { fixtureTime as _hygiene_fixtureTime } from "../scripts/lib/fixture-values.mjs"
import { describe, expect, it } from 'vitest'
import type { AgentSessionHistoryPage, AgentTimelineItem } from '@agentmux/core'
import { conversationRulerRecords, conversationRulerWindow, conversationRulerDensity, rulerRecordQuote } from '../src/renderer/src/lib/conversation-ruler'
import { conversationAxis } from '../src/renderer/src/lib/conversation-axis'
import { projectAgentActivityHistory, projectAgentWorkHistory } from '@agentmux/core/timeline'

const end = _hygiene_fixtureTime(32774400000)
const timeline = (id: string, at: number, extra: Partial<AgentTimelineItem> = {}): AgentTimelineItem => ({
  id, agentSessionId: 'self', kind: 'user_message', source: 'user', status: 'complete', createdAt: at,
  updatedAt: at, title: 'Record', content: 'Identical original body', ...extra
})
const page: AgentSessionHistoryPage = {
  agentSessionId: 'self', source: { providerId: 'codex', nativeSessionId: 'native-a' }, nextCursor: 'opaque',
  items: [
    { id: 'old', kind: 'assistant-message', startedAt: end - 2 * 86_400_000, contentParts: [{ kind: 'text', text: 'Old answer' }] },
    { id: 'same', kind: 'user-message', startedAt: end - 2_000_000, contentParts: [{ kind: 'text', text: 'Identical original body' }] },
    { id: 'process', kind: 'activity', startedAt: end - 1000, contentParts: [{ kind: 'reasoning', text: 'Recorded process' }] },
    { id: 'answer', kind: 'assistant-message', startedAt: end, contentParts: [{ kind: 'text', text: 'Latest answer' }] },
    { id: 'untimed', kind: 'user-message', contentParts: [{ kind: 'text', text: 'No recorded time' }] }
  ]
}
describe('loaded conversation ruler references', () => {
  it('keeps native and captured identical body / IDs separate, original objects and exact targets', () => {
    const observed = [timeline('same', end - 2_000_000)]
    const records = conversationRulerRecords('self', page, observed)
    expect(records).toHaveLength(6)
    expect(new Set(records.map(r => r.id)).size).toBe(6)
    expect(records[1]!.record).toBe(page.items[1])
    expect(records[5]!.record).toBe(observed[0])
    expect(records[1]!.target).toEqual({ kind: 'native', source: JSON.stringify(['codex', 'native-a']), recordId: 'same' })
    expect(records[5]!.target).toEqual({ kind: 'observed', index: 0 })
    expect(records[1]!.speaker?.role).toBe('unknown')
    expect(records[3]!.speaker).toEqual({ role: 'agent', id: 'self' })
    expect(records[2]!.speaker).toBeNull()
  })
  it('changes only the overview, not source order, body or references', () => {
    const records = conversationRulerRecords('self', page, [])
    const before = [...records]
    expect(conversationRulerWindow(records, '15m').items.map(r => r.target)).toEqual(records.slice(2, 4).map(r => r.target))
    expect(conversationRulerWindow(records, '1h').items.map(r => r.id)).toEqual(records.slice(1, 4).map(r => r.id))
    expect(conversationRulerWindow(records, '24h').items).toHaveLength(3)
    const all = conversationRulerWindow(records, 'all')
    expect(all.items).toHaveLength(4)
    expect(all.scale.origin).toBe(page.items[0]!.startedAt)
    expect(all.scale.origin + all.scale.span).toBe(end)
    expect(all.recentFraction).toBeCloseTo(1 - 3_600_000 / (2 * 86_400_000))
    expect(records).toEqual(before)
    expect(all.items[0]).toBe(records[0])
    expect(page.nextCursor).toBe('opaque')
  })
  it('keeps missing times separately reachable and never invents a clock', () => {
    const records = conversationRulerRecords('self', page, [])
    expect(conversationRulerWindow(records, '15m').untimed[0]).toBe(records[4])
    const onlyUnknown = records.filter(r => r.recordedAt === undefined)
    expect(conversationRulerWindow(onlyUnknown, '1h').items).toEqual(onlyUnknown)
    expect(conversationRulerWindow(onlyUnknown, '1h').scale.axis).toBe('ordinal')
    expect(conversationRulerDensity(onlyUnknown, 600)).toEqual([])
    expect(conversationRulerWindow([], '1h').items).toEqual([])
  })
  it('ignores another Session page, removes only repeated source IDs and retains reverse-time records', () => {
    expect(conversationRulerRecords('other', page, [])).toEqual([])
    const repeated = { ...page, items: [...page.items].reverse().concat(page.items[0]!) }
    const records = conversationRulerRecords('self', repeated, [])
    expect(records).toHaveLength(5)
    expect(records[0]!.record).toBe(page.items[4])
    expect(conversationRulerWindow(records, 'all').items.at(-1)?.record).toBe(page.items[3])
  })
  it('uses all loaded source records for a single author / time scale, not an observed-only axis', () => {
    const records = conversationRulerRecords('self', page, [timeline('visitor', end, { authorAgentSessionId: 'visitor' })])
    const window = conversationRulerWindow(records, '1h')
    const marks = conversationAxis(window.items, s => s.role === 'agent')
    expect(marks.map(m => m.speaker.id)).toEqual(['self', 'visitor'])
    expect(marks.map(m => m.index)).toEqual([2, 3])
    expect(marks[0]!.fraction).toBe(1)
  })
  it('bins actual records once, bounded by physical width, without treating count as execution', () => {
    const records = conversationRulerRecords('self', page, Array.from({ length: 1000 }, (_, i) => timeline('t'+i, end - i * 1000)))
    const window = conversationRulerWindow(records, 'all')
    const bins = conversationRulerDensity(window.items, 1000)
    expect(bins).toHaveLength(48)
    expect(bins.reduce((count, b) => count + b.count, 0)).toBe(window.items.length)
    expect(bins.every(b => b.strength >= 0 && b.strength <= 1)).toBe(true)
    expect(conversationRulerDensity(window.items, 100)).toHaveLength(10)
    expect(rulerRecordQuote(records[2]!)).toBe('Recorded process')
    expect(rulerRecordQuote(records[0]!)).toBe('Old answer')
  })
})
const activity = (id: string, at: number, state: 'working' | 'done' | 'waiting' | 'running' | 'error', previous?: string, run = 'run') => timeline(id, at, {
  kind: 'lifecycle', source: 'acp', activityState: { state, stateEnteredAt: at, run: { runId: run }, ...(previous ? { previousObservationId: previous } : {}) }
})
describe('Core-owned recorded activity', () => {
  it('distinguishes actual working, idle, input request and unknown, keeping the work-only contract', () => {
    const items = [activity('w', 1, 'working'), activity('d', 2, 'done', 'w'), activity('q', 3, 'waiting', 'd'), activity('r', 4, 'running', 'q')]
    const result = projectAgentActivityHistory(items)
    expect(result.segments.map(s => s.state)).toEqual(['working', 'idle', 'awaiting-input', 'unknown'])
    expect(result.segments.map(s => s.endAt)).toEqual([2, 3, 4, null])
    const work = projectAgentWorkHistory(items)
    expect(work.segments).toHaveLength(1)
    expect(work.segments[0]).toEqual({ run: { runId: 'run' }, startAt: 1, endAt: 2, end: 'state-change', startKnown: true })
  })
  it('keeps work coverage unchanged for a nonworking tail', () => {
    expect(projectAgentWorkHistory([activity('done', 2, 'done')]).coverage).toEqual({ recorded: true, truncated: false, gaps: false })
    expect(projectAgentWorkHistory([activity('work', 1, 'working'), activity('done', 2, 'done', 'work')]).coverage.gaps).toBe(false)
  })
  it('does not fabricate idle from a process or extend a missing successor / different Run / fork', () => {
    const d = activity('d', 1, 'done')
    expect(projectAgentActivityHistory([{ ...d, source: 'run-process' }]).segments[0]!.state).toBe('unknown')
    const fork = [d, activity('a', 2, 'working', 'd'), activity('b', 3, 'waiting', 'd')]
    expect(projectAgentActivityHistory(fork).segments[0]!.endAt).toBeNull()
    expect(projectAgentActivityHistory([d, activity('new', 3, 'working', 'd', 'other-run')]).segments[0]!.endAt).toBeNull()
    expect(projectAgentActivityHistory([d], { now: 999 }).segments[0]!.endAt).toBeNull()
  })
  it('retains error reason and gaps without relabeling them as a healthy idle conclusion', () => {
    const error = activity('error', 2, 'error', 'outside-window')
    const result = projectAgentActivityHistory([error, activity('next', 3, 'working', 'error')])
    expect(result.coverage.gaps).toBe(true)
    expect(result.segments[0]!.state).toBe('idle')
    expect(result.segments[0]!.detail).toBe('Identical original body')
    expect(result.segments[0]!.endAt).toBe(3)
  })
})
