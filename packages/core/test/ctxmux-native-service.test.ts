import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CtxmuxCommandError, type AttachedSnapshot, type NativeServiceSnapshot, type RunEvent, type RunInfo } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { AgentMuxAgentSessionRegistry } from '../src/agent-session-registry.js'
import { CtxmuxRunAdapter, type CtxmuxAdapterEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import type { AgentMuxRpcStreamEvent } from '../src/public-rpc.js'

const clients: AgentMuxClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.dispose())) })
function service(): NativeServiceSnapshot {
  return { revision: 1, owner: { type: 'serving' }, output: { type: 'serving' },
    input: { phase: { type: 'open' }, unsettled_commands: 0, unsettled_request_bytes: 0,
      write_blocked: false, completed_input_bytes: 5, current_size: { cols: 80, rows: 24 }, active_confirmed_bytes: 0 },
    terminal_fault: null }
}
function runInfo(id: string, nativeService: NativeServiceSnapshot = service()): RunInfo {
  return { id, spec: { program: 'codex', args: [], cwd: upstreamFixturePath("fixture"), env: {}, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] },
    lineage: null, backend: { type: 'native' }, capabilities: { input: true, resize: true, signal: true, stop: true,
      fork_level_a: false, fork_level_b: false, replay: 'raw_from_start' }, pid: 4321, state: { type: 'running' },
    current_size: { cols: 80, rows: 24 }, latest_output_bytes: 0, durable_output_bytes: 0, first_available_byte: 0,
    attachments: 1, applied_input_bytes: 5, native_service: nativeService }
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
    hostId: 'local', workspacePath: upstreamFixturePath("fixture"), run: { runId: 'agent-run' }, retiredRuns: [], hookBindingId: 'fixture', hookToken: 'fixture', createdAt: 1, updatedAt: 1 }
  await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store }); clients.push(client)
  const inner = client as unknown as { connected: boolean; registry: AgentMuxAgentSessionRegistry; kernel: CtxmuxRunAdapter; acceptKernelEvent(event: CtxmuxAdapterEvent): void }
  await inner.registry.load('local'); inner.connected = true
  const facts = new Map([['agent-run', service()], ['other-run', service()]])
  const streams = new Map<string, Stream>()
  const sdk = {
    attach: vi.fn(async (id: string) => {
      const stream = new Stream(); streams.set(id, stream)
      const snapshot: AttachedSnapshot = { run: runInfo(id, facts.get(id)!), resize_revision: 0,
        terminal: { type: 'not_requested' }, terminal_restore: new Uint8Array(0),
        replay: { chunks: [], truncated: false, first_available_byte: 0, latest_output_bytes: 0 } }
      return { snapshot, events: () => stream.events(), detach: async () => stream.close(), close: () => stream.close() }
    }),
    list: vi.fn(async () => [...facts.keys()].map(id => ({ id }))),
    status: vi.fn(async (id: string) => runInfo(id, facts.get(id)!)),
    recoverableInput: vi.fn(async () => { throw new CtxmuxCommandError('io', 'input write failed', 'unknown') })
  }
  ;(inner.kernel as unknown as { client: unknown }).client = sdk
  inner.kernel.onEvent(event => inner.acceptKernelEvent(event))
  const events: AgentMuxClientEvent[] = []; client.onEvent(event => events.push(event))
  const restored = await client.reattachAgent('service-agent')
  await client.attachTerminal('other-run')
  return { client, inner, sdk, facts, streams, events, restored }
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

