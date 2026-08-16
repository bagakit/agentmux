import { describe, expect, it } from 'vitest'
import { decideContinuousProgress, type ContinuousProgressObservation } from '../src/continuous-progress.js'

const base = (overrides: Partial<ContinuousProgressObservation> = {}): ContinuousProgressObservation => ({
  session: { agentSessionId: 'a', hostId: 'local', providerId: 'codex', workspacePath: '/w', run: { runId: 'r' }, semanticStatus: { state: 'done', source: 'native-hook', observedAt: 100 } },
  tickId: 'tick', now: 100, ...overrides
})

describe('continuous progress delivery boundary', () => {
  it('sends only when done and readiness belongs to current run', () => {
    expect(decideContinuousProgress(base())).toEqual({ kind: 'send', tickId: 'tick', completionId: '["r",100]' })
    expect(decideContinuousProgress(base({ session: { ...base().session, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 100 } } }))).toEqual({ kind: 'skip', reason: 'working' })
    expect(decideContinuousProgress(base({ session: { ...base().session, pendingInteraction: { request: {} as never } } }))).toEqual({ kind: 'skip', reason: 'interaction-pending' })
  })
  it('deduplicates ticks and readiness', () => {
    expect(decideContinuousProgress(base({ lastTickId: 'tick' })).kind).toBe('skip')
    expect(decideContinuousProgress(base({ lastCompletionId: '["r",100]' })).kind).toBe('skip')
    expect(decideContinuousProgress(base({ lastCompletionId: '["old",100]' })).kind).toBe('send')
  })
})
