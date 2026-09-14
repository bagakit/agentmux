import { describe, expect, it } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { withCtxmuxStartupDiagnostic } from '../src/ctxmux-startup-diagnostic.js'

describe('ctxmux startup diagnostics', () => {
  it('keeps a concrete daemon stderr such as SQLITE_FULL beside the readiness failure', () => {
    const failure = new AgentMuxError(
      'The spawned CtxMux daemon did not publish its readiness receipt in time.',
      'CTXMUX_OWNER_IDENTITY_UNPROVEN'
    )

    const decorated = withCtxmuxStartupDiagnostic(failure, 'SQLITE_FULL: database or disk is full\n')

    expect(decorated).toBeInstanceOf(AgentMuxError)
    expect(decorated).toMatchObject({ code: 'CTXMUX_OWNER_IDENTITY_UNPROVEN' })
    expect((decorated as Error).message).toContain('SQLITE_FULL')
  })

  it('does not fabricate a diagnostic when the daemon emitted no stderr', () => {
    const failure = new AgentMuxError('readiness failed', 'CTXMUX_OWNER_IDENTITY_UNPROVEN')
    expect(withCtxmuxStartupDiagnostic(failure, '  ')).toBe(failure)
  })
})
