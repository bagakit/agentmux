import { describe, expect, it } from 'vitest'
import { agentInteractionActiveRequest, agentInteractionResponseSettled, agentInteractionResponseUnavailableReason } from '../src/agent-interaction-state.js'
import type { AgentMuxPendingInteraction } from '../src/types.js'

function pending(): AgentMuxPendingInteraction {
  return { request: { kind: 'permission', id: 'original-request', agentSessionId: 'original-session', title: 'Allow Bash?',
    nativeToolCallId: 'original-call', options: [{ id: 'allow-once', label: 'Allow once', kind: 'allow-once' }],
    evidence: { source: 'native-hook', observedAt: 1, run: { runId: 'original-run' } } },
    response: { value: { kind: 'permission', requestId: 'original-request', decision: { outcome: 'selected', optionId: 'allow-once' } },
      responseDigest: 'private-fixture-digest', operationId: 'original-response', inputByteRange: { startByte: 0, endByte: 1 }, acknowledged: false } }
}
const completion = { source: 'native-hook' as const, observedAt: 2, run: { runId: 'original-run' } }

describe('current native request and retained typed response are distinct facts', () => {
  it('keeps an incomplete original request after raw input ACK or typed ACK', () => {
    const p = pending()
    p.nativeInput = { operationId: 'raw-input', delivery: 'accepted', observedAt: 2 }
    expect(agentInteractionActiveRequest(p)).toBe(p.request)
    expect(agentInteractionResponseUnavailableReason(p)).toContain('Whether this request is still pending is unconfirmed')
    p.response!.acknowledged = true
    expect(agentInteractionActiveRequest(p)).toBe(p.request)
    expect(agentInteractionResponseUnavailableReason(p)).toContain('Waiting for the exact native request')
    expect(agentInteractionResponseSettled(p)).toBe(false)
  })
  it('closes only the native request while retaining an unacknowledged original tuple without mutation', () => {
    const p = pending(); p.nativeCompleted = completion
    const original = structuredClone(p)
    Object.freeze(p)
    expect(agentInteractionActiveRequest(p)).toBeUndefined()
    expect(agentInteractionResponseUnavailableReason(p)).toBe('The original native request has ended. Its earlier typed response has not been settled.')
    expect(agentInteractionResponseSettled(p)).toBe(false)
    expect(p).toEqual(original)
    expect(agentInteractionActiveRequest(undefined)).toBeUndefined()
  })
  it('keeps the first new unanswered request active while the completed old receipt remains owned', () => {
    const p = pending(); p.nativeCompleted = completion
    p.additionalRequests = [{ ...p.request, id: 'next-request', nativeToolCallId: 'next-call' }, { ...p.request, id: 'later-request', nativeToolCallId: 'later-call' }]
    expect(agentInteractionActiveRequest(p)).toBe(p.additionalRequests[0])
    expect(agentInteractionResponseUnavailableReason(p)).toBeTruthy()
    expect(p.request.id).toBe('original-request')
    expect(p.response?.operationId).toBe('original-response')
  })
  it('qualified completion takes priority over both unknown and accepted native input', () => {
    for (const delivery of ['unknown', 'accepted'] as const) {
      const p = pending(); p.nativeCompleted = completion; p.nativeInput = { operationId: 'original-native-input', delivery, observedAt: 2 }
      expect(agentInteractionActiveRequest(p)).toBeUndefined()
      expect(agentInteractionResponseUnavailableReason(p)).toContain('has ended')
      expect(agentInteractionResponseUnavailableReason(p)).not.toContain('Whether this request')
      p.response!.acknowledged = true
      expect(agentInteractionResponseSettled(p)).toBe(true)
      expect(agentInteractionResponseUnavailableReason(p)).toContain('acknowledged')
    }
  })
  it.each(['completion-source', 'request-source', 'wrong-run', 'missing-completion-run', 'missing-both-runs', 'missing-call'])(
    'never hides or settles the original request for malformed completion: %s', malformed => {
      const p = pending(); p.nativeCompleted = structuredClone(completion); p.response!.acknowledged = true
      if (malformed === 'completion-source') p.nativeCompleted.source = 'agentmux'
      if (malformed === 'request-source') p.request.evidence.source = 'agentmux'
      if (malformed === 'wrong-run') p.nativeCompleted.run = { runId: 'foreign-run' }
      if (malformed === 'missing-completion-run' || malformed === 'missing-both-runs') delete p.nativeCompleted.run
      if (malformed === 'missing-both-runs') delete p.request.evidence.run
      if (malformed === 'missing-call') delete p.request.nativeToolCallId
      expect(agentInteractionActiveRequest(p)).toBe(p.request)
      expect(agentInteractionResponseSettled(p)).toBe(false)
      expect(agentInteractionResponseUnavailableReason(p)).toContain('Waiting for the exact native request')
    }
  )
})
