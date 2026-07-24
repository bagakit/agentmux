import { describe, expect, it } from 'vitest'
import type { AgentActivity } from '../src/shared/contracts.js'
import {
  abbreviatedSessionId,
  latestSessionActivityAt,
  recentSessionMessage
} from '../src/renderer/src/lib/session-metadata.js'

function activity(overrides: Partial<AgentActivity>): AgentActivity {
  return {
    id: 'activity',
    sessionId: 'session',
    kind: 'assistant',
    source: 'native-hook',
    createdAt: 1,
    title: 'Assistant response',
    ...overrides
  }
}

describe('Session metadata projection', () => {
  it('shows an abbreviated stable id while retaining short ids', () => {
    expect(abbreviatedSessionId('9a27c67a-4b16-4f8c-b248-40c72ca83467')).toBe('9a27c67a')
    expect(abbreviatedSessionId('run-12')).toBe('run-12')
    expect(abbreviatedSessionId('session-codex')).toBe('session-codex')
  })

  it('uses the latest semantic message instead of a later tool event', () => {
    expect(recentSessionMessage([
      activity({ kind: 'prompt', createdAt: 2, content: '  Fix\n the lifecycle. ' }),
      activity({ kind: 'assistant', createdAt: 3, content: 'The owner now closes exactly once.' }),
      activity({ kind: 'tool', createdAt: 4, content: undefined, title: 'Edit' })
    ])).toBe('Agent: The owner now closes exactly once.')
  })

  it('reports no message when only non-message evidence exists', () => {
    expect(recentSessionMessage([
      activity({ kind: 'permission', content: undefined, title: 'Bash permission' })
    ])).toBeNull()
  })

  it('uses semantic activity as last activity without regressing runtime time', () => {
    expect(latestSessionActivityAt({ updatedAt: 10 }, [
      activity({ createdAt: 8 }),
      activity({ createdAt: 14 })
    ])).toBe(14)
    expect(latestSessionActivityAt({ updatedAt: 20 }, [activity({ createdAt: 14 })])).toBe(20)
  })
})
