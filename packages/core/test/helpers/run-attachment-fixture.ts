import { vi } from 'vitest'
import { PROTOCOL_VERSION, type AttachedSnapshot, type AttachmentEvent, type OutputChunk, type RunInfo, type RuntimeIdentity } from '@ctxmux/sdk'
import { CtxmuxRunAdapter, type CtxmuxAdapterEvent } from '../../src/ctxmux-run-adapter.js'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../src/agent-session-store.js'
import type { AgentMuxClientEvent } from '../../src/types.js'

export class AttachmentStream {
  private readonly queue: AttachmentEvent[] = []
  private wake: (() => void) | undefined
  private ended = false
  private failure: Error | undefined
  readonly close = vi.fn(() => this.end())
  readonly detach = vi.fn(async () => this.end())
  push(event: AttachmentEvent): void { this.queue.push(event); this.wake?.() }
  end(error?: Error): void { this.failure = error; this.ended = true; this.wake?.() }
  async *events(): AsyncGenerator<AttachmentEvent> {
    for (;;) {
      if (this.queue.length) {
        const event = this.queue.shift()!
        yield event
        if (event.type === 'exited' || event.type === 'interrupted') return
        continue
      }
      if (this.ended) { if (this.failure) throw this.failure; return }
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = undefined
    }
  }
}
export const bytes = (value: string) => new TextEncoder().encode(value)
export function output(start: number, data: Uint8Array): OutputChunk {
  return { start_byte: start, end_byte: start + data.byteLength, data }
}
export async function attachmentFixture() {
  const adapter = new CtxmuxRunAdapter(), store = new AgentMuxMemoryAgentSessionStore()
  const core = new AgentMuxClient({ store })
  const inner = core as unknown as { kernel: CtxmuxRunAdapter; connected: boolean; registry: { load(hostId: string): Promise<void> };
    acceptKernelEvent(event: CtxmuxAdapterEvent): void; handleConnectionLost(epoch: number): void; connectionEpoch: number;
    observeRuntimeEndpoint(epoch: number, observation: { runId: string; error: import('../../src/errors.js').AgentMuxError }): void;
    reconnectSleep(ms: number): Promise<void>; reconnectController: AbortController | null }
  await inner.registry.load('local'); inner.kernel = adapter; inner.connected = true
  let recoverEndpoint = false
  const events: AgentMuxClientEvent[] = [], errors = vi.fn(), lost = vi.fn(), endpoints = vi.fn()
  core.onEvent(event => events.push(event)); adapter.onEvent(event => {
    if (event.type === 'endpoint-unconfirmed' && !recoverEndpoint) endpoints(event)
    else inner.acceptKernelEvent(event)
  })
  adapter.onError(errors); adapter.onConnectionLost(lost)
  const runs = new Map<string, { state: RunInfo['state']; latest: number; first: number; replay: OutputChunk[]; input: number }>()
  const streams = new Map<string, AttachmentStream[]>()
  const info = (id: string): RunInfo => {
    const value = runs.get(id)!
    return { id, spec: { program: 'private-runtime', args: [], cwd: process.cwd(), env: {}, initial_size: { cols: 80, rows: 24 }, declared_inputs: [] },
      lineage: null, backend: { type: 'native' }, capabilities: { input: true, resize: true, signal: true, stop: true,
        fork_level_a: false, fork_level_b: false, replay: 'raw_from_start' }, pid: id === 'run-a' ? 4101 : 4102,
      state: value.state, latest_output_bytes: value.latest, durable_output_bytes: value.latest, first_available_byte: value.first,
      attachments: 1, applied_input_bytes: value.input, current_size: { cols: 80, rows: 24 }, native_service: null }
  }
  const snapshot = (id: string, afterByte: number, terminal: boolean): AttachedSnapshot => {
    const value = runs.get(id)!
    const restore = bytes('restored')
    return { run: info(id), resize_revision: 3, terminal_restore: terminal ? restore : new Uint8Array(),
      terminal: terminal ? { type: 'basic_vt', checkpoint: { run_id: id, through_byte: value.latest,
        resize_revision: 3, size: { cols: 80, rows: 24 }, restore_size: { cols: 80, rows: 24 },
        restore_scrollback_rows: null, resize_after_restore_bytes: 0, restore_bytes: restore.byteLength }, resizes: [] } : { type: 'not_requested' },
      replay: { first_available_byte: value.first, latest_output_bytes: value.latest, truncated: afterByte < value.first,
        chunks: terminal ? [] : value.replay.filter(chunk => chunk.end_byte > afterByte).map(chunk => {
          const start = Math.max(chunk.start_byte, afterByte)
          return output(start, chunk.data.subarray(start - chunk.start_byte))
        }) } }
  }
  const open = (terminal: boolean) => vi.fn(async (id: string, afterByte: number) => {
    const stream = new AttachmentStream()
    streams.set(id, [...streams.get(id) ?? [], stream])
    return { snapshot: snapshot(id, afterByte, terminal), events: () => stream.events(), close: stream.close, detach: stream.detach }
  })
  const sdk = { attach: open(false), attachTerminal: open(true), status: vi.fn(async (id: string) => info(id)),
    list: vi.fn(async () => [...runs.keys()].map(info)), recoverableInput: vi.fn(async (input: { runId: string; data: Uint8Array | string; expectedByte: number }) => {
      const value = runs.get(input.runId)!, size = typeof input.data === 'string' ? bytes(input.data).byteLength : input.data.byteLength
      value.input = input.expectedByte + size
      return { run: info(input.runId), receipt: { start_byte: input.expectedByte, end_byte: value.input } }
    }) }
  const runtime: RuntimeIdentity = { daemonInstanceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', runtimeIdPersistence: 'state_dir',
    protocolGeneration: PROTOCOL_VERSION, buildId: 'ctxmuxd/0.1.0', platform: 'macos', arch: 'aarch64', capabilities: {
      'native.start': 1, 'native.recoverable_input': 1, 'native.recoverable_stop': 1, 'services.persistent_state': 1,
      'services.planned_exec_upgrade_continuity': 1
    } }
  const adapterInner = adapter as unknown as { client: unknown; runtime: RuntimeIdentity | null }
  adapterInner.client = sdk; adapterInner.runtime = runtime
  const add = (id: string, data = new Uint8Array()) => runs.set(id, { state: { type: 'running' }, latest: data.byteLength,
    first: 0, replay: data.byteLength ? [output(0, data)] : [], input: 0 })
  add('run-a'); add('run-b')
  return { adapter, adapterInner, core, inner, sdk, events, errors, lost, endpoints, streams, runs, info, snapshot, add,
    wireRecovery() {
      recoverEndpoint = true
      inner.reconnectSleep = async () => {}
      adapter.onConnectionLost(() => inner.handleConnectionLost(inner.connectionEpoch))
    },
    latest: (id: string) => streams.get(id)!.at(-1)!,
    append(id: string, data: Uint8Array) {
      const value = runs.get(id)!, chunk = output(value.latest, data)
      value.latest = chunk.end_byte; value.replay.push(chunk)
      streams.get(id)?.at(-1)?.push({ type: 'output', chunk })
    },
    close: async () => { await core.dispose() }
  }
}
