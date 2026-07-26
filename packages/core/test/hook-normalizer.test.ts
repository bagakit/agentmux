import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { applyAgentTimelineMutation } from '../src/session-timeline.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('native hook normalization', () => {
  const providers = new AgentProviderRegistry()

  it('maps Codex request_user_input to waiting with native provenance', () => {
    const event = providers.get('codex').normalizeHook({
      receiptId: 'receipt-1',
      agentSessionId: 'semantic-1',
      runId: 'daemon-1',
      providerId: 'codex',
      eventName: 'PreToolUse',
      payload: {
        tool_name: 'request_user_input',
        tool_input: { question: 'Ship it?' },
        session_id: 'codex-native-1'
      }
    })
    expect(event.status).toMatchObject({ state: 'waiting', source: 'native-hook' })
    expect(event.timeline[0]).toMatchObject({
      type: 'append',
      item: { id: 'daemon-1:receipt-1:0', kind: 'permission', toolName: 'request_user_input' }
    })
    expect(event.nativeHandle).toEqual({
      kind: 'provider',
      providerId: 'codex',
      sessionId: 'codex-native-1'
    })
  })

  it('maps Pi ask_user_question to blocked', () => {
    const event = providers.get('pi').normalizeHook({
      receiptId: 'receipt-2',
      agentSessionId: 'semantic-2',
      runId: 'daemon-2',
      providerId: 'pi',
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

  it('does not promote unsafe ids or relative transcript paths to verified handles', () => {
    const codex = providers.get('codex').normalizeHook({
      receiptId: 'unsafe-id',
      agentSessionId: 'semantic-unsafe',
      runId: 'run-unsafe-id',
      providerId: 'codex',
      eventName: 'SessionStart',
      payload: { session_id: '-resume-me' }
    })
    expect(codex.nativeHandle).toBeUndefined()

    const pi = providers.get('pi').normalizeHook({
      receiptId: 'relative-path',
      agentSessionId: 'semantic-relative',
      runId: 'run-relative-path',
      providerId: 'pi',
      eventName: 'agent_start',
      payload: {
        session_id: 'pi-native-relative',
        session_file: 'sessions/current.jsonl'
      }
    })
    expect(pi.nativeHandle).toBeUndefined()
  })

  it('treats a Hook retry with only a later observation time as idempotent', () => {
    vi.useFakeTimers()
    const envelope = {
      receiptId: 'reused-receipt',
      agentSessionId: 'semantic-1',
      runId: 'run-1',
      providerId: 'codex' as const,
      eventName: 'Stop',
      payload: { last_assistant_message: 'Finished the task.' }
    }
    vi.setSystemTime(10)
    const first = providers.get('codex').normalizeHook(envelope)
    vi.setSystemTime(20)
    const retry = providers.get('codex').normalizeHook(envelope)
    const resumed = providers.get('codex').normalizeHook({ ...envelope, runId: 'run-2' })

    expect(first.timeline[0]).toMatchObject({ type: 'append', item: { id: 'run-1:reused-receipt:0' } })
    expect(retry.timeline[0]).toMatchObject({ type: 'append', item: { id: 'run-1:reused-receipt:0' } })
    expect(resumed.timeline[0]).toMatchObject({ type: 'append', item: { id: 'run-2:reused-receipt:0' } })
    expect(first.timeline[0]).not.toEqual(retry.timeline[0])

    const once = applyAgentTimelineMutation([], first.timeline[0]!)
    expect(applyAgentTimelineMutation(once, retry.timeline[0]!)).toEqual(once)
  })

  it('rejects a reused Hook identity with different semantic content', () => {
    vi.useFakeTimers()
    const envelope = {
      receiptId: 'conflicting-receipt',
      agentSessionId: 'semantic-1',
      runId: 'run-1',
      providerId: 'codex' as const,
      eventName: 'Stop',
      payload: { last_assistant_message: 'First result' }
    }
    const first = providers.get('codex').normalizeHook(envelope)
    const conflicting = providers.get('codex').normalizeHook({
      ...envelope,
      payload: { last_assistant_message: 'Different result' }
    })

    const once = applyAgentTimelineMutation([], first.timeline[0]!)
    expect(() => applyAgentTimelineMutation(once, conflicting.timeline[0]!))
      .toThrowError(expect.objectContaining({ code: 'AGENT_TIMELINE_ID_CONFLICT' }))
  })

  it('leaves user Prompt ownership to the Core launch and send paths', () => {
    const event = providers.get('codex').normalizeHook({
      receiptId: 'prompt-receipt',
      agentSessionId: 'semantic-1',
      runId: 'run-1',
      providerId: 'codex',
      eventName: 'UserPromptSubmit',
      payload: { prompt: 'Do not duplicate this Prompt.' }
    })

    expect(event.timeline.some(
      (mutation) => mutation.type === 'append' && mutation.item.kind === 'user_message'
    )).toBe(false)
  })

  it('does not invent semantic work from an unknown event', () => {
    const event = providers.get('traex').normalizeHook({
      receiptId: 'receipt-3',
      agentSessionId: 'semantic-3',
      runId: 'daemon-3',
      providerId: 'traex',
      eventName: 'tick'
    })
    expect(event.semanticState).toBe('unknown')
    expect(event.status).toMatchObject({ state: 'running', source: 'native-hook' })
  })
})
