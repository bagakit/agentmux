import { describe, expect, it } from 'vitest'
import type { AgentMuxTaskDecision } from '@agentmux/core/control'

describe('task decision receipts', () => {
  it('keeps routing evidence and confirmation as structured facts', () => {
    const decision: AgentMuxTaskDecision = {
      input: 'ship auth work', candidates: [{ projectId: 'repo', reason: 'matching workspace' }],
      selectedProjectId: 'repo', risk: 'low', confirmation: 'user', wikiVersion: 'v1', recordedAt: 1, sourceSessionId: 'session-1'
    }
    expect(decision.candidates[0]?.reason).toBe('matching workspace')
    expect(decision.confirmation).toBe('user')
  })
})
