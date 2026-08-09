import { describe, expect, it } from 'vitest'
import { decideContinuousProgress, type ContinuousProgressObservation } from '../src/continuous-progress.js'

const base = (overrides: Partial<ContinuousProgressObservation> = {}): ContinuousProgressObservation => ({
  session: { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: '/w', run: { runId: 'r' }, semanticStatus: { state: 'done', source: 'native-hook', observedAt: 100 }, terminalPromptReadiness: { source: 'native-stop', id: 'ready', run: { runId: 'r' }, readyThroughByte: 10, outputCursorBytes: 10 } },
  tickId: 'tick', now: 100, ...overrides
})

describe('continuous progress delivery boundary', () => {
  it('sends only when done and readiness belongs to current run', () => {
    expect(decideContinuousProgress(base())).toEqual({ kind: 'send', tickId: 'tick', readinessId: 'ready' })
    expect(decideContinuousProgress(base({ session: { ...base().session, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 100 } } }))).toEqual({ kind: 'skip', reason: 'working' })
    expect(decideContinuousProgress(base({ session: { ...base().session, pendingInteraction: { request: {} as never } } }))).toEqual({ kind: 'skip', reason: 'interaction-pending' })
  })
  it('deduplicates ticks and readiness', () => {
    expect(decideContinuousProgress(base({ lastTickId: 'tick' })).kind).toBe('skip')
    expect(decideContinuousProgress(base({ lastReadinessId: 'ready' })).kind).toBe('skip')
    expect(decideContinuousProgress(base({ session: { ...base().session, terminalPromptReadiness: { source: 'native-stop', id: 'ready', run: { runId: 'old' }, readyThroughByte: 10, outputCursorBytes: 10 } } })).kind).toBe('skip')
  })
})
