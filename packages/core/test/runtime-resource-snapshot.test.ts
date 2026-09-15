import { describe, expect, it, vi } from 'vitest'
import type { RunPage, RunSummary } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'

function summary(id: string, state: RunSummary['state'], retained: number, attachments = 0): RunSummary {
  return {
    id,
    backend: 'native',
    pid: state.type === 'running' ? 42 : null,
    state,
    latest_output_bytes: 90_000_000,
    retained_output_bytes: retained,
    attachments
  }
}

function connectFixture(adapter: CtxmuxRunAdapter, listPage: (cursor: string | null) => Promise<RunPage>) {
  const status = vi.fn(async () => { throw new Error('Resource observation must not hydrate status') })
  const list = vi.fn(async () => { throw new Error('Resource observation must consume bounded pages') })
  ;(adapter as unknown as { client: unknown }).client = { listPage, status, list }
  return { status, list }
}

describe('public Runtime resource inventory', () => {
  it('walks nonempty pages, counts terminal attachments, and reads retained bytes rather than lifetime output', async () => {
    const adapter = new CtxmuxRunAdapter()
    const live = summary('live', { type: 'running' }, 100, 2)
    const exited = summary('exited', { type: 'exited', code: 0, signal: null }, 200)
    const interrupted = summary('interrupted', { type: 'interrupted', reason: 'daemon_restart' }, 300, 1)
    const listPage = vi.fn(async (cursor: string | null): Promise<RunPage> => cursor === null
      ? { runs: [live, exited], nextCursor: 'exited' }
      : { runs: [interrupted], nextCursor: null })
    const { status, list } = connectFixture(adapter, listPage)
    const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    Object.assign(client, { kernel: adapter, connected: true })
    try {
      const first = await client.runtimeResourceSnapshot()
      expect(first).toEqual({
        observedAt: expect.any(Number), runCount: 3, runningRuns: 1, terminatedRuns: 2,
        terminatedUnattachedRuns: 1, attachments: 3, retainedOutputBytes: 600
      })
      expect(first.observedAt).toBeGreaterThan(0)
      expect(listPage.mock.calls).toEqual([[null], ['exited']])
      expect(status).not.toHaveBeenCalled()
      expect(list).not.toHaveBeenCalled()

      // Lifetime output is unchanged while the owner trims its retained payload.
      exited.retained_output_bytes = 20
      await expect(client.runtimeResourceSnapshot()).resolves.toMatchObject({ retainedOutputBytes: 420 })
      expect(exited.latest_output_bytes).toBe(90_000_000)
    } finally {
      await client.dispose()
    }
  })

  it('rejects a failed page instead of publishing a partial inventory as zero or complete', async () => {
    const adapter = new CtxmuxRunAdapter()
    const listPage = vi.fn(async (cursor: string | null): Promise<RunPage> => {
      if (cursor !== null) throw new Error('inventory transport failed')
      return { runs: [summary('live', { type: 'running' }, 100)], nextCursor: 'live' }
    })
    connectFixture(adapter, listPage)
    await expect(adapter.resourceSnapshot()).rejects.toThrow('inventory transport failed')
    expect(listPage.mock.calls).toEqual([[null], ['live']])
  })

  it('reports a confirmed empty Runtime as a complete zero inventory', async () => {
    const adapter = new CtxmuxRunAdapter()
    const listPage = vi.fn(async (): Promise<RunPage> => ({ runs: [], nextCursor: null }))
    connectFixture(adapter, listPage)
    await expect(adapter.resourceSnapshot()).resolves.toMatchObject({
      runCount: 0, runningRuns: 0, terminatedRuns: 0,
      terminatedUnattachedRuns: 0, attachments: 0, retainedOutputBytes: 0
    })
    expect(listPage).toHaveBeenCalledOnce()
  })
})
