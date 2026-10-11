import { describe, it, expect } from 'vitest'
import { sessionExitPresentation } from '../src/renderer/src/lib/session-recovery-banner'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


describe('confirmed original process exit', () => {
  it('presents the typed exit reason and code independently of a later identity refusal', () => {
    const session = { kind: 'agent' as const, processState: 'exited' as const, status: { state: 'error' as const,
      source: 'run-process' as const, observedAt: _historyFixtureEpoch(0, 0, 1), exitReason: 'crashed' as const, exitCode: 17,
      continuity: 'unavailable' as const, continuityReason: 'native-handle-unavailable' as const } }
    expect(sessionExitPresentation(session)).toEqual({ title: 'Agent process exited', detail: 'The process exited on its own. Exit code 17.' })
    expect(sessionExitPresentation({ ...session, status: { ...session.status, exitReason: 'user-stopped' } })?.detail).toContain('You stopped')
    expect(sessionExitPresentation({ ...session, status: { ...session.status, exitReason: 'unknown', exitCode: 0 } })?.detail).toContain('reason could not be determined')
    expect(sessionExitPresentation({ ...session, processState: 'running', status: { ...session.status, detail: 'arbitrary crash-looking terminal text' } })).toBeNull()
  })
})

