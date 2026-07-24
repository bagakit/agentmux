import { describe, expect, it } from 'vitest'
import { normalizeNativeHook } from '../src/hook-normalizer.js'

describe('native hook normalization', () => {
  it('maps Codex request_user_input to waiting with native provenance', () => {
    const event = normalizeNativeHook({
      sessionId: 's1',
      agentId: 'codex',
      eventName: 'PreToolUse',
      payload: { tool_name: 'request_user_input', tool_input: { question: 'Ship it?' } }
    })
    expect(event.status).toMatchObject({ state: 'waiting', source: 'native-hook' })
    expect(event.activities[0]).toMatchObject({ kind: 'permission', toolName: 'request_user_input' })
  })

  it('maps Pi ask_user_question to blocked', () => {
    const event = normalizeNativeHook({
      sessionId: 's2',
      agentId: 'pi',
      eventName: 'tool_call',
      payload: { tool_name: 'ask_user_question' }
    })
    expect(event.semanticState).toBe('blocked')
  })

  it('does not invent semantic work from an unknown event', () => {
    const event = normalizeNativeHook({ sessionId: 's3', agentId: 'custom', eventName: 'tick' })
    expect(event.semanticState).toBe('unknown')
    expect(event.status).toMatchObject({ state: 'running', source: 'native-hook' })
  })
})
