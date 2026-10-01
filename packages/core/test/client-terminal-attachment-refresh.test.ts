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
  const info = (): RunInfo => ({ native_service: null, id: stored.run.runId, spec: { program: 'codex', args: [], cwd: stored.workspacePath,
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
      terminal: terminal ? { type: 'basic_vt', checkpoint: { restore_size: checkpointSize, restore_scrollback_rows: null, resize_after_restore_bytes: 0, run_id: stored.run.runId,
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
  return { client, adapter, adapterInner, sdk, events, streams, raw, terminal, registry: inner.registry,
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

it('public refresh replaces a retained pump, preserves Run/PID and emits only exact observation-origin projections', async () => {
  const h = await fixture('terminal')
  await h.registry.update(stored.agentSessionId, stored.run, current => ({ ...current, updatedAt: 3,
    semanticStatus: { state: 'done', source: 'native-hook', observedAt: 2 },
    terminalOutputChannel: { state: 'severed', mode: 'degraded', reason: 'reattach-failed', run: stored.run, observedAt: 3 } }))
  h.setSnapshot()
  h.events.length = 0
  const snapshot = await h.client.refreshRunAttachment(stored.run, 100, 'terminal', 'refresh-exact')
  expect(h.terminal.mock.calls).toEqual([[stored.run.runId, 100], [stored.run.runId, 100]])
  expect(snapshot.run).toMatchObject({ runId: stored.run.runId, pid: 4321, state: 'running', latestOutputBytes: 200 })
  expect(h.client.agentSession(stored.agentSessionId).terminalOutputChannel).toBeUndefined()
  const projected = h.events.filter(e => e.type === 'agent-session' || e.type === 'process-state')
  expect(projected.map(e => e.observationOrigin)).toEqual([
    { kind: 'attachment-refresh', operationId: 'refresh-exact', run: stored.run },
    { kind: 'attachment-refresh', operationId: 'refresh-exact', run: stored.run }
  ])
  h.streams[0]!.push({ type: 'output', chunk: chunk(200, 'OLD') })
  h.streams[1]!.push({ type: 'output', chunk: chunk(200, 'NEW') })
  await vi.waitFor(() => expect(h.events.filter(e => e.type === 'terminal-output').map(e => e.data)).toEqual(['NEW']))
  expect(h.events.find(e => e.type === 'terminal-output')?.observationOrigin).toBeUndefined()
  expect(h.adapter.hasAttachment(stored.run.runId)).toBe(true)
})

it('a rejected fresh observation preserves the original retained pump and never clears its actual cause', async () => {
  const h = await fixture('terminal')
  await h.registry.update(stored.agentSessionId, stored.run, current => ({ ...current, updatedAt: 3,
    terminalOutputChannel: { state: 'severed', mode: 'degraded', reason: 'reattach-failed', run: stored.run, observedAt: 3 } }))
  h.terminal.mockRejectedValueOnce(new Error('Native attachment registration failed'))
  await expect(h.client.refreshRunAttachment(stored.run, 100, 'terminal', 'refresh-fails')).rejects.toThrow('Native attachment registration failed')
  expect(h.client.agentSession(stored.agentSessionId).terminalOutputChannel).toEqual({ state: 'severed', mode: 'degraded', reason: 'reattach-failed', run: stored.run, observedAt: 3 })
  h.streams[0]!.push({ type: 'output', chunk: chunk(100, 'PRESERVED') })
  await vi.waitFor(() => expect(h.events.filter(e => e.type === 'terminal-output').map(e => e.data)).toEqual(['PRESERVED']))
  expect(h.adapter.hasAttachment(stored.run.runId)).toBe(true)
})

it('ordinary automatic reconnect keeps its independent origin and public raw Terminal refresh establishes a real pump', async () => {
  const h = await fixture('terminal')
  h.setSnapshot(); await h.loseWire()
  expect(h.events.filter(e => e.type === 'connection-state').map(e => e.observationOrigin)).toEqual([undefined, undefined])
  await h.registry.delete(stored.agentSessionId)
  const refreshed = await h.client.refreshRunAttachment(stored.run, 200, 'raw', 'refresh-terminal')
  expect(refreshed.run).toMatchObject({ runId: stored.run.runId, pid: 4321, kind: 'terminal' })
  h.streams.at(-1)!.push({ type: 'output', chunk: chunk(200, 'TERMINAL') })
  await vi.waitFor(() => expect(h.events.filter(e => e.type === 'terminal-output').map(e => e.data)).toContain('TERMINAL'))
  expect(h.raw).toHaveBeenCalledExactlyOnceWith(stored.run.runId, 200)
})
