import { fixturePath as upstreamFixturePath } from './helpers/fixture-values.js'
import { describe, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { encodeHostedValue } from '../src/hosted-value.js'
import type { AgentMuxHostedBootstrap, AgentMuxHostedRpcPort } from '../src/hosted-client-contract.js'
import type { AgentMuxRpcSubscriptionOptions } from '../src/public-rpc-client.js'
import type { AgentMuxRpcOutputInitial, AgentMuxRpcStreamParams } from '../src/public-rpc.js'
import type { AgentMuxClientEvent } from '../src/types.js'

function fixture(fence = 0, gap: AgentMuxRpcOutputInitial['gap'] = null) {
  const session: AgentMuxRpcOutputInitial['session'] = { kind: 'agent', agentSessionId: 'a123456789012345',
    providerId: 'codex', executorId: 'private-executor', hostId: 'local', workspacePath: upstreamFixturePath("private-workspace"),
    run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
  const original: AgentMuxRpcOutputInitial = { session, run: { nativeService: null, runId: session.run.runId, kind: 'agent',
    agentSessionId: session.agentSessionId, providerId: session.providerId, executorId: session.executorId,
    workspacePath: session.workspacePath, pid: 421, state: 'running', cols: 100, rows: 30,
    observedAt: 1, latestOutputBytes: fence, acceptedInputBytes: 0 }, gap,
    terminal: { type: 'not-requested' }, resizeRevision: 7 }
  const bootstrap: AgentMuxHostedBootstrap = { identity: { instanceId: 'private-original-daemon', ownership: 'owned',
    hostId: 'local', buildIdentity: 'private-fixture', protocolVersion: 1, processId: 123 },
    storePath: upstreamFixturePath("private-store/sessions.json"), messageQueuePath: upstreamFixturePath("private-store/messages.ndjson"),
    hostProcessId: 123, catalog: [], sessions: [session] }
  const calls: Array<{ method: string; params: unknown }> = []
  const readers: Array<{ params: AgentMuxRpcStreamParams<'agent.output'>; handlers: AgentMuxRpcSubscriptionOptions<'agent.output'>;
    dispose: ReturnType<typeof vi.fn>; admit?: () => void }> = []
  const behavior: { defer?: boolean; initial?: AgentMuxRpcOutputInitial } = {}
  // Only the original finite public port is controlled. The Source SDK owns the
  // independent leases, replay fence and callbacks. No Core, process or device is started.
  const port = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params: structuredClone(params) })
      if (method === 'runtime.bootstrap') return structuredClone(bootstrap)
      if (method === 'runtime.release-consumer') return { released: true }
      if (method === 'runtime.invoke' && (params as { invocation: { method: string } }).invocation.method === 'runtimeProjection') {
        return { value: encodeHostedValue({ hostId: 'local', subjects: [] }) }
      }
      throw new Error(`Unexpected business side effect: ${method}`)
    },
    subscribe: async (method: string, params: unknown, handlers: unknown) => {
      if (method === 'runtime.events') {
        const events = handlers as { onInitial(value: unknown): void }
        events.onInitial({ bootstrap: structuredClone(bootstrap) }); return { dispose: async () => {} }
      }
      if (method !== 'agent.output') throw new Error(`Unexpected subscription: ${method}`)
      const reader: typeof readers[number] = { params: params as AgentMuxRpcStreamParams<'agent.output'>,
        handlers: handlers as AgentMuxRpcSubscriptionOptions<'agent.output'>, dispose: vi.fn(async () => {}) }
      readers.push(reader)
      reader.handlers.onInitial(structuredClone(behavior.initial ?? original))
      if (behavior.defer) { behavior.defer = false; await new Promise<void>(resolve => { reader.admit = resolve }) }
      return { dispose: reader.dispose }
    }
  } as AgentMuxHostedRpcPort
  const output = (index: number, startByte: number, bytes: readonly number[], replay = false) => readers[index]!.handlers.onEvent({
    type: 'output', data: { runId: original.run.runId, replay, startByte, endByte: startByte + bytes.length,
      dataBase64: btoa(String.fromCharCode(...bytes)) }
  })
  return { port, calls, readers, behavior, original, bootstrap, output,
    business: () => calls.filter(call => call.method === 'runtime.invoke').map(call => (call.params as { invocation: unknown }).invocation) }
}

