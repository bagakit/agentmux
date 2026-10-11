import { describe, expect, it } from 'vitest'
import { applyNormalizedTimelineMutation } from '../src/session-timeline-reducer.js'
import { applyAgentTimelineMutation, normalizeAgentTimeline } from '../src/session-timeline.js'
import type { AgentTimelineItem, AgentTimelineMutation } from '../src/types.js'

const ownerId = 'synthetic-timeline-cost-session'
const title = 'SYNTHETIC timeline validation sentinel'
const body = '  exact original output\n  '

function item(id: string, kind: AgentTimelineItem['kind'] = 'tool_call'): AgentTimelineItem {
  return {
    id, agentSessionId: ownerId, kind, status: 'streaming', source: 'native-hook',
    createdAt: 10, updatedAt: 10, title,
    ...(kind === 'user_message' ? { content: `  input ${id}\n  ` } : {
      toolName: 'shell', toolInput: 'SYNTHETIC', toolOutput: body
    })
  }
}

// Physical history, bounded IO, original handover and process restart are verified
// against the original SQLite owner in captured-history-durability.test.ts.
describe('Timeline mutation immutability and validation', () => {
  it('preserves prior reducer arrays, stale completion, timestamps and duplicate conflict semantics', () => {
    const initial = [item('target')]
    const original = structuredClone(initial)
    const changed = applyNormalizedTimelineMutation(initial, {
      type: 'upsert', agentSessionId: ownerId,
      item: { ...initial[0]!, createdAt: 15, updatedAt: 20, status: 'complete', toolOutput: '  done\n  ' }
    })
    expect(initial).toEqual(original)
    expect(changed).not.toBe(initial)
    expect(changed).toEqual([{ ...original[0]!, updatedAt: 20, status: 'complete', toolOutput: '  done\n  ' }])
    expect(applyNormalizedTimelineMutation(changed, {
      type: 'upsert', agentSessionId: ownerId, item: { ...changed[0]!, createdAt: 30, updatedAt: 30 }
    })).toBe(changed)
    expect(applyNormalizedTimelineMutation(changed, {
      type: 'upsert', agentSessionId: ownerId, item: { ...original[0]!, updatedAt: 15 }
    })).toBe(changed)
    expect(() => applyAgentTimelineMutation(changed, {
      type: 'append', agentSessionId: ownerId, item: { ...changed[0]!, title: 'conflicting identity' }
    })).toThrowError(expect.objectContaining({ code: 'AGENT_TIMELINE_ID_CONFLICT' }))
  })

  it('validates public input and every durable record, refusing middle corruption while retaining a torn final boundary', async () => {
    const entry = item('original')
    const append: AgentTimelineMutation = { type: 'append', agentSessionId: ownerId, item: entry }
    expect(() => applyAgentTimelineMutation([{ ...entry, kind: 'invalid' } as unknown as AgentTimelineItem], append))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
    expect(() => applyAgentTimelineMutation([{ ...entry, agentSessionId: 'another-session' }], append))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
    expect(() => normalizeAgentTimeline(ownerId, [{ ...entry, toolOutput: 'x'.repeat(128 * 1024) }]))
      .toThrowError(expect.objectContaining({ code: 'AGENT_TIMELINE_TOO_LARGE' }))
    expect(() => normalizeAgentTimeline(ownerId, [{ ...entry, agentSessionId: 'another-session' }]))
      .toThrowError(expect.objectContaining({ code: 'INVALID_AGENT_TIMELINE' }))
  })
})
