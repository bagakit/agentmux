import { afterEach, expect, it, vi } from 'vitest'
import type { AttachedSnapshot, OutputChunk, RunEvent, RunInfo } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { terminalContinuationSteps } from '../src/terminal-continuation.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import type { AgentMuxClientEvent, AgentMuxRunAttachmentView, AgentMuxStoredAgentSession } from '../src/types.js'

const bytes = (text: string) => new TextEncoder().encode(text)
const clients: AgentMuxClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })

class Stream {
  private readonly queued: RunEvent[] = []
  private wake: (() => void) | undefined
  private ended = false
  push(event: RunEvent): void { this.queued.push(event); this.wake?.() }
  close(): void { this.ended = true; this.wake?.() }
  async *events(): AsyncGenerator<RunEvent> {
    for (;;) {
      if (this.queued.length) { yield this.queued.shift()!; continue }
      if (this.ended) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
function chunk(start: number, text: string): OutputChunk {
  const data = bytes(text)
  return { start_byte: start, end_byte: start + data.byteLength, data }
}
const stored: AgentMuxStoredAgentSession = {
  kind: 'agent', agentSessionId: 'reconnect-agent', providerId: 'codex', executorId: 'codex',
  hostId: 'local', workspacePath: '/private/reconnect', run: { runId: 'reconnect-run' },
  retiredRuns: [], hookBindingId: 'fixture-binding', hookToken: 'fixture-token', createdAt: 1, updatedAt: 1
}
async function fixture(view: AgentMuxRunAttachmentView, initiallyPublishedThroughByte = 100) {
  const store = new AgentMuxMemoryAgentSessionStore(); await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const adapter = new CtxmuxRunAdapter()
  const adapterInner = adapter as unknown as { client: unknown }
  const inner = client as unknown as {
    kernel: CtxmuxRunAdapter; connected: boolean; connectionEpoch: number
    registry: AgentMuxAgentSessionRegistry; open(epoch: number): Promise<void>
    reconnectSleep(ms: number): Promise<void>; handleConnectionLost(epoch: number): void
    acceptKernelEvent(event: unknown): void
  }
  await inner.registry.load('local'); inner.kernel = adapter; inner.connected = true
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  adapter.onEvent(event => inner.acceptKernelEvent(event))
  adapter.onConnectionLost(() => inner.handleConnectionLost(inner.connectionEpoch))
  let latest = initiallyPublishedThroughByte; let revision = 4; let size = { cols: 80, rows: 24 }
  let checkpointByte = 100; let checkpointRevision = 4; let checkpointSize = { ...size }
  let replay: OutputChunk[] = initiallyPublishedThroughByte > 100
    ? [chunk(100, 'P'.repeat(initiallyPublishedThroughByte - 100))] : []
  let resizes: Extract<AttachedSnapshot['terminal'], { type: 'basic_vt' }>['resizes'] = []
  const streams: Stream[] = []
  const info = (): RunInfo => ({ id: stored.run.runId, spec: { program: 'codex', args: [], cwd: stored.workspacePath,
    env: {}, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] }, lineage: null, backend: { type: 'native' },
    capabilities: { input: true, resize: true, signal: true, stop: true, fork_level_a: false,
      fork_level_b: false, replay: 'raw_from_start' }, pid: 4321, state: { type: 'running' },
    latest_output_bytes: latest, durable_output_bytes: latest, first_available_byte: 0,
    attachments: 1, applied_input_bytes: 0, current_size: size })
  const attach = (terminal: boolean) => vi.fn(async (_id: string, afterByte: number) => {
    const stream = new Stream(); streams.push(stream)
    const restore = bytes('\x1bcRESTORED')
    const start = terminal ? checkpointByte : afterByte
    const snapshot: AttachedSnapshot = { run: info(), resize_revision: revision,
      terminal: terminal ? { type: 'basic_vt', checkpoint: { run_id: stored.run.runId,
        through_byte: checkpointByte, resize_revision: checkpointRevision, size: checkpointSize,
        restore_bytes: restore.byteLength }, resizes } : { type: 'not_requested' },
      terminal_restore: terminal ? restore : new Uint8Array(0),
      replay: { chunks: replay.filter(c => c.end_byte > start), first_available_byte: 0,
        latest_output_bytes: latest, truncated: false } }
    return { snapshot, events: () => stream.events(), close: () => stream.close(), detach: async () => stream.close() }
  })
  const raw = attach(false); const terminal = attach(true)
  const sdk = { attach: raw, attachTerminal: terminal, list: async () => [info()], status: async () => info() }
  adapterInner.client = sdk
  // Only Runtime connection establishment is replaced; real adapter loss, public reattach,
  // reconnect loop, exact Session guard and event publication remain production sources.
  inner.open = async () => { adapterInner.client = sdk; inner.connected = true }
  inner.reconnectSleep = async () => {}
  await client.reattachAgent(stored.agentSessionId, 100, view)
  return { client, adapter, adapterInner, sdk, events, streams, raw, terminal,
    setSnapshot(partial = false): void {
      latest = 200; revision = 5; size = { cols: 132, rows: 45 }
      checkpointByte = partial ? 100 : 200; checkpointRevision = partial ? 4 : 5
      checkpointSize = partial ? { cols: 80, rows: 24 } : { ...size }
      replay = [chunk(100, 'A'.repeat(50) + 'B'.repeat(50))]
      resizes = partial ? [{ through_byte: 150, resize_revision: 5, size }] : []
    },
    async loseWire(): Promise<void> {
      streams[0]!.close()
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'connection-state', state: 'restored' })))
    }
  }
}
const snapshots = (events: AgentMuxClientEvent[]) => events.filter(
  (event): event is Extract<AgentMuxClientEvent, { type: 'terminal-snapshot' }> => event.type === 'terminal-snapshot'
)

