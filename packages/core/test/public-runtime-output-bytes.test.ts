import { describe, expect, it, vi } from 'vitest'
import type { OutputChunk, RunEvent } from '@ctxmux/sdk'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { AgentMuxClientEventPublisher } from '../src/client-event-publisher.js'
import { OrderedSessionOutputFollow, type FollowOutput } from '../src/session-output-follow.js'
import type { AgentMuxClientEvent, AgentMuxRunDataEvent } from '../src/types.js'

type OutputEvent = Extract<AgentMuxClientEvent, { type: 'terminal-output' }>
function chunk(start: number, data: number[]): OutputChunk {
  return { start_byte: start, end_byte: start + data.length, data: Uint8Array.from(data) }
}
const runId = 'raw-byte-run'
const run = {
  id: runId, spec: null, lineage: null, pid: null,
  state: { type: 'running' as const }, latest_output_bytes: 9, durable_output_bytes: null,
  first_available_byte: 0, attachments: 1, applied_input_bytes: null
}

function fixture(replay: OutputChunk[], live: OutputChunk[] = []) {
  const adapter = new CtxmuxRunAdapter()
  const detach = vi.fn(async () => {})
  const close = vi.fn()
  const attach = vi.fn(async (_runId: string, _afterByte: number) => ({
    snapshot: { run, replay: { chunks: replay, first_available_byte: 0, latest_output_bytes: 9, truncated: false } },
    async *events(): AsyncGenerator<RunEvent> {
      for (const item of live) yield { type: 'output', chunk: item }
      yield { type: 'exited', state: { type: 'exited', code: 0, signal: null } }
    }, detach, close
  }))
  // The SDK is the sole controlled transport seam. Real Client.connect installs the real adapter
  // pump's event subscription and every public projection runs unchanged.
  Object.assign(adapter, { client: { attach, list: async () => [] } })
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
  Object.assign(client, { kernel: adapter })
  const events: AgentMuxClientEvent[] = []
  client.onEvent((event) => { events.push(event) })
  return { client, events, attach, detach }
}
function outputs(events: AgentMuxClientEvent[]): OutputEvent[] {
  return events.filter((event): event is OutputEvent => event.type === 'terminal-output')
}
function bytes(events: readonly { dataBytes: Uint8Array }[]): number[] {
  return events.flatMap((event) => [...event.dataBytes])
}

describe('public ordered Run bytes', () => {
  it('preserves split UTF-8 and split ANSI bytes across actual Client/Adapter replay and live publication', async () => {
    const { client, events } = fixture([chunk(0, [0xe4])], [
      chunk(1, [0xb8, 0xad, 0x1b, 0x5b]), chunk(5, [0x33, 0x31, 0x6d, 0x58])
    ])
    try {
      await client.connect()
      const attached = await client.attachTerminal(runId, 0)
      await vi.waitFor(() => expect(outputs(events)).toHaveLength(2))
      expect(attached.replay).toHaveLength(1)
      const all = [...attached.replay, ...outputs(events).map((event) => ({
        dataBytes: event.dataBytes, startByte: event.evidence.outputByteRange.startByte,
        endByte: event.evidence.outputByteRange.endByte, data: event.data
      }))]
      expect(all.map((event) => [event.startByte, event.endByte, [...event.dataBytes]])).toEqual([
        [0, 1, [0xe4]], [1, 5, [0xb8, 0xad, 0x1b, 0x5b]], [5, 9, [0x33, 0x31, 0x6d, 0x58]]
      ])
      expect(bytes(all)).toEqual([0xe4, 0xb8, 0xad, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x58])
      expect(all.map((event) => event.data)).toEqual(['', '中\u001b[', '31mX'])
      for (const event of all) expect(event.dataBytes.byteLength).toBe(event.endByte - event.startByte)
    } finally { await client.dispose() }
  })

  it('publishes a raw leading byte even when its semantic text observation is empty', async () => {
    const { client, events } = fixture([], [chunk(0, [0xe4]), chunk(1, [0xb8, 0xad])])
    try {
      await client.connect()
      await client.attachTerminal(runId, 0)
      await vi.waitFor(() => expect(outputs(events)).toHaveLength(2))
      expect(outputs(events).map((event) => ({ data: event.data, bytes: [...event.dataBytes],
        range: event.evidence.outputByteRange }))).toEqual([
        { data: '', bytes: [0xe4], range: { startByte: 0, endByte: 1 } },
        { data: '中', bytes: [0xb8, 0xad], range: { startByte: 1, endByte: 3 } }
      ])
    } finally { await client.dispose() }
  })

  it('returns exact mid-character replay bytes despite a temporary semantic decoder starting mid-sequence', async () => {
    const { client, attach, detach } = fixture([chunk(1, [0xb8, 0xad]), chunk(3, [0x1b]), chunk(4, [0x5b, 0x30, 0x6d])])
    try {
      await client.connect()
      const replay = await client.readRunReplay({ runId }, 1)
      expect(attach).toHaveBeenCalledExactlyOnceWith(runId, 1)
      expect(detach).toHaveBeenCalledOnce()
      expect(replay.replay.map((event) => [event.startByte, event.endByte, [...event.dataBytes]])).toEqual([
        [1, 3, [0xb8, 0xad]], [3, 4, [0x1b]], [4, 7, [0x5b, 0x30, 0x6d]]
      ])
      expect(bytes(replay.replay)).toEqual([0xb8, 0xad, 0x1b, 0x5b, 0x30, 0x6d])
    } finally { await client.dispose() }
  })

  it('forwards the original byte payload through the publisher, including reconnect replay publication', () => {
    const publisher = new AgentMuxClientEventPublisher()
    const seen: OutputEvent[] = []
    publisher.onEvent((event) => { if (event.type === 'terminal-output') seen.push(event) })
    const dataBytes = Uint8Array.from([0xe4])
    publisher.publishRunEvent({ type: 'data', runId, startByte: 0, endByte: 1, data: '', dataBytes })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.dataBytes).toBe(dataBytes)
    expect(seen[0]!.evidence.outputByteRange).toEqual({ startByte: 0, endByte: 1 })
    publisher.dispose()
  })

  it('trims requested mid-character replay and overlapping live bytes without semantic text reconstruction', () => {
    const emitted: FollowOutput[] = []
    const follow = new OrderedSessionOutputFollow(runId, 1, (event) => emitted.push(event), vi.fn())
    const replay: AgentMuxRunDataEvent[] = [
      { type: 'data', runId, startByte: 0, endByte: 1, data: '', dataBytes: Uint8Array.from([0xe4]) },
      { type: 'data', runId, startByte: 0, endByte: 2, data: '', dataBytes: Uint8Array.from([0xe4, 0xb8]) }
    ]
    follow.accept({ type: 'terminal-output', run: { runId }, data: '中', dataBytes: Uint8Array.from([0xb8, 0xad]),
      evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte: 1, endByte: 3 } } })
    follow.accept({ type: 'terminal-output', run: { runId }, data: '\u001b[31mX',
      dataBytes: Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x58]),
      evidence: { source: 'terminal-output', observedAt: 1, outputByteRange: { startByte: 3, endByte: 9 } } })
    follow.finishReplay(replay)
    expect(emitted.map((event) => [event.replay, event.startByte, event.endByte, [...event.dataBytes]])).toEqual([
      [true, 1, 2, [0xb8]], [false, 2, 3, [0xad]], [false, 3, 9, [0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x58]]
    ])
    expect(bytes(emitted)).toEqual([0xb8, 0xad, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x58])
  })
})
