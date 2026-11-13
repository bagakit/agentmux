import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterExitEvent, CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

// A Run's end is a fact with its own time. Every projection of an ended Run reports that time, so a
// consumer that keys on it (a notification, a status line) sees the same fact as the same fact, not a
// new one each time the Run is read. A Run that is still running has no transition time to report.

type Internals = {
  connected: boolean
  kernel: Record<string, unknown>
  acceptKernelEvent(event: CtxmuxAdapterExitEvent): void
  backfillEndedRuns(runs: readonly CtxmuxAdapterRun[]): void
}

function run(runId: string, state: CtxmuxAdapterRun['state']): CtxmuxAdapterRun {
  return { nativeService: null, runId, lifecycleOperationId: null, program: 'agent', args: [], workspacePath: '/workspace',
    pid: state.type === 'running' ? 7 : null, state, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 }
}

function client(runs: CtxmuxAdapterRun[]) {
  const value = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  const internals = value as unknown as Internals
  internals.connected = true
  internals.kernel.isConnected = () => true
  internals.kernel.list = async () => runs
  return { client: value, internals }
}

describe('an ended Run reports the time it ended on every projection', () => {
  for (const state of [{ type: 'interrupted', reason: 'daemon_restart' }, { type: 'exited', code: 0, signal: null }] as const) {
    it(`a live ${state.type} keeps the event's time`, async () => {
      const ended = run('ended', state), f = client([ended])
      f.internals.acceptKernelEvent({ type: 'exit', runId: 'ended', state, observedAt: 1_000 })
      const first = await f.client.listRuns(), second = await f.client.listRuns()
      expect(first[0]?.observedAt).toBe(1_000)
      expect(second[0]?.observedAt).toBe(1_000)
    })
  }

  it('an end first seen in a snapshot keeps that first sighting', async () => {
    const ended = run('found-ended', { type: 'interrupted', reason: 'daemon_restart' }), f = client([ended])
    const before = Date.now()
    f.internals.backfillEndedRuns([ended])
    const [first] = await f.client.listRuns()
    expect(first!.observedAt).toBeGreaterThanOrEqual(before)
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await f.client.listRuns())[0]?.observedAt).toBe(first!.observedAt)
  })

  it('a running Run reports each observation', async () => {
    const f = client([run('running', { type: 'running' })])
    const [first] = await f.client.listRuns()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect((await f.client.listRuns())[0]!.observedAt).toBeGreaterThan(first!.observedAt)
  })
})