it('preserves native snapshot facts through the public Client and service changes never become child exit', async () => {
  const h = await fixture()
  expect(h.restored.attachment.run.nativeService).toEqual({ revision: 1, owner: { type: 'serving' }, output: { type: 'serving' },
    input: { phase: { type: 'open' }, unsettledCommands: 0, unsettledRequestBytes: 0, writeBlocked: false,
      completedInputBytes: 5, currentSize: { cols: 80, rows: 24 }, activeConfirmedBytes: 0 }, terminalFault: null })
  const change = service(); change.revision = 2
  change.owner = { type: 'stopped', reason: { owner_io_failed: { stage: 'wake_drain', os_error: 5 } } }
  change.input.phase = { type: 'unavailable', reason: 'control_closed' }
  change.input.active_confirmed_bytes = 3
  h.facts.set('agent-run', change)
  h.events.length = 0; h.sdk.list.mockClear(); h.sdk.status.mockClear()
  h.streams.get('agent-run')!.push({ type: 'service_changed', service: change })
  await vi.waitFor(() => expect(h.events.map(event => event.type)).toEqual(['run-service']))
  expect(h.events[0]).toMatchObject({ type: 'run-service', agentSessionId: 'service-agent', run: { runId: 'agent-run' },
    nativeService: { revision: 2, owner: { type: 'stopped', reason: { ownerIoFailed: { stage: 'wake_drain', osError: 5 } } },
      input: { phase: { type: 'unavailable', reason: 'control_closed' }, activeConfirmedBytes: 3 } } })
  expect(h.sdk.list).not.toHaveBeenCalled(); expect(h.sdk.status).not.toHaveBeenCalled()
  expect(h.inner.kernel.hasAttachment('agent-run')).toBe(true)
  expect(h.inner.kernel.hasAttachment('other-run')).toBe(true)
  const runs = await h.client.listRuns()
  expect(runs.map(run => [run.runId, run.state, run.nativeService?.revision])).toEqual([['agent-run', 'running', 2], ['other-run', 'running', 1]])
})

it('a Run-local derived terminal fault leaves raw bytes and another Run live and emits its scoped service notice', async () => {
  const h = await fixture(); h.events.length = 0
  const changed = service(); changed.revision = 2; changed.terminal_fault = { stage: 'export', through_byte: 0 }
  h.streams.get('agent-run')!.push({ type: 'service_changed', service: changed })
  h.streams.get('agent-run')!.push({ type: 'output', chunk: { start_byte: 0, end_byte: 3, data: new TextEncoder().encode('raw') } })
  h.streams.get('other-run')!.push({ type: 'output', chunk: { start_byte: 0, end_byte: 5, data: new TextEncoder().encode('other') } })
  await vi.waitFor(() => expect(h.events.filter(event => event.type === 'terminal-output').length).toBe(2))
  expect(h.events.filter(event => event.type === 'terminal-output').map(event => [event.run.runId, event.data]).sort())
    .toEqual([['agent-run', 'raw'], ['other-run', 'other']])
  expect(h.events.filter(event => event.type === 'agent-error')).toEqual([])
  expect(h.events).toContainEqual(expect.objectContaining({ type: 'run-service', nativeService: expect.objectContaining({ terminalFault: { stage: 'export', throughByte: 0 } }) }))
  expect(h.events.filter(event => event.type === 'process-state')).toEqual([])
  expect(h.inner.kernel.hasAttachment('agent-run')).toBe(true)
})

it.each([{ disposition: 'unknown' as const, prefix: 3 }, { disposition: 'unknown' as const, prefix: null },
  { disposition: 'not_applied' as const, prefix: 0 }])('public input preserves $disposition with confirmed prefix $prefix and never replays it', async ({ disposition, prefix }) => {
  const h = await fixture()
  h.sdk.recoverableInput.mockRejectedValue(new CtxmuxCommandError('io', 'input write failed', disposition, undefined, prefix))
  await expect(h.client.writeTerminal({ runId: 'other-run' }, {
    ownerInstanceId: 'owner', operationId: 'operation', expectedByte: 5, data: 'abcdef'
  })).rejects.toMatchObject({ code: 'CTXMUX_io', detail: disposition, controlFailure: { disposition, confirmedInputBytes: prefix } })
  expect(h.sdk.recoverableInput).toHaveBeenCalledOnce()
  expect(h.inner.kernel.hasAttachment('other-run')).toBe(true)
})

