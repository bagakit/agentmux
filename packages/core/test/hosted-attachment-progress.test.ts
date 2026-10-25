import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { hostedTransfer } from '../src/hosted-value.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentMuxHostedBootstrap, AgentMuxHostedRpcPort, AgentMuxHostedTransferChunk } from '../src/hosted-client-contract.js'
import type { AgentMuxRunAttachment } from '../src/types.js'

async function fixture() {
  const owner: AgentMuxHostedBootstrap['owner'] = { runtimeId: 'original-runtime', ownerInstanceId: 'original-owner',
    protocolVersion: 2, processId: 123, availability: 'connected', ctxmux: null }
  const bootstrap: AgentMuxHostedBootstrap = { owner, connection: null, storePath: null, hostProcessId: 123,
    catalog: [], sessions: [], messageQueuePath: '/private/messages.ndjson' }
  const bytes = new Uint8Array(128 * 1024).fill(120)
  const attachment: AgentMuxRunAttachment = { run: { nativeService: null, runId: 'original-run', kind: 'terminal', providerId: null,
    executorId: null, agentSessionId: null, workspacePath: '/private/project', pid: 456, state: 'running', cols: 80, rows: 24,
    observedAt: 1, latestOutputBytes: bytes.length, acceptedInputBytes: 0 }, gap: null, resizeRevision: 0, terminal: { type: 'not-requested' },
    replay: [{ type: 'data', runId: 'original-run', startByte: 0, endByte: bytes.length, data: new TextDecoder().decode(bytes), dataBytes: bytes }] }
  const chunks = hostedTransfer({ kind: 'initial', value: attachment }, 'original-transfer')
  let deliver!: (chunk: AgentMuxHostedTransferChunk) => void
  const dispose = vi.fn(async () => {})
  const calls: string[] = []
  const port = {
    call: async (method: string) => {
      calls.push(method)
      if (method === 'runtime.owner.identity') return { owner }
      if (method === 'runtime.release-consumer') return { released: true }
      if (method === 'runtime.invoke') return { value: { hostId: 'local', subjects: [] } }
      throw Error('Unexpected operation: ' + method)
    },
    subscribe: async (method: string, _params: unknown, handlers: Parameters<AgentMuxHostedRpcPort['subscribe']>[2]) => {
      if (method === 'runtime.events') {
        handlers.onInitial({ owner, transferId: 'bootstrap' })
        for (const data of hostedTransfer({ kind: 'initial', value: bootstrap }, 'bootstrap')) handlers.onEvent({ type: 'snapshot', data })
        return { dispose: async () => {} }
      }
      expect(['runtime.replay-watch', 'runtime.attachment-watch']).toContain(method)
      handlers.onInitial({ owner, transferId: 'original-transfer' })
      deliver = data => handlers.onEvent({ type: 'snapshot', data })
      handlers.signal?.addEventListener('abort', () => handlers.onEnd?.(new AgentMuxError('Original reader cancelled.', 'CONTROL_CANCELLED')), { once: true })
      return { dispose }
    }
  } as unknown as AgentMuxHostedRpcPort
  const client = await connectHostedAgentMux({ rpc: port })
  const start = async (mode: 'replay' | 'attachment' = 'replay') => {
    const opening = mode === 'replay' ? client.readRunReplay({ runId: 'original-run' }, 0, 'raw') : client.attachTerminal('original-run', 0, 'raw')
    let settled = false
    const result = opening.then(value => ({ value }), error => ({ error })).finally(() => { settled = true })
    // Drain only Promise jobs; no wall-clock progress is manufactured by the test.
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(deliver).toBeTypeOf('function')
    return { result, settled: () => settled, send: (chunk: AgentMuxHostedTransferChunk) => deliver(chunk) }
  }
  return { client, chunks, attachment, start, dispose, calls }
}

afterEach(() => vi.useRealTimers())
describe('Hosted Attachment progress belongs to the exact initial transfer', () => {
  it.each(['replay', 'attachment'] as const)('finishes an ordered %s after more than one minute while original bytes keep arriving', async mode => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const f = await fixture(), read = await f.start(mode)
    for (const chunk of f.chunks) { await vi.advanceTimersByTimeAsync(45_000); read.send(chunk) }
    const result = await read.result
    expect(result).toEqual({ value: f.attachment })
    expect(f.client.runtimeOwnerIdentity()?.runtimeId).toBe('original-runtime')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(f.calls.every(method => !/stop|restart|create/.test(method))).toBe(true)
    await f.client.dispose()
  })

  it('ends only the reader after one minute without any original transfer bytes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const f = await fixture(), read = await f.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await read.result).toMatchObject({ error: { code: 'CONTROL_TIMEOUT' } })
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.client.runtimeOwnerIdentity()?.availability).toBe('connected')
    await f.client.dispose()
  })

  it('does not let empty ordered frames renew the last real progress', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const f = await fixture(), read = await f.start()
    await vi.advanceTimersByTimeAsync(20_000); read.send(f.chunks[0]!)
    await vi.advanceTimersByTimeAsync(35_000); read.send({ transferId: 'original-transfer', index: 1, dataBase64: '', final: false })
    await vi.advanceTimersByTimeAsync(25_000)
    expect(read.settled(), 'Empty frames must not keep the original wait pending').toBe(true)
    expect(await read.result).toMatchObject({ error: { code: 'CONTROL_TIMEOUT' } })
    await f.client.dispose()
  })

  it.each(['repeat', 'foreign', 'malformed'] as const)('rejects a %s frame without renewing or replacing the Run', async kind => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const f = await fixture(), read = await f.start()
    read.send(f.chunks[0]!)
    await vi.advanceTimersByTimeAsync(55_000)
    read.send(kind === 'repeat' ? f.chunks[0]! : { ...f.chunks[1]!, ...(kind === 'foreign' ? { transferId: 'other-transfer' } : { dataBase64: 'not-base64' }) })
    expect(await read.result).toMatchObject({ error: { code: 'CONTROL_PROTOCOL_ERROR' } })
    expect(f.dispose).toHaveBeenCalledOnce()
    expect(f.client.runtimeOwnerIdentity()?.runtimeId).toBe('original-runtime')
    await f.client.dispose()
  })

  it('uses monotonic progress when the wall clock jumps forward', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const f = await fixture(), read = await f.start()
    await vi.advanceTimersByTimeAsync(40_000); read.send(f.chunks[0]!)
    vi.setSystemTime(Date.now() + 24 * 60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(30_000)
    for (const chunk of f.chunks.slice(1)) read.send(chunk)
    expect(await read.result).toEqual({ value: f.attachment })
    await f.client.dispose()
  })

  it('cancels the original slow observation while keeping its Runtime identity', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const f = await fixture(), read = await f.start()
    read.send(f.chunks[0]!)
    await f.client.dispose()
    expect(await read.result).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
    expect(f.dispose).toHaveBeenCalledOnce()
  })
})
