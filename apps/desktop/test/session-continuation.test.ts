import { describe, expect, it } from 'vitest'
import type { AgentTimelineItem } from '@agentmux/core'
import { projectSessionUserMessages } from '@agentmux/core/session-user-messages'
import { buildContinuationPrompt } from '../src/renderer/src/lib/session-continuation.js'

const m = (id: string, content: string): AgentTimelineItem => ({ id, content, source: 'native-hook', kind: 'assistant_message',
  status: 'complete', agentSessionId: 's', createdAt: 1, updatedAt: 1, title: '' })

describe('session continuation', () => {
  it('includes only selected transcript prefix', () => {
    const messages = [m('a', 'one'), m('b', 'two'), m('c', 'future')]
    expect(buildContinuationPrompt(messages, messages[1]!)).toBe('Continue this conversation from the selected point.\n\nAgent: one\n\nAgent: two')
  })
  it('rejects a cutoff outside the actual ordered stream', () => {
    expect(() => buildContinuationPrompt([m('a', 'one')], m('x', 'absent'))).toThrow('unavailable')
  })
  it('keeps a native input distinct from an opaque timeline ID collision and excludes later context', () => {
    const native = projectSessionUserMessages({ agentSessionId: 's', historyPage: { agentSessionId: 's',
      source: { providerId: 'claude', nativeSessionId: 'native' },
      items: [{ id: 'raw', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Native selected input' }] }], nextCursor: null } })
    expect(native).toHaveLength(1)
    const messages = [m(native[0]!.id, 'Earlier agent answer'), native[0]!, m('later', 'Do not leak future context')]
    expect(buildContinuationPrompt(messages, native[0]!)).toBe('Continue this conversation from the selected point.\n\nAgent: Earlier agent answer\n\nInput: Native selected input')
  })
})