it('keeps a real public raw reader live across independent input and derived-view faults', async () => {
  const h = await fixture(), visible = h.streams.get('agent-run')!
  const directory = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-native-public-")), path = join(directory, 'owner.sock')
  const owner = new AgentMuxControlServer({ socketPath: path, coreClients: () => [{ hostId: 'local', client: h.client }] })
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  const observed: AgentMuxRpcStreamEvent<'agent.output'>[] = [], ended = vi.fn()
  try {
    await owner.start()
    const reader = await client.subscribe('agent.output', { agentSessionId: 'service-agent', follow: true }, {
      onInitial() {}, onEvent: event => observed.push(event), onEnd: ended
    })
    const raw = h.streams.get('agent-run')!, changed = service()
    changed.revision = 2; changed.input.phase = { type: 'unavailable', reason: 'control_closed' }
    changed.terminal_fault = { stage: 'export', through_byte: 0 }
    visible.push({ type: 'service_changed', service: changed })
    raw.push({ type: 'service_changed', service: changed })
    raw.push({ type: 'output', chunk: { start_byte: 0, end_byte: 5, data: new TextEncoder().encode('alive') } })
    await vi.waitFor(() => expect(observed).toContainEqual(expect.objectContaining({ type: 'output', data: expect.objectContaining({ startByte: 0, endByte: 5, dataBase64: Buffer.from('alive').toString('base64') }) })))
    expect(ended).not.toHaveBeenCalled()
    expect(observed.filter(event => event.type === 'error' || event.type === 'end')).toEqual([])
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'run-service', nativeService: expect.objectContaining({ terminalFault: { stage: 'export', throughByte: 0 } }) }))
    expect(h.events.filter(event => event.type === 'process-state' && event.state !== 'running')).toEqual([])
    expect(h.inner.kernel.hasAttachment('other-run')).toBe(true)
    await reader.dispose()
  } finally {
    await client.dispose(); await owner.stop(); await rm(directory, { recursive: true, force: true })
  }
})

it.each([3, 0, null])('carries Native confirmed prefix %s through a real hosted public write without retry', async prefix => {
  const h = await fixture()
  ;(h.inner.kernel as unknown as { identity(): unknown }).identity = () => ({ buildIdentity: 'private-sdk', protocolVersion: 21, daemonInstanceId: 'private-owner' })
  h.sdk.recoverableInput.mockRejectedValue(new CtxmuxCommandError('io', 'input write failed', 'unknown', undefined, prefix))
  const directory = await mkdtemp(upstreamFixtureDisplayPath("tmp/amx-native-write-")), path = join(directory, 'owner.sock')
  const hosted = new AgentMuxHostedRuntimeService(h.client), consumerId = 'original-native-consumer'
  const owner = new AgentMuxControlServer({ socketPath: path, hostedRuntime: () => hosted, coreClients: () => [{ hostId: 'local', client: h.client }] })
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } })
  try {
    await owner.start()
    const reader = await client.subscribe('runtime.events', { consumerId }, { onInitial() {}, onEvent() {} })
    await expect(client.call('runtime.invoke', { consumerId, invocation: { method: 'writeTerminal', args: [
      { runId: 'other-run' }, { ownerInstanceId: 'private-owner', operationId: 'one-write', expectedByte: 5, data: 'abcdef' }
    ] } })).rejects.toMatchObject({ code: 'CTXMUX_io', detail: 'unknown', controlFailure: { disposition: 'unknown', confirmedInputBytes: prefix } })
    expect(h.sdk.recoverableInput).toHaveBeenCalledOnce()
    expect(h.inner.kernel.hasAttachment('other-run')).toBe(true)
    await reader.dispose()
  } finally {
    await client.dispose(); await owner.stop(); await hosted.dispose(); await rm(directory, { recursive: true, force: true })
  }
})

it('preserves an unknown authoritative input fence as null in the public Run', async () => {
  const h = await fixture()
  h.sdk.status.mockImplementation(async id => ({ ...runInfo(id, h.facts.get(id)!), applied_input_bytes: null }))
  expect((await h.client.listRuns()).map(run => run.acceptedInputBytes)).toEqual([null, null])
  expect(h.sdk.recoverableInput).not.toHaveBeenCalled()
})