it('terminal reconnect publishes one actual fresh snapshot before live, never final grid as an old resize', async () => {
  const h = await fixture('terminal'); h.setSnapshot(); await h.loseWire()
  expect(h.terminal.mock.calls).toEqual([[stored.run.runId, 100], [stored.run.runId, 100]])
  expect(h.raw).not.toHaveBeenCalled()
  const replayed = snapshots(h.events)
  expect(replayed).toHaveLength(1)
  expect(replayed[0]).toMatchObject({ agentSessionId: stored.agentSessionId, afterByte: 100, run: { runId: stored.run.runId, pid: 4321 },
    terminal: { type: 'basic-vt', checkpoint: { throughByte: 200, resizeRevision: 5, size: { cols: 132, rows: 45 } } },
    replay: [], gap: null, resizeRevision: 5 })
  expect(replayed[0]!.terminal.type === 'basic-vt' && replayed[0]!.terminal.restoreBytes.byteLength).toBeGreaterThan(0)
  expect(h.events.filter(event => event.type === 'terminal-output' || event.type === 'terminal-resized')).toEqual([])
  h.streams[1]!.push({ type: 'resized', size: { cols: 140, rows: 46 }, through_byte: 200, resize_revision: 6 })
  h.streams[1]!.push({ type: 'output', chunk: chunk(200, 'LIVE') })
  await vi.waitFor(() => expect(h.events.filter(event => event.type === 'terminal-output')).toHaveLength(1))
  expect(h.events.flatMap(event => event.type.startsWith('terminal-') ? [event.type] : []))
    .toEqual(['terminal-snapshot', 'terminal-resized', 'terminal-output'])
  expect(h.events.find(event => event.type === 'terminal-resized')).toMatchObject({ throughByte: 200, resizeRevision: 6 })
  expect(h.client.agentSession(stored.agentSessionId).run).toEqual(stored.run)
})
it('terminal reconnect preserves the exact historical resize inside a partial-boundary snapshot', async () => {
  const h = await fixture('terminal', 180); h.setSnapshot(true); await h.loseWire()
  const received = snapshots(h.events)
  expect(received).toHaveLength(1)
  expect(h.terminal.mock.calls).toEqual([[stored.run.runId, 100], [stored.run.runId, 180]])
  expect(received[0]!.afterByte).toBe(180)
  const steps = [...terminalContinuationSteps(received[0]!)]
  expect(steps.map(step => step.type)).toEqual(['restore', 'data', 'resized', 'data'])
  expect(steps.filter(step => step.type === 'data').map(step => [step.startByte, step.endByte]))
    .toEqual([[100, 150], [150, 200]])
  expect(steps.find(step => step.type === 'resized')).toEqual({ type: 'resized',
    throughByte: 150, resizeRevision: 5, size: { cols: 132, rows: 45 } })
  expect(h.events.filter(event => event.type === 'terminal-output' || event.type === 'terminal-resized')).toEqual([])
})
it('raw reconnect retains original bytes without inventing a resize fence or a raw gap', async () => {
  const h = await fixture('raw'); h.setSnapshot(); await h.loseWire()
  expect(h.raw.mock.calls).toEqual([[stored.run.runId, 100], [stored.run.runId, 100]])
  expect(h.terminal).not.toHaveBeenCalled()
  expect(snapshots(h.events)).toEqual([])
  expect(h.events.filter(event => event.type === 'terminal-output')).toEqual([
    expect.objectContaining({ dataBytes: bytes('A'.repeat(50) + 'B'.repeat(50)),
      evidence: expect.objectContaining({ outputByteRange: { startByte: 100, endByte: 200 } }) })
  ])
  expect(h.events.filter(event => event.type === 'terminal-resized' || event.type === 'agent-error')).toEqual([])
})
it('snapshot publication may reset the wire without losing its offered boundary or exact representation', async () => {
  const h = await fixture('terminal'); h.setSnapshot()
  const unsubscribe = h.client.onEvent(event => { if (event.type === 'terminal-snapshot') h.adapter.resetConnection() })
  await h.loseWire(); unsubscribe()
  expect(snapshots(h.events)).toHaveLength(1)
  expect(h.adapter.continuationByte(stored.run.runId)).toBe(200)
  expect(h.adapter.continuationView(stored.run.runId)).toBe('terminal')
  expect(h.adapter.hasAttachment(stored.run.runId)).toBe(false)
  h.adapterInner.client = h.sdk
  await h.client.reattachAgent(stored.agentSessionId, h.adapter.continuationByte(stored.run.runId), h.adapter.continuationView(stored.run.runId))
  await Promise.resolve()
  expect(h.terminal.mock.calls).toEqual([[stored.run.runId, 100], [stored.run.runId, 100], [stored.run.runId, 200]])
  expect(h.adapter.hasAttachment(stored.run.runId)).toBe(true)
  expect(h.adapter.continuationView('other-run')).toBe('raw')
  await h.client.releaseRunAttachment(stored.run)
  expect(h.adapter.continuationView(stored.run.runId)).toBe('raw')
  expect(h.adapter.continuationByte(stored.run.runId)).toBe(0)
})
