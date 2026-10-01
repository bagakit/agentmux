import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxRunInputData, AgentMuxStoredAgentSession } from '../src/types.js'

type Input = { operationId: string; expectedByte: number; data: AgentMuxRunInputData }
type Inner = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(id: string): Promise<CtxmuxAdapterRun>
    input(id: string, operation: Input): Promise<{ run: CtxmuxAdapterRun; appliedByteRange: { startByte: number; endByte: number } }>
  }
}
const clients: AgentMuxClient[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.dispose()))
})

// Two public Clients share one supported Store and one kernel cursor. The kernel
// seam enforces the real native exact-range rejection; it does not repair inputs.
async function fixture() {
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'cross-client-agent', providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: '/private-fixture', run: { runId: 'cross-client-run' }, retiredRuns: [],
    hookBindingId: 'cross-client-binding', hookToken: 'cross-client-token', createdAt: 1, updatedAt: 2
  }
  await store.compareAndSwap(null, stored)
  let cursor = 0
  const writes: Input[] = []
  const rejected: Input[] = []
  const run = (): CtxmuxAdapterRun => ({ runId: stored.run.runId, lifecycleOperationId: null,
    program: 'generic', args: [], workspacePath: stored.workspacePath, pid: 123,
    state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0,
    firstAvailableByte: 0, acceptedInputBytes: cursor })
  async function create() {
    const client = new AgentMuxClient({ store }); clients.push(client)
    const inner = client as unknown as Inner
    await inner.registry.load('local'); inner.connected = true
    inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'cross-client-daemon' })
    const status = vi.fn(async () => run()); inner.kernel.status = status
    inner.kernel.input = async (id, operation) => {
      expect(id).toBe(stored.run.runId)
      if (operation.expectedByte !== cursor) {
        rejected.push(operation)
        throw new AgentMuxError('Input cursor mismatch.', 'CTXMUX_input_cursor_mismatch', 'not_applied')
      }
      expect(operation.data.length).toBeGreaterThan(0)
      writes.push(operation)
      const startByte = cursor
      cursor += typeof operation.data === 'string' ? Buffer.byteLength(operation.data) : operation.data.byteLength
      return { run: run(), appliedByteRange: { startByte, endByte: cursor } }
    }
    const write = (data: AgentMuxRunInputData) => client.writeAgent({
      agentSessionId: stored.agentSessionId, expectedRun: stored.run, data, source: 'user'
    })
    return { client, inner, status, write }
  }
  const a = await create(), b = await create()
  await a.write('a') // A retains ACK cursor=1.
  await b.write('b') // The independent public Client advances the same Run to 2.
  return { a, b, run, writes, rejected, stored }
}

describe('new raw input after another public Client writes', () => {
  it.each(['\x1b[<64;10;10M', new Uint8Array([0x1b, 0x5b, 0x4d, 0x60, 0x99, 0x99])] as const)(
    'starts each nonempty original report at the fresh Run cursor', async data => {
      const h = await fixture(); const count = h.a.status.mock.calls.length
      const outcome = await h.a.write(data).then(ack => ({ ack, error: null }), error => ({ ack: null, error }))
      expect(outcome.error).toBeNull()
      expect(outcome.ack).not.toBeNull()
      const ack = outcome.ack!
      const length = typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength
      expect(h.writes.map(input => input.expectedByte)).toEqual([0, 1, 2])
      expect(h.writes.map(input => input.data)).toEqual(['a', 'b', data])
      expect(h.rejected).toEqual([])
      expect(ack).toEqual({ runId: h.stored.run.runId,
        appliedByteRange: { startByte: 2, endByte: 2 + length }, acceptedThroughByte: 2 + length })
      expect(h.a.status).toHaveBeenCalledTimes(count + 1)
    })

  it.each(['', new Uint8Array(0)] as const)('reports a known empty noop at the fresh cursor without native input', async data => {
    const h = await fixture(); const count = h.a.status.mock.calls.length
    const ack = await h.a.write(data)
    expect(h.writes.map(input => input.data)).toEqual(['a', 'b'])
    expect(h.rejected).toEqual([])
    expect(ack).toEqual({ runId: h.stored.run.runId,
      appliedByteRange: { startByte: 2, endByte: 2 }, acceptedThroughByte: 2 })
    expect(h.run().acceptedInputBytes).toBe(2)
    expect(h.a.status).toHaveBeenCalledTimes(count + 1)
  })

  it('preserves a real status-to-write race as not_applied and does not replay that report', async () => {
    const h = await fixture()
    h.a.inner.kernel.status = async () => {
      const snapshot = h.run()
      h.a.inner.kernel.status = async () => h.run()
      await h.b.write('c')
      return snapshot
    }
    await expect(h.a.write('z')).rejects.toMatchObject({
      code: 'CTXMUX_input_cursor_mismatch', detail: 'not_applied'
    })
    expect(h.writes.map(input => input.data)).toEqual(['a', 'b', 'c'])
    expect(h.rejected.map(input => ({ expectedByte: input.expectedByte, data: input.data })))
      .toEqual([{ expectedByte: 2, data: 'z' }])
    expect(h.run().acceptedInputBytes).toBe(3)
    const next = await h.a.write('y')
    expect(next.appliedByteRange).toEqual({ startByte: 3, endByte: 4 })
    expect(h.writes.map(input => input.data)).toEqual(['a', 'b', 'c', 'y'])
  })

  it.each(['', new Uint8Array(0)] as const)('leaves unknown empty cursor facts unknown without input or a new failure', async data => {
    const h = await fixture()
    h.a.inner.kernel.status = async () => ({ ...h.run(), acceptedInputBytes: null })
    const cursorMap = (h.a.client as unknown as { agentInputCursors: Map<string, number> }).agentInputCursors
    const previous = [...cursorMap]
    const events: unknown[] = []
    h.a.client.onEvent(event => events.push(event))
    const ack = await h.a.write(data)
    expect(ack).toEqual({ runId: h.stored.run.runId, appliedByteRange: null, acceptedThroughByte: null })
    expect(h.writes.map(input => input.data)).toEqual(['a', 'b'])
    expect(h.rejected).toEqual([])
    expect([...cursorMap]).toEqual(previous)
    expect(events).toEqual([])
    expect(h.run().state).toEqual({ type: 'running' })
  })
})
