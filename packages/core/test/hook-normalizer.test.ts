import { describe, expect, it } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'

describe('native hook normalization', () => {
  const providers = new AgentProviderRegistry()

  it('maps Codex request_user_input to waiting with native provenance', () => {
    const event = providers.get('codex').normalizeHook({
      agentSessionId: 'semantic-1',
      runId: 'daemon-1',
      incarnationId: 'incarnation-1',
      agentId: 'codex',
      eventName: 'PreToolUse',
      payload: {
        tool_name: 'request_user_input',
        tool_input: { question: 'Ship it?' },
        session_id: 'codex-native-1'
      }
    })
    expect(event.status).toMatchObject({ state: 'waiting', source: 'native-hook' })
    expect(event.activities[0]).toMatchObject({ kind: 'permission', toolName: 'request_user_input' })
    expect(event.nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'codex',
      sessionId: 'codex-native-1'
    })
  })

  it('maps Pi ask_user_question to blocked', () => {
    const event = providers.get('pi').normalizeHook({
      agentSessionId: 'semantic-2',
      runId: 'daemon-2',
      incarnationId: 'incarnation-2',
      agentId: 'pi',
      eventName: 'tool_call',
      payload: {
        tool_name: 'ask_user_question',
        session_id: 'pi-native-1',
        session_file: '/tmp/pi-session.jsonl'
      }
    })
    expect(event.semanticState).toBe('blocked')
    expect(event.nativeHandle).toMatchObject({ transcriptPath: '/tmp/pi-session.jsonl' })
  })

  it('does not invent semantic work from an unknown event', () => {
    const event = providers.get('traex').normalizeHook({
      agentSessionId: 'semantic-3',
      runId: 'daemon-3',
      incarnationId: 'incarnation-3',
      agentId: 'traex',
      eventName: 'tick'
    })
    expect(event.semanticState).toBe('unknown')
    expect(event.status).toMatchObject({ state: 'running', source: 'native-hook' })
  })
})