describe('Hosted independent public output observer', () => {
  it('waits for the same attachment replay fence, preserves its actual gap and bytes, and uses one UTF-8 decoder across replay and private live callbacks', async () => {
    const f = fixture(4, { requestedAfterByte: 0, firstAvailableByte: 1 }), client = await connectHostedAgentMux({ rpc: f.port })
    const observed: AgentMuxClientEvent[] = [], global: AgentMuxClientEvent[] = []
    client.onEvent(event => global.push(event))
    let confirmed = false
    const opening = client.observeAgentOutput(f.original.session.agentSessionId, 0, event => observed.push(event))
    void opening.then(() => { confirmed = true })
    await vi.waitFor(() => expect(f.readers).toHaveLength(1))
    expect(confirmed).toBe(false)
    f.output(0, 1, [65], true)
    await Promise.resolve(); await Promise.resolve()
    expect(confirmed).toBe(false)
    f.output(0, 2, [0xe4, 0xb8], true)
    const observation = await opening
    expect(observation.session).toEqual(f.original.session)
    expect(Object.keys(observation.attachment).sort()).toEqual(['gap', 'replay', 'resizeRevision', 'run', 'terminal'])
    expect(observation.attachment).toEqual({ run: f.original.run, gap: f.original.gap,
      terminal: f.original.terminal, resizeRevision: 7, replay: [
      { type: 'data', runId: 'original-run', startByte: 1, endByte: 2, dataBytes: Uint8Array.of(65), data: 'A' },
      { type: 'data', runId: 'original-run', startByte: 2, endByte: 4, dataBytes: Uint8Array.of(0xe4, 0xb8), data: '' }
    ] })
    f.output(0, 4, [0xad])
    expect(observed).toEqual([expect.objectContaining({ type: 'terminal-output', data: '中', dataBytes: Uint8Array.of(0xad),
      evidence: expect.objectContaining({ outputByteRange: { startByte: 4, endByte: 5 } }) })])
    expect(global).toEqual([])
    expect(f.readers[0]!.params).toEqual({ agentSessionId: f.original.session.agentSessionId, afterByte: 0, follow: true })
    expect(f.business()).toEqual([{ method: 'runtimeProjection', args: [] }])
    await observation.close(); await client.dispose()
  })

  it('returns the original same-attachment terminal facts and nonzero resize revision without another snapshot or a substituted default', async () => {
    const f = fixture(2), client = await connectHostedAgentMux({ rpc: f.port })
    const terminal: AgentMuxRpcOutputInitial['terminal'] = { type: 'basic-vt',
      checkpoint: { runId: f.original.run.runId, throughByte: 0, resizeRevision: 6, size: { cols: 80, rows: 24 },
        restoreSize: { cols: 80, rows: 24 }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 },
      restoreBytes: Uint8Array.of(27, 99, 0xff),
      resizes: [{ throughByte: 2, resizeRevision: 7, size: { cols: 100, rows: 30 } }] }
    f.behavior.initial = { ...f.original, terminal, resizeRevision: 7 }
    const events: AgentMuxClientEvent[] = []
    const opening = client.observeAgentOutput(f.original.session.agentSessionId, 0, event => events.push(event))
    await vi.waitFor(() => expect(f.readers).toHaveLength(1))
    f.output(0, 0, [65, 66], true)
    const observation = await opening
    expect(observation.attachment).toEqual({ run: f.original.run, gap: null, terminal, resizeRevision: 7,
      replay: [{ type: 'data', runId: f.original.run.runId, startByte: 0, endByte: 2, dataBytes: Uint8Array.of(65, 66), data: 'AB' }] })
    expect(observation.attachment.terminal).not.toBe(terminal)
    expect(events).toEqual([])
    expect(f.readers[0]!.params).toEqual({ agentSessionId: f.original.session.agentSessionId, afterByte: 0, follow: true })
    expect(f.business()).toEqual([{ method: 'runtimeProjection', args: [] }])
    await observation.close(); await client.dispose()
  })

  it('closes only its own same-Run lease, keeps other consumers receiving original new bytes and never invokes attachment, resize, input or query methods', async () => {
    const f = fixture(), first = await connectHostedAgentMux({ rpc: f.port }), second = await connectHostedAgentMux({ rpc: f.port })
    const a: AgentMuxClientEvent[] = [], b: AgentMuxClientEvent[] = [], c: AgentMuxClientEvent[] = []
    const readA = await first.observeAgentOutput(f.original.session.agentSessionId, 0, event => a.push(event))
    const readB = await first.observeAgentOutput(f.original.session.agentSessionId, 0, event => b.push(event))
    const readC = await second.observeAgentOutput(f.original.session.agentSessionId, 0, event => c.push(event))
    expect(f.readers).toHaveLength(3)
    await readA.close(); await readA.close()
    f.output(0, 0, [65]); f.output(1, 0, [65, 66]); f.output(2, 0, [65, 66])
    expect(a).toEqual([])
    expect(b).toEqual([expect.objectContaining({ type: 'terminal-output', dataBytes: Uint8Array.of(65, 66) })])
    await first.dispose()
    f.output(1, 2, [67]); f.output(2, 2, [67])
    expect(b).toHaveLength(1)
    expect(c).toEqual([
      expect.objectContaining({ type: 'terminal-output', dataBytes: Uint8Array.of(65, 66) }),
      expect.objectContaining({ type: 'terminal-output', dataBytes: Uint8Array.of(67) })
    ])
    expect(f.readers.map(reader => reader.dispose.mock.calls.length)).toEqual([1, 1, 0])
    expect(f.business()).toEqual([{ method: 'runtimeProjection', args: [] }, { method: 'runtimeProjection', args: [] }])
    await readB.close(); await readC.close(); await second.dispose()
    expect(f.readers.map(reader => reader.dispose.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('releases a late admitted subscription after SDK disposal while another client keeps its independent reader alive', async () => {
    const f = fixture(), first = await connectHostedAgentMux({ rpc: f.port }), second = await connectHostedAgentMux({ rpc: f.port })
    const lost: AgentMuxClientEvent[] = [], retained: AgentMuxClientEvent[] = []
    const healthy = await second.observeAgentOutput(f.original.session.agentSessionId, 0, event => retained.push(event))
    f.behavior.defer = true
    const pending = first.observeAgentOutput(f.original.session.agentSessionId, 0, event => lost.push(event))
    const rejection = expect(pending).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    void rejection.catch(() => {})
    await vi.waitFor(() => expect(f.readers[1]!.admit).toBeTypeOf('function'))
    await first.dispose()
    expect(f.readers[1]!.handlers.signal?.aborted).toBe(true)
    f.readers[1]!.admit!(); await rejection
    f.output(1, 0, [65]); f.output(0, 0, [66])
    expect(lost).toEqual([])
    expect(retained).toEqual([expect.objectContaining({ type: 'terminal-output', dataBytes: Uint8Array.of(66) })])
    expect(f.readers.map(reader => reader.dispose.mock.calls.length)).toEqual([0, 1])
    await healthy.close(); await second.dispose()
  })

  it('withdraws a confirmed replay result when SDK disposal wins before its asynchronous observation receipt', async () => {
    const f = fixture(2), client = await connectHostedAgentMux({ rpc: f.port })
    const events: AgentMuxClientEvent[] = []
    const opening = client.observeAgentOutput(f.original.session.agentSessionId, 0, event => events.push(event))
    const rejection = expect(opening).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    void rejection.catch(() => {})
    await vi.waitFor(() => expect(f.readers).toHaveLength(1))
    // The real fence resolves the pending replay promise. Disposal takes ownership
    // away before either awaited receipt can resume; it must not return a closed lease.
    f.output(0, 0, [65, 66], true)
    const disposing = client.dispose()
    await rejection; await disposing
    f.output(0, 2, [67])
    expect(events).toEqual([])
    expect(f.readers[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(f.readers[0]!.handlers.signal?.aborted).toBe(true)
    expect(f.business()).toEqual([{ method: 'runtimeProjection', args: [] }])
  })

  it('reports a confirmed output process end and treats transport loss as unknown without retiring the retained Session', async () => {
    const f = fixture(), client = await connectHostedAgentMux({ rpc: f.port }), events: AgentMuxClientEvent[] = []
    const ended = await client.observeAgentOutput(f.original.session.agentSessionId, 0, event => events.push(event))
    f.readers[0]!.handlers.onEvent({ type: 'end', data: { runId: 'original-run', state: 'exited', exitCode: 7 } })
    f.readers[0]!.handlers.onEnd?.()
    expect(events).toEqual([expect.objectContaining({ type: 'process-state', state: 'exited', exitCode: 7, pid: 421 })])
    await ended.close()
    const unknown = await client.observeAgentOutput(f.original.session.agentSessionId, 0, event => events.push(event))
    f.readers[1]!.handlers.onEnd?.(new Error('Private reader connection was interrupted'))
    expect(events).toEqual([
      expect.objectContaining({ type: 'process-state', state: 'exited', exitCode: 7 }),
      expect.objectContaining({ type: 'agent-error', code: 'CONTROL_UNAVAILABLE', message: 'Private reader connection was interrupted' })
    ])
    expect(client.agentSessions()).toEqual([f.original.session])
    expect(f.readers.map(reader => reader.dispose.mock.calls.length)).toEqual([1, 1])
    await unknown.close(); await client.dispose()
  })

  it('rejects another Session identity or live output before replay confirmation, closing only that reader while keeping durable projections', async () => {
    for (const invalid of ['session', 'premature-live'] as const) {
      const f = fixture(2), client = await connectHostedAgentMux({ rpc: f.port })
      try {
        if (invalid === 'session') f.behavior.initial = { ...f.original,
          session: { ...f.original.session, agentSessionId: 'a987654321012345' } }
        const opening = client.observeAgentOutput(f.original.session.agentSessionId, 0, () => {})
        const rejection = expect(opening).rejects.toMatchObject({ code: invalid === 'session' ? 'STALE_AGENT_SESSION_BINDING' : 'CONTROL_PROTOCOL_ERROR' })
        void rejection.catch(() => {})
        await vi.waitFor(() => expect(f.readers).toHaveLength(1))
        if (invalid === 'premature-live') { f.output(0, 0, [65]); f.output(0, 1, [66], true) }
        else f.output(0, 0, [65, 66], true)
        await rejection
        expect(f.readers[0]!.dispose).toHaveBeenCalledTimes(1)
        expect(client.agentSessions()).toEqual([f.original.session])
        expect(f.business()).toEqual([{ method: 'runtimeProjection', args: [] }])
      } finally { await client.dispose() }
    }
  })
})
