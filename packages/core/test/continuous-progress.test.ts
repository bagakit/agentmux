import { describe, expect, it } from 'vitest'
import { decideContinuousProgress } from '../src/continuous-progress.js'

const base = {
  agentSessionId: 's', hostId: 'local', providerId: 'codex' as const, workspacePath: '/w',
  run: { runId: 'r' }, semanticStatus: { state: 'done' as const, source: 'native-hook' as const, observedAt: 1000 },
  terminalPromptReadiness: { id: 'ready-1', source: 'native-stop' as const, run: { runId: 'r' }, outputCursorBytes: 1, readyThroughByte: 1 }
}

describe('decideContinuousProgress', () => {
  it('sends once for an unconsumed ready stop', () => {
    expect(decideContinuousProgress({ session: base, tickId: 't1', now: 2000 })).toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  })
  it('does not send while working or awaiting interaction, but missing readiness is not a gate', () => {
    expect(decideContinuousProgress({ session: { ...base, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1000 } }, tickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'working' })
    expect(decideContinuousProgress({ session: { ...base, pendingInteraction: {} as never }, tickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'interaction-pending' })
    const { readyThroughByte: _readyThroughByte, ...notReady } = base.terminalPromptReadiness
    expect(decideContinuousProgress({ session: { ...base }, tickId: 't1', now: 2000 })).toEqual({ kind: 'send', tickId: 't1', completionId: '["r",1000]' })
  })
  it('deduplicates tick/readiness and protects changed user input', () => {
    expect(decideContinuousProgress({ session: base, tickId: 't1', lastTickId: 't1', now: 2000 })).toEqual({ kind: 'skip', reason: 'duplicate-tick' })
    expect(decideContinuousProgress({ session: base, tickId: 't2', lastCompletionId: '["r",1000]', now: 2000 })).toEqual({ kind: 'skip', reason: 'completion-consumed' })
    expect(decideContinuousProgress({ session: base, tickId: 't2', userInputRevision: 2, submittedInputRevision: 1, now: 2000 })).toEqual({ kind: 'skip', reason: 'user-input-changed' })
  })
})
