import { afterEach, expect, it, vi } from 'vitest'
import { CtxmuxCommandError, type AttachedSnapshot, type RunEvent, type RunInfo } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { CtxmuxRunAdapter, type CtxmuxAdapterEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'

const clients: AgentMuxClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })
function runInfo(id: string): RunInfo {
  return { id, spec: { program: 'codex', args: [], cwd: '/fixture', env: {}, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] },
    lineage: null, backend: { type: 'native' }, capabilities: { input: true, resize: true, signal: true, stop: true,
      fork_level_a: false, fork_level_b: false, replay: 'raw_from_start' }, pid: 4321, state: { type: 'running' },
    current_size: { cols: 80, rows: 24 }, latest_output_bytes: 0, durable_output_bytes: 0, first_available_byte: 0,
    attachments: 1, applied_input_bytes: 5 }
}
class Stream {
  private eventsQueue: RunEvent[] = []
  private wake: (() => void) | undefined
  private closed = false
  push(event: RunEvent): void { this.eventsQueue.push(event); this.wake?.() }
  close(): void { this.closed = true; this.wake?.() }
  async *events(): AsyncGenerator<RunEvent> {
    while (!this.closed) {
      const event = this.eventsQueue.shift()
      if (event) yield event
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
}
async function fixture() {
  const store = new AgentMuxMemoryAgentSessionStore()
  const stored: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'service-agent', providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: '/fixture', run: { runId: 'agent-run' }, retiredRuns: [], hookBindingId: 'fixture', hookToken: 'fixture', createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const inner = client as unknown as { connected: boolean; registry: AgentMuxAgentSessionRegistry; kernel: CtxmuxRunAdapter; acceptKernelEvent(event: CtxmuxAdapterEvent): void }
  await inner.registry.load('local'); inner.connected = true
  const runIds = ['agent-run', 'other-run']
  const streams = new Map<string, Stream>()
  const sdk = {
    attach: vi.fn(async (id: string) => {
      const stream = new Stream(); streams.set(id, stream)
      const snapshot: AttachedSnapshot = { run: runInfo(id), resize_revision: 0,
        terminal: { type: 'not_requested' }, terminal_restore: new Uint8Array(0),
        replay: { chunks: [], truncated: false, first_available_byte: 0, latest_output_bytes: 0 } }
      return { snapshot, events: () => stream.events(), detach: async () => stream.close(), close: () => stream.close() }
    }),
    list: vi.fn(async () => runIds.map(id => ({ id }))),
    status: vi.fn(async (id: string) => runInfo(id)),
    recoverableInput: vi.fn(async () => { throw new CtxmuxCommandError('io', 'input write failed', 'unknown') })
  }
  ;(inner.kernel as unknown as { client: unknown }).client = sdk
  inner.kernel.onEvent(event => inner.acceptKernelEvent(event))
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  const restored = await client.reattachAgent('service-agent')
  await client.attachTerminal('other-run')
  return { client, inner, sdk, streams, events, restored }
}

it('reattaches the stored Agent identity to the healthy native Run without starting another process', async () => {
  const h = await fixture()
  expect(h.restored.attachment.run).toMatchObject({ runId: 'agent-run', pid: 4321, state: 'running' })
  expect(h.inner.kernel.hasAttachment('agent-run')).toBe(true)
  expect(h.inner.kernel.hasAttachment('other-run')).toBe(true)
  expect((await h.client.listRuns()).map(run => [run.runId, run.pid, run.state]))
    .toEqual([['agent-run', 4321, 'running'], ['other-run', 4321, 'running']])
})

it('keeps both native Run attachments live while delivering ordered raw output scoped to each Run', async () => {
  const h = await fixture(); h.events.length = 0
  h.streams.get('agent-run')!.push({ type: 'output', chunk: { start_byte: 0, end_byte: 3, data: new TextEncoder().encode('raw') } })
  h.streams.get('other-run')!.push({ type: 'output', chunk: { start_byte: 0, end_byte: 5, data: new TextEncoder().encode('other') } })
  await vi.waitFor(() => expect(h.events.filter(event => event.type === 'terminal-output').length).toBe(2))
  expect(h.events.filter(event => event.type === 'terminal-output').map(event => [event.run.runId, event.data]).sort())
    .toEqual([['agent-run', 'raw'], ['other-run', 'other']])
  expect(h.events.filter(event => event.type === 'process-state')).toEqual([])
  expect(h.inner.kernel.hasAttachment('agent-run')).toBe(true)
  expect(h.inner.kernel.hasAttachment('other-run')).toBe(true)
})

it.each(['unknown', 'not_applied'] as const)('preserves the public input %s disposition without silently replaying uncertain input', async disposition => {
  const h = await fixture()
  h.sdk.recoverableInput.mockRejectedValue(new CtxmuxCommandError('io', 'input write failed', disposition))
  await expect(h.client.writeTerminal({ runId: 'other-run' }, {
    ownerInstanceId: 'owner', operationId: 'operation', expectedByte: 5, data: 'abcdef'
  })).rejects.toMatchObject({ code: 'CTXMUX_io', detail: disposition })
  expect(h.sdk.recoverableInput).toHaveBeenCalledOnce()
  expect(h.inner.kernel.hasAttachment('other-run')).toBe(true)
})
