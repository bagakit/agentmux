import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { CtxmuxAdapterInputChannel, CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxRunInputData, AgentMuxStoredAgentSession } from '../src/types.js'

type Inner = {
  connected: boolean
  registry: AgentMuxAgentSessionRegistry
  kernel: {
    isConnected(): boolean
    identity(): { daemonInstanceId: string }
    status(id: string): Promise<CtxmuxAdapterRun>
    openInput(id: string): Promise<CtxmuxAdapterInputChannel>
  }
}
const clients: AgentMuxClient[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map(client => client.dispose()))
})
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))

// Public Clients and real registry; this explicit native port assigns ranges at
// admission, never from Core's last ACK. Actual socket/native admission has its
// own integration case; a later Run snapshot is deliberately not an input ACK.
async function fixture() {
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'cross-client-agent', providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: fixturePath('private-fixture'), run: { runId: 'cross-client-run' }, retiredRuns: [],
    hookBindingId: 'cross-client-binding', hookToken: 'cross-client-token', createdAt: 1, updatedAt: 2
  }
  await store.compareAndSwap(null, stored)
  let cursor = 0
  const writes: AgentMuxRunInputData[] = []
  const run = (): CtxmuxAdapterRun => ({ nativeService: null, runId: stored.run.runId, lifecycleOperationId: null,
    program: 'generic', args: [], workspacePath: stored.workspacePath, pid: 123,
    state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0,
    firstAvailableByte: 0, acceptedInputBytes: cursor })
  const nativeInput = vi.fn((data: AgentMuxRunInputData) => {
    writes.push(data)
    const startByte = cursor
    cursor += Buffer.byteLength(data)
    return Promise.resolve({ appliedByteRange: { startByte, endByte: cursor } })
  })
  async function create() {
    const client = new AgentMuxClient({ store }); clients.push(client)
    const inner = client as unknown as Inner
    await inner.registry.load('local'); inner.connected = true
    inner.kernel.isConnected = () => true
    inner.kernel.identity = () => ({ daemonInstanceId: 'cross-client-daemon' })
    const status = vi.fn(async () => run()); inner.kernel.status = status
    const channel: CtxmuxAdapterInputChannel = { run: run(), waitWritable: async () => {}, input: data => nativeInput(data) }
    const open = vi.fn(async () => channel); inner.kernel.openInput = open
    const write = (data: AgentMuxRunInputData) => client.writeAgent({
      agentSessionId: stored.agentSessionId, expectedRun: stored.run, data, source: 'user'
    })
    return { client, inner, status, open, channel, write }
  }
  return { a: await create(), b: await create(), run, writes, nativeInput, stored }
}

describe('ordinary input native ordering', () => {
  it.each(['\x1b[<64;10;10M', new Uint8Array([0x1b, 0x5b, 0x4d, 0x60, 0x99, 0x99])] as const)(
    'consumes its native range after another Client writes without querying status', async data => {
      const h = await fixture()
      await h.a.write('a'); await h.b.write('b')
      const ack = await h.a.write(data)
      const length = Buffer.byteLength(data)
      expect(h.writes).toEqual(['a', 'b', data])
      expect(ack).toEqual({ runId: h.stored.run.runId,
        appliedByteRange: { startByte: 2, endByte: 2 + length }, acceptedThroughByte: 2 + length })
      expect(h.a.status).not.toHaveBeenCalled()
      expect(h.b.status).not.toHaveBeenCalled()
      expect(h.a.channel.run.acceptedInputBytes).toBe(0)
    })

  it('dispatches the next original input before the earlier receipt, retaining exact independent ACKs', async () => {
    const h = await fixture(), release = Promise.withResolvers<void>()
    const native = h.nativeInput.getMockImplementation()!
    h.nativeInput.mockImplementationOnce(data => {
      const receipt = native(data)
      return release.promise.then(() => receipt)
    })
    let firstSettled = false
    const first = h.a.write('a').then(ack => { firstSettled = true; return ack })
    const second = h.a.write('b')
    for (let n = 0; n < 8; n++) await checkpoint()
    const before = { writes: [...h.writes], firstSettled }
    // Cleanup also runs for the inverse; the retained pre-release assertion is the oracle.
    release.resolve()
    const receipts = await Promise.all([first, second])
    expect(before).toEqual({ writes: ['a', 'b'], firstSettled: false })
    expect(receipts.map(ack => ack.appliedByteRange)).toEqual([{ startByte: 0, endByte: 1 }, { startByte: 1, endByte: 2 }])
    expect(h.a.status).not.toHaveBeenCalled()
  })

  it('qualifies cold native cwd before any input and keeps a valid independent Client usable', async () => {
    const h = await fixture()
    h.a.open.mockResolvedValue({ ...h.a.channel, run: { ...h.a.channel.run, workspacePath: fixturePath('wrong-native-cwd') } })
    await expect(h.a.write('wrong')).rejects.toMatchObject({ code: 'AGENT_SESSION_RUN_MISMATCH' })
    expect(h.writes).toEqual([])
    expect((await h.b.write('right')).appliedByteRange).toEqual({ startByte: 0, endByte: 5 })
  })

  it('does not replay an unknown original input when a later independent call succeeds', async () => {
    const h = await fixture(), native = h.nativeInput.getMockImplementation()!
    h.nativeInput.mockImplementationOnce(async data => {
      await native(data)
      throw new AgentMuxError('Original result was lost.', 'CTXMUX_connection_closed', 'unknown')
    })
    await expect(h.a.write('a')).rejects.toMatchObject({ detail: 'unknown' })
    const next = await h.a.write('b')
    expect(h.writes).toEqual(['a', 'b'])
    expect(next.appliedByteRange).toEqual({ startByte: 1, endByte: 2 })
  })

  it.each(['', new Uint8Array(0)] as const)('keeps an empty operation behind prior completion and reads its actual cursor without native input', async data => {
    const h = await fixture(), release = Promise.withResolvers<void>()
    const native = h.nativeInput.getMockImplementation()!
    h.nativeInput.mockImplementationOnce(value => {
      const receipt = native(value)
      return release.promise.then(() => receipt)
    })
    const first = h.a.write('a'), empty = h.a.write(data)
    for (let n = 0; n < 8; n++) await checkpoint()
    const readsBeforeAck = h.a.status.mock.calls.length
    release.resolve(); await first
    expect(await empty).toEqual({ runId: h.stored.run.runId, appliedByteRange: { startByte: 1, endByte: 1 }, acceptedThroughByte: 1 })
    expect(readsBeforeAck).toBe(0)
    expect(h.a.status).toHaveBeenCalledTimes(1)
    expect(h.writes).toEqual(['a'])
  })

  it.each(['', new Uint8Array(0)] as const)('leaves an unknown empty cursor unknown without writing or closing the Run', async data => {
    const h = await fixture()
    h.a.inner.kernel.status = async () => ({ ...h.run(), acceptedInputBytes: null })
    const events: unknown[] = []; h.a.client.onEvent(event => events.push(event))
    expect(await h.a.write(data)).toEqual({ runId: h.stored.run.runId, appliedByteRange: null, acceptedThroughByte: null })
    expect(h.writes).toEqual([])
    expect(events).toEqual([])
    expect(h.run().state).toEqual({ type: 'running' })
  })
})
