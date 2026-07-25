import { describe, expect, it } from 'vitest'
import { classifyPromptReadinessStatus } from '../src/client.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import { AgentMuxError } from '../src/errors.js'

function run(state: CtxmuxAdapterRun['state']): CtxmuxAdapterRun {
  return {
    runId: 'run-1',
    lifecycleOperationId: null,
    program: 'codex',
    args: [],
    workspacePath: '/tmp/work',
    pid: 1234,
    state,
    cols: 80,
    rows: 24,
    latestOutputBytes: 0,
    firstAvailableByte: 0,
    acceptedInputBytes: 0
  }
}

describe('prompt readiness status classification', () => {
  it('keeps waiting while the Run is still running (the receipt just has not landed yet)', () => {
    expect(classifyPromptReadinessStatus({ ok: true, run: run({ type: 'running' }) })).toEqual({ kind: 'retry' })
  })

  it('goes stale when the Run has exited — it can never become ready', () => {
    expect(classifyPromptReadinessStatus({ ok: true, run: run({ type: 'exited', code: 0, signal: null }) }))
      .toEqual({ kind: 'stale' })
    expect(classifyPromptReadinessStatus({ ok: true, run: run({ type: 'interrupted', reason: 'signal' }) }))
      .toEqual({ kind: 'stale' })
  })

  it('goes stale when ctxmux reports the Run is gone (CTXMUX_run_not_found)', () => {
    const error = new AgentMuxError('run not found', 'CTXMUX_run_not_found')
    expect(classifyPromptReadinessStatus({ ok: false, error })).toEqual({ kind: 'stale' })
  })

  it('surfaces an authoritative failure (e.g. ctxmux disconnect) instead of silently looping to the deadline', () => {
    const error = new AgentMuxError('AgentMux client is not connected.', 'CTXMUX_DISCONNECTED')
    expect(classifyPromptReadinessStatus({ ok: false, error })).toEqual({ kind: 'fail', error })
  })

  it('surfaces a non-AgentMux status failure verbatim as a fail (never swallowed as stale/retry)', () => {
    const error = new TypeError('boom')
    expect(classifyPromptReadinessStatus({ ok: false, error })).toEqual({ kind: 'fail', error })
  })
})
