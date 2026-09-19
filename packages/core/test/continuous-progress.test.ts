import { describe, expect, it } from 'vitest'
import { observeAgent } from '../src/agent-status-freshness.js'
import { decideContinuousProgress } from '../src/continuous-progress.js'

const base = {
  agentSessionId: 's', hostId: 'local', providerId: 'codex' as const, workspacePath: '/w',
  run: { runId: 'r' }, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: 1000 },
  terminalPromptReadiness: { id: 'ready-1', source: 'native-stop' as const, run: { runId: 'r' }, outputCursorBytes: 1, readyThroughByte: 1 }
}

function observation(session: { semanticStatus: Parameters<typeof observeAgent>[0]['status']; pendingInteraction?: unknown }, now: number) {
  return observeAgent({ process: 'running', status: session.semanticStatus,
    timelineCapability: 'complete-events', awaitingRequest: Boolean(session.pendingInteraction),
    terminalCapabilityUnverified: false }, now)
}

describe('decideContinuousProgress', () => {
  it('sends once for an unconsumed ready stop', () => {
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(base, 2000), session: base, tickId: 't1', now: 2000 })).toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  })
  it('does not send while working or awaiting interaction, but missing readiness is not a gate', () => {
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation({ ...base, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1000 } }, 2000), session: { ...base, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1000 } }, tickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'working' })
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation({ ...base, pendingInteraction: {} }, 2000), session: { ...base, pendingInteraction: {} as never }, tickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'interaction-pending' })
    const { readyThroughByte: _readyThroughByte, ...notReady } = base.terminalPromptReadiness
    const withoutScreenReadiness = { ...base, terminalPromptReadiness: notReady }
    expect(withoutScreenReadiness.terminalPromptReadiness).not.toHaveProperty('readyThroughByte')
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(withoutScreenReadiness, 2000), session: withoutScreenReadiness, tickId: 't1', now: 2000 })).toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  })
  it('deduplicates tick/readiness and protects changed user input', () => {
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(base, 2000), session: base, tickId: 't1', lastTickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'duplicate-tick' })
    expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(base, 2000), session: base, tickId: 't2', lastCompletionId: '["r",1000]', now: 2000 })).toEqual({ kind: 'skip', reason: 'completion-consumed' })
    expect(decideContinuousProgress({ inputByte: 0, observation: observation(base, 2000), session: base, tickId: 't2', inputOccupied: true, now: 2000 })).toEqual({ kind: 'skip', reason: 'user-input-changed' })
  })
})

it('does not reuse done while a manual admission is waiting for its native start event', () => {
  const session = { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: '/w', run: { runId: 'r' },
    semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: 1 },
    promptCompletionAdmission: { completionId: '["r",1]', operationId: 'manual-input', startByte: 0, endByte: 5 } }
  expect(decideContinuousProgress({ inputByte: 0, inputOccupied: false, observation: observation(session, 1), session, tickId: 't', now: 1 })).toEqual({ kind: 'skip', reason: 'completion-consumed' })
})
