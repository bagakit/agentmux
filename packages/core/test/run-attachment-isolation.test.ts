import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CtxmuxClient, CtxmuxProtocolError, CtxmuxRuntimeIdentityMismatchError } from '@ctxmux/sdk'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { attachmentFixture, AttachmentStream, bytes, output } from './helpers/run-attachment-fixture.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'
import type { AgentMuxClientEvent } from '../src/types.js'
const liveness = vi.hoisted(() => vi.fn(async () => 'alive' as 'alive' | 'dead' | 'unknown'))
vi.mock('../src/socket-liveness.js', () => ({ probeSocketLiveness: liveness }))
const fixtures: Array<Awaited<ReturnType<typeof attachmentFixture>>> = []
async function fixture() { const value = await attachmentFixture(); fixtures.push(value); return value }
beforeEach(() => { liveness.mockReset(); liveness.mockResolvedValue('alive') })
afterEach(async () => { for (const value of fixtures.splice(0)) await value.close(); vi.restoreAllMocks() })
const observations = (events: AgentMuxClientEvent[]) => events.filter(event => event.type === 'attachment-state')

describe('Core to Native Attachment fault isolation', () => {
  it.each(['throw', 'eof'] as const)('keeps both original inputs and neighbour output after one reader %s', async ending => {
    const h = await fixture()
    await h.core.attachTerminal('run-a'); await h.core.attachTerminal('run-b')
    h.append('run-a', bytes('first')); await vi.waitFor(() => expect(h.adapter.continuationByte('run-a')).toBe(5))
    h.latest('run-a').end(ending === 'throw' ? new Error('only original reader failed') : undefined)
    await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    expect(observations(h.events)[0]).toMatchObject({ state: 'unavailable', run: { runId: 'run-a' }, afterByte: 5 })
    expect(h.adapter.hasAttachment('run-a')).toBe(false); expect(h.adapter.hasAttachment('run-b')).toBe(true)
    expect(h.adapter.isConnected()).toBe(true); expect(h.lost).not.toHaveBeenCalled(); expect(liveness).not.toHaveBeenCalled()
    expect(h.errors).not.toHaveBeenCalled()
    for (const runId of ['run-a', 'run-b']) await expect(h.core.writeTerminal({ runId }, {
      ownerInstanceId: '11111111-1111-4111-8111-111111111111', operationId: 'original-input-' + runId, expectedByte: 0, data: 'x'
    })).resolves.toMatchObject({ runId, acceptedThroughByte: 1 })
    h.append('run-b', bytes('neighbour-live'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', run: { runId: 'run-b' }, data: 'neighbour-live' })))
    expect(h.events.some(event => event.type === 'connection-state' || event.type === 'agent-error')).toBe(false)
    expect(h.sdk.list).not.toHaveBeenCalled(); expect(h.sdk.status).not.toHaveBeenCalled()
  })

  it('preserves exact raw cursor, suffix and UTF-8 carry across a failed and successful refresh', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    const first = Uint8Array.from([0x41, 0xe4, 0xb8])
    h.append('run-a', first)
    await vi.waitFor(() => expect(h.adapter.continuationByte('run-a')).toBe(3))
    h.latest('run-a').end(new Error('private stream failed'))
    await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    h.runs.get('run-a')!.latest = 7
    h.runs.get('run-a')!.replay.push(output(3, Uint8Array.from([0xad, 0xf0, 0x9f, 0x98])))
    const failed = await h.adapter.attach('run-a', 3, () => { throw new Error('exact snapshot refused') }, 'raw', true).catch(error => error)
    expect(failed.message).toBe('exact snapshot refused')
    expect(h.adapter.continuationByte('run-a')).toBe(3)
    const fresh = await h.core.refreshRunAttachment({ runId: 'run-a' }, 3, 'raw', 'original-refresh')
    expect(fresh.replay.map(value => value.data)).toEqual(['中'])
    expect(Buffer.concat(fresh.replay.map(value => Buffer.from(value.dataBytes)))).toEqual(Buffer.from([0xad, 0xf0, 0x9f, 0x98]))
    h.append('run-a', Uint8Array.from([0x80, 0x42]))
    await vi.waitFor(() => expect(h.events.filter(event => event.type === 'terminal-output').at(-1)).toMatchObject({ data: '😀B' }))
    expect(observations(h.events).map(event => event.state)).toEqual(['unavailable', 'restored'])
    expect(h.sdk.attach.mock.calls.map(call => call.slice(0, 2))).toEqual([['run-a', 0], ['run-a', 3], ['run-a', 3]])
    expect(h.events.filter(event => event.type === 'terminal-output').map(event => event.data).join('')).toBe('A😀B')
  })

  it.each(['中', '😀', '\ufeff', 'A\ufeff'])( 'does not repeat complete published text or lose an initial/interior BOM (%s)', async text => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    const encoded = bytes(text)
    for (const value of encoded) {
      h.append('run-a', Uint8Array.of(value))
      await vi.waitFor(() => expect(h.adapter.continuationByte('run-a')).toBe(h.runs.get('run-a')!.latest))
    }
    h.latest('run-a').end(); await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    const result = await h.core.refreshRunAttachment({ runId: 'run-a' }, encoded.byteLength)
    expect(result.replay).toEqual([])
    h.append('run-a', bytes('Z'))
    await vi.waitFor(() => expect(h.events.filter(event => event.type === 'terminal-output').at(-1)).toMatchObject({ data: 'Z' }))
    expect(h.events.filter(event => event.type === 'terminal-output').map(event => event.data).join('')).toBe(text === '\ufeff' ? 'Z' : text + 'Z')
  })

  it('reports a genuine replay Gap and keeps the original terminal representation', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a', 0, 'terminal')
    h.latest('run-a').end(); await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    expect(h.adapter.continuationView('run-a')).toBe('terminal')
    h.runs.get('run-a')!.latest = 50; h.runs.get('run-a')!.first = 20
    const fresh = await h.core.refreshRunAttachment({ runId: 'run-a' }, 0, 'terminal')
    expect(fresh.terminal).toMatchObject({ type: 'basic-vt', checkpoint: { throughByte: 50, resizeRevision: 3 } })
    expect(h.sdk.attachTerminal.mock.calls.map(call => call.slice(0, 2))).toEqual([['run-a', 0], ['run-a', 0]])
    expect(h.sdk.attach).not.toHaveBeenCalled()
    // A terminal checkpoint covers its original history; raw requests still expose missing bytes.
    await h.core.releaseRunAttachment({ runId: 'run-a' })
    const raw = await h.core.attachTerminal('run-a', 0)
    expect(raw.gap).toEqual({ requestedAfterByte: 0, firstAvailableByte: 20 })
  })

  it('keeps a failed refresh visible without an automatic retry loop', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a'); await h.core.attachTerminal('run-b')
    h.latest('run-a').end(); await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    h.sdk.attach.mockRejectedValueOnce(new Error('original registration not yet available'))
    await expect(h.core.refreshRunAttachment({ runId: 'run-a' })).rejects.toThrow('original registration not yet available')
    await new Promise(resolve => setImmediate(resolve))
    expect(h.sdk.attach).toHaveBeenCalledTimes(3)
    expect(observations(h.events).map(event => event.state)).toEqual(['unavailable'])
    h.append('run-b', bytes('unrelated-success'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', run: { runId: 'run-b' } })))
    expect(observations(h.events).map(event => event.state)).toEqual(['unavailable'])
    await h.core.refreshRunAttachment({ runId: 'run-a' })
    expect(observations(h.events).map(event => event.state)).toEqual(['unavailable', 'restored'])
  })

  it('does not restore after the newly opened stream itself failed during predecessor release', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a'); await h.core.attachTerminal('run-b')
    h.latest('run-a').end(); await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    const fresh = h.sdk.attach.getMockImplementation()!
    h.sdk.attach.mockImplementationOnce(async (...args) => { const value = await fresh(...args); h.latest('run-a').end(); return value })
    await h.core.refreshRunAttachment({ runId: 'run-a' })
    await vi.waitFor(() => expect(observations(h.events).filter(event => event.state === 'unavailable')).toHaveLength(2))
    expect(h.adapter.hasAttachment('run-a')).toBe(false)
    expect(observations(h.events).at(-1)?.state).toBe('unavailable')
  })

  it.each(['detach', 'disconnect', 'replace'] as const)('discards an opening that became stale through %s', async action => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    const nativeOpen = h.sdk.attach.getMockImplementation()!
    let release!: (value: Awaited<ReturnType<typeof nativeOpen>>) => void
    let opened!: Awaited<ReturnType<typeof nativeOpen>>
    h.sdk.attach.mockImplementationOnce(async (...args) => {
      opened = await nativeOpen(...args)
      return await new Promise(resolve => { release = resolve })
    })
    const old = h.core.refreshRunAttachment({ runId: 'run-a' }).then(value => ({ value }), error => ({ error }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    if (action === 'detach') await h.core.releaseRunAttachment({ runId: 'run-a' })
    else if (action === 'disconnect') h.adapter.resetConnection()
    else await h.core.refreshRunAttachment({ runId: 'run-a' })
    release(opened)
    expect(await old).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
    expect(opened.close).toHaveBeenCalledOnce()
    expect(h.adapter.hasAttachment('run-a')).toBe(action === 'replace')
    if (action === 'replace') {
      h.latest('run-a').push({ type: 'output', chunk: output(0, bytes('new-owner')) })
      await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'new-owner' })))
    }
    expect(observations(h.events)).toEqual([]); expect(h.lost).not.toHaveBeenCalled()
  })

  it('ignores stale output and a late old failure after a valid replacement', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    const old = h.latest('run-a'); old.detach.mockImplementationOnce(async () => {})
    await h.core.refreshRunAttachment({ runId: 'run-a' })
    old.push({ type: 'output', chunk: output(0, bytes('old')) }); old.end(new Error('old failure'))
    h.append('run-a', bytes('new'))
    await vi.waitFor(() => expect(h.events.filter(event => event.type === 'terminal-output').map(event => event.data)).toEqual(['new']))
    expect(observations(h.events)).toEqual([]); expect(h.lost).not.toHaveBeenCalled()
    expect(h.adapter.hasAttachment('run-a')).toBe(true)
  })

  it.each(['exit', 'detach'] as const)('keeps normal %s distinct from a failed observer', async ending => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    if (ending === 'exit') h.latest('run-a').push({ type: 'exited', state: { type: 'exited', code: 0, signal: null } })
    else await h.core.releaseRunAttachment({ runId: 'run-a' })
    await vi.waitFor(() => expect(h.adapter.hasAttachment('run-a')).toBe(false))
    expect(h.adapter.isConnected()).toBe(true); expect(observations(h.events)).toEqual([])
    expect(h.lost).not.toHaveBeenCalled(); expect(liveness).not.toHaveBeenCalled()
  })

  it('keeps an independent screen observer healthy when the last mapped reader fails and refresh cannot connect', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    const seen: unknown[] = []
    const independent = await h.adapter.observeOutput('run-b', 0, event => { seen.push(event) })
    try {
      h.latest('run-a').end(); await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
      h.sdk.attach.mockRejectedValueOnce(Object.assign(new Error('private entry point absent'), { code: 'ENOENT' }))
      await expect(h.core.refreshRunAttachment({ runId: 'run-a' })).rejects.toThrow('private entry point absent')
      h.append('run-b', bytes('screen-still-live'))
      await vi.waitFor(() => expect(seen).toContainEqual(expect.objectContaining({ type: 'data', data: 'screen-still-live' })))
      expect(h.adapter.isConnected()).toBe(true); expect(h.lost).not.toHaveBeenCalled()
      expect(liveness).not.toHaveBeenCalled()
      await expect(h.core.writeTerminal({ runId: 'run-a' }, { ownerInstanceId: '11111111-1111-4111-8111-111111111111', operationId: 'same-original-input',
        expectedByte: 0, data: 'x' })).resolves.toMatchObject({ acceptedThroughByte: 1 })
    } finally { await independent.close() }
  })

  it('retains all unavailable readers without manufacturing Runtime death from observation alone', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a'); await h.core.attachTerminal('run-b')
    h.latest('run-a').end(); h.latest('run-b').end(new Error('other observer also ended'))
    await vi.waitFor(() => expect(observations(h.events)).toHaveLength(2))
    expect(h.adapter.isConnected()).toBe(true); expect(h.lost).not.toHaveBeenCalled()
    expect(liveness).not.toHaveBeenCalled()
    await h.core.refreshRunAttachment({ runId: 'run-a' })
    expect(observations(h.events).map(event => event.state)).toEqual(['unavailable', 'unavailable', 'restored'])
  })

  it('requests endpoint reconfirmation on identity mismatch without closing a healthy neighbour', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a'); await h.core.attachTerminal('run-b')
    h.latest('run-a').end(); await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    const original = h.adapterInner.runtime!
    h.sdk.attach.mockRejectedValueOnce(new CtxmuxRuntimeIdentityMismatchError(original, { ...original, daemonInstanceId: '33333333-3333-4333-8333-333333333333' }))
    await expect(h.core.refreshRunAttachment({ runId: 'run-a' })).rejects.toThrow('does not match expected')
    expect(h.lost).not.toHaveBeenCalled(); expect(h.adapter.isConnected()).toBe(true)
    expect(h.adapter.hasAttachment('run-b')).toBe(true)
    expect(h.endpoints).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-a' }))
    expect(h.endpoints).toHaveBeenCalledTimes(2)
    h.append('run-b', bytes('old-native-neighbour'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'old-native-neighbour' })))
  })

  it('does not let a stale opening identity mismatch invalidate a newer Runtime client', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    let reject!: (error: Error) => void
    h.sdk.attach.mockImplementationOnce(async () => await new Promise((_resolve, fail) => { reject = fail }))
    const old = h.core.refreshRunAttachment({ runId: 'run-a' }).catch(error => error)
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    const original = h.adapterInner.runtime!
    h.adapter.resetConnection(); h.adapterInner.client = { ...h.sdk }
    reject(new CtxmuxRuntimeIdentityMismatchError(original, { ...original, daemonInstanceId: '77777777-7777-4777-8777-777777777777' }))
    await old
    expect(h.adapter.isConnected()).toBe(true); expect(h.lost).not.toHaveBeenCalled()
    expect(h.endpoints).not.toHaveBeenCalled()
  })

  it('reuses the existing recovery lane to reconfirm the endpoint without all-Session recovery', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a'); await h.core.attachTerminal('run-b')
    const runtime = h.adapterInner.runtime!, epoch = h.inner.connectionEpoch
    const foreground = vi.spyOn(CtxmuxClient.prototype, 'observeForeground')
      .mockRejectedValueOnce(Object.assign(new Error('original listener temporarily absent'), { code: 'ENOENT' }))
      .mockResolvedValue({ runtime, observation: { type: 'unsupported' } } as never)
    h.wireRecovery(); h.latest('run-a').end()
    await vi.waitFor(() => expect(foreground).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(h.inner.reconnectController).toBeNull())
    expect(h.events.filter(event => event.type === 'connection-state')).toEqual([])
    expect(foreground).toHaveBeenCalledTimes(2)
    expect(foreground).toHaveBeenNthCalledWith(1, { runId: 'run-a' })
    expect(h.inner.connectionEpoch).toBe(epoch); expect(h.inner.connected).toBe(true)
    expect(h.adapterInner.client).toBe(h.sdk)
    expect(h.sdk.list).not.toHaveBeenCalled(); expect(h.sdk.status).not.toHaveBeenCalled()
    expect(observations(h.events).map(event => event.state)).toEqual(['unavailable'])
    h.append('run-b', bytes('healthy-after-endpoint-recovery'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'healthy-after-endpoint-recovery' })))
    await h.core.refreshRunAttachment({ runId: 'run-a' })
    expect(observations(h.events).map(event => event.state)).toEqual(['unavailable', 'restored'])
  })

  it('keeps endpoint retry cancellable and ignores a late same-lineage replacement after disconnect', async () => {
    const h = await fixture(), runtime = h.adapterInner.runtime!
    await h.core.attachTerminal('run-a')
    let release!: (value: unknown) => void
    vi.spyOn(CtxmuxClient.prototype, 'observeForeground').mockImplementationOnce(async () => await new Promise(resolve => { release = resolve as never }))
    h.wireRecovery(); h.latest('run-a').end()
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    h.core.disconnect()
    release({ runtime: { ...runtime, daemonInstanceId: '66666666-6666-4666-8666-666666666666' }, observation: { type: 'unknown' } })
    await new Promise(resolve => setImmediate(resolve))
    expect(h.adapter.isConnected()).toBe(false)
    expect(h.events.filter(event => event.type === 'connection-state')).toEqual([])
  })

  it('pins re-observation to the original durable Runtime even if another listener is compatible', async () => {
    const h = await fixture(), runtime = h.adapterInner.runtime!
    await h.core.attachTerminal('run-b')
    vi.spyOn(CtxmuxClient.prototype, 'observeForeground').mockRejectedValueOnce(new CtxmuxRuntimeIdentityMismatchError(runtime,
      { ...runtime, runtimeId: '44444444-4444-4444-8444-444444444444', daemonInstanceId: '55555555-5555-4555-8555-555555555555' }))
    await expect(h.adapter.reobserveConnection('run-a')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    expect(h.adapterInner.client).toBe(h.sdk); expect(h.adapterInner.runtime).toBe(runtime)
    h.append('run-b', bytes('original-runtime-still-live'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'original-runtime-still-live' })))
  })

  it('accepts a same-lineage replacement identity without closing old readers', async () => {
    const h = await fixture(), runtime = h.adapterInner.runtime!
    await h.core.attachTerminal('run-b')
    vi.spyOn(CtxmuxClient.prototype, 'observeForeground').mockRejectedValueOnce(new CtxmuxRuntimeIdentityMismatchError(runtime,
      { ...runtime, daemonInstanceId: '33333333-3333-4333-8333-333333333333' }))
    await h.adapter.reobserveConnection('run-a')
    expect(h.adapter.identity().daemonInstanceId).toBe('33333333-3333-4333-8333-333333333333')
    expect(h.adapter.hasAttachment('run-b')).toBe(true)
    h.append('run-b', bytes('already-established-reader'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'already-established-reader' })))
    expect(h.lost).not.toHaveBeenCalled()
  })

  it('does not require a still-retained Run or supported foreground observation to reconfirm the pinned endpoint', async () => {
    const h = await fixture(), runtime = h.adapterInner.runtime!
    const foreground = vi.spyOn(CtxmuxClient.prototype, 'observeForeground')
      .mockRejectedValueOnce(new CtxmuxProtocolError('run_not_found', 'original Run was already removed'))
      .mockResolvedValueOnce({ runtime, observation: { type: 'unsupported' } } as never)
    await h.adapter.reobserveConnection('original-gone-run')
    await h.adapter.reobserveConnection('original-unsupported-run')
    expect(h.adapterInner.client).toBe(h.sdk); expect(h.adapter.identity().daemonInstanceId).toBe('11111111-1111-4111-8111-111111111111')
    expect(foreground).toHaveBeenCalledTimes(2)
  })

  it('joins an already-owned global recovery attempt without dropping its pending exact endpoint fact', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    const pending = h.inner as unknown as { reconnectEndpoint?: { runId: string; only: boolean };
      reconnectAttempt(epoch: number, signal: AbortSignal, endpointOnly: boolean): Promise<void>; connectOnce(epoch: number): Promise<void> }
    h.inner.reconnectController = new AbortController()
    const connect = vi.spyOn(pending, 'connectOnce').mockResolvedValue()
    const foreground = vi.spyOn(CtxmuxClient.prototype, 'observeForeground').mockResolvedValue({
      runtime: h.adapterInner.runtime!, observation: { type: 'unknown' }
    } as never)
    h.wireRecovery(); h.latest('run-a').end()
    await vi.waitFor(() => expect(pending.reconnectEndpoint).toMatchObject({ runId: 'run-a', only: false }))
    await pending.reconnectAttempt(h.inner.connectionEpoch, h.inner.reconnectController.signal, false)
    expect(foreground).toHaveBeenCalledOnce(); expect(connect).toHaveBeenCalledOnce()
    expect(pending.reconnectEndpoint).toBeUndefined()
  })

  it('lets an explicit original connect reach activation instead of remaining in a read-only endpoint retry', async () => {
    const h = await fixture()
    const pending = h.inner as unknown as { reconnectEndpoint?: { runId: string; error: Error; only: boolean } }
    pending.reconnectEndpoint = { runId: 'run-a', error: new Error('adopted endpoint absent'), only: true }
    h.inner.reconnectController = new AbortController()
    const connect = vi.spyOn(h.adapter, 'connect').mockResolvedValue()
    const readOnly = vi.spyOn(h.adapter, 'reobserveConnection').mockRejectedValue(new Error('no listener'))
    expect(await h.core.connect().catch(error => error)).toBeUndefined()
    expect(connect).toHaveBeenCalledExactlyOnceWith({ refreshEndpointForRun: 'run-a' })
    expect(readOnly).not.toHaveBeenCalled()
    expect(h.events.filter(event => event.type === 'connection-state')).toEqual([])
  })

  it('confirms an explicit endpoint in place without replacing healthy readers or the same Native client', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-b')
    await mkdir(dirname(h.adapter.socketPath), { recursive: true, mode: 0o700 })
    const current = h.adapterInner.runtime!
    const observed = vi.spyOn(CtxmuxClient.prototype, 'observeForeground').mockResolvedValue({ runtime: current, observation: { type: 'unknown' } } as never)
    await h.adapter.connect({ refreshEndpointForRun: 'run-a' })
    expect(observed).toHaveBeenCalledExactlyOnceWith({ runId: 'run-a' })
    expect(h.adapterInner.client).toBe(h.sdk)
    expect(h.adapter.hasAttachment('run-b')).toBe(true)
    h.append('run-b', bytes('healthy-explicit-reconnect'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'healthy-explicit-reconnect' })))
  })

  it('rejects a foreign explicit endpoint without changing original identity, ownership or readers', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-b')
    await mkdir(dirname(h.adapter.socketPath), { recursive: true, mode: 0o700 })
    const original = h.adapterInner.runtime!
    vi.spyOn(CtxmuxClient.prototype, 'observeForeground').mockResolvedValue({ runtime: { ...original,
      runtimeId: '44444444-4444-4444-8444-444444444444' }, observation: { type: 'unknown' } } as never)
    expect(await h.adapter.connect({ refreshEndpointForRun: 'run-a' }).catch(error => error)).toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
    expect(h.adapterInner.client).toBe(h.sdk); expect(h.adapterInner.runtime).toBe(original)
    expect(h.adapter.hasAttachment('run-b')).toBe(true)
  })

  it('ignores an explicit endpoint confirmation superseded by a newer connection generation', async () => {
    const h = await fixture(), original = h.adapterInner.runtime!
    await mkdir(dirname(h.adapter.socketPath), { recursive: true, mode: 0o700 })
    let release!: (value: typeof original) => void
    vi.spyOn(CtxmuxClient.prototype, 'observeForeground').mockImplementationOnce(async () => await new Promise(resolve => { release = value => resolve({ runtime: value } as never) }))
    const pending = h.adapter.connect({ refreshEndpointForRun: 'run-a' }).catch(error => error)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    h.adapter.resetConnection(); h.adapterInner.client = { ...h.sdk }
    release(original)
    expect(await pending).toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(h.adapterInner.client).not.toBe(h.sdk); expect(h.adapter.isConnected()).toBe(true)
  })

  it('ends a stalled explicit endpoint observation and closes its real SDK socket without revoking healthy input', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-b')
    await mkdir(dirname(h.adapter.socketPath), { recursive: true, mode: 0o700 })
    const sockets = new Set<Socket>(), closed = vi.fn()
    const server = createServer(socket => { sockets.add(socket); socket.resume(); socket.once('close', () => { sockets.delete(socket); closed() }) })
    server.listen(h.adapter.socketPath); await once(server, 'listening')
    const unbounded = vi.spyOn(CtxmuxClient.prototype, 'runtimeInfo').mockRejectedValue(new Error('unbounded endpoint observation'))
    try {
      const result = await h.adapter.connect({ refreshEndpointForRun: 'run-a' }).catch(error => error)
      expect(result).toBeInstanceOf(Error)
      expect(unbounded).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
      expect(sockets.size).toBe(0)
      expect(liveness).toHaveBeenCalledExactlyOnceWith(h.adapter.socketPath)
      expect(h.adapterInner.client).toBe(h.sdk); expect(h.adapter.hasAttachment('run-b')).toBe(true)
      await expect(h.core.writeTerminal({ runId: 'run-b' }, { ownerInstanceId: h.adapterInner.runtime!.daemonInstanceId,
        operationId: 'same-input-after-stalled-endpoint', expectedByte: 0, data: 'x' })).resolves.toMatchObject({ acceptedThroughByte: 1 })
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('takes the exact successful Attachment cut owner after Native identity changes during acquisition', async () => {
    const h = await fixture(), hosted = await hostedTestClient(h.core), old = h.adapterInner.runtime!
    try {
      const acquire = h.core.refreshRunAttachment.bind(h.core)
      vi.spyOn(h.core, 'refreshRunAttachment').mockImplementationOnce(async (...args) => {
        h.adapterInner.runtime = { ...old, daemonInstanceId: '33333333-3333-4333-8333-333333333333' }
        return await acquire(...args)
      })
      await hosted.sdk.attachTerminal('run-a')
      expect(hosted.sdk.runtimeIdentity().instanceId).toBe('33333333-3333-4333-8333-333333333333')
    } finally { await hosted.dispose() }
  })

  it('never moves the current Native input fence backward when another Run initial receipt arrives late', async () => {
    const h = await fixture(), hosted = await hostedTestClient(h.core), original = hosted.port.subscribe.bind(hosted.port)
    try {
      let release!: () => void
      hosted.port.subscribe = (async (...[method, params, handlers]: Parameters<typeof hosted.port.subscribe>) => {
        if (method !== 'runtime.attachment-watch' || (params as { target?: { runId?: string } }).target?.runId !== 'run-a') return await original(method, params, handlers)
        let initial!: Parameters<typeof handlers.onInitial>[0]
        const events: Parameters<typeof handlers.onEvent>[0][] = []
        const watch = await original<'runtime.attachment-watch'>(method, params as import('../src/hosted-client-contract.js').AgentMuxHostedRuntimeParameterMap['runtime.attachment-watch'],
          { ...handlers, onInitial: value => { initial = value }, onEvent: value => { events.push(value) } })
        release = () => { handlers.onInitial(initial); for (const event of events) handlers.onEvent(event) }
        return watch
      }) as typeof hosted.port.subscribe
      const first = hosted.sdk.attachTerminal('run-a')
      await vi.waitFor(() => expect(release).toBeTypeOf('function'))
      h.adapterInner.runtime = { ...h.adapterInner.runtime!, daemonInstanceId: '33333333-3333-4333-8333-333333333333' }
      await hosted.sdk.attachTerminal('run-b')
      expect(hosted.sdk.runtimeIdentity().instanceId).toBe('33333333-3333-4333-8333-333333333333')
      release(); await first
      expect(hosted.sdk.runtimeIdentity().instanceId).toBe('33333333-3333-4333-8333-333333333333')
      expect(h.adapter.hasAttachment('run-a')).toBe(true)
    } finally { await hosted.dispose() }
  })

  it('rejects a foreign semantic initial owner without changing the confirmed Native input fence', async () => {
    const h = await fixture(), hosted = await hostedTestClient(h.core), original = hosted.port.subscribe.bind(hosted.port)
    try {
      const native = hosted.sdk.runtimeIdentity().instanceId
      hosted.port.subscribe = (async (...[method, params, handlers]: Parameters<typeof hosted.port.subscribe>) => await original(method, params,
        method !== 'runtime.attachment-watch' ? handlers : { ...handlers,
          onInitial: value => {
            const initial = value as unknown as { owner: import('../src/hosted-client-contract.js').AgentMuxRuntimeOwnerIdentity; transferId: string }
            handlers.onInitial({ ...initial, owner: { ...initial.owner, ownerInstanceId: 'foreign-semantic-owner' } } as never)
          }
        })) as typeof hosted.port.subscribe
      await expect(hosted.sdk.attachTerminal('run-a')).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
      expect(hosted.sdk.runtimeIdentity().instanceId).toBe(native)
    } finally { await hosted.dispose() }
  })

  it('keeps a pumped owner when synchronous publication starts a later refresh which then fails', async () => {
    const h = await fixture()
    let later!: Promise<unknown>
    const originalOpen = h.sdk.attach.getMockImplementation()!
    h.sdk.attach.mockImplementationOnce(originalOpen).mockRejectedValueOnce(new Error('later registration failed'))
    const first = h.adapter.attach('run-a', 0, () => {
      later = h.core.refreshRunAttachment({ runId: 'run-a' }).catch(error => error)
    }).catch(error => error)
    expect((await first).code).toBe('CONTROL_CANCELLED')
    expect((await later as Error).message).toBe('later registration failed')
    h.append('run-a', bytes('original-pump-still-live'))
    await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'original-pump-still-live' })))
    expect(h.adapter.hasAttachment('run-a')).toBe(true)
    expect(observations(h.events)).toEqual([])
  })

  it('does not notify a new connection generation from a synchronously replaced failure publication', async () => {
    const h = await fixture(); await h.core.attachTerminal('run-a')
    h.core.onEvent(event => {
      if (event.type === 'attachment-state' && event.state === 'unavailable') {
        h.adapter.resetConnection(); h.adapterInner.client = { ...h.sdk }
      }
    })
    h.latest('run-a').end()
    await vi.waitFor(() => expect(observations(h.events)).toHaveLength(1))
    expect(h.endpoints).not.toHaveBeenCalled()
    expect(h.adapter.isConnected()).toBe(true)
  })

  it('delivers native reader faults through the production Hosted codec only to the matching Run reader', async () => {
    const h = await fixture()
    // The real hosted initial projection reads the deterministic SDK port; no Runtime is launched.
    const hosted = await hostedTestClient(h.core)
    try {
      const events: AgentMuxClientEvent[] = []; hosted.sdk.onEvent(event => events.push(event))
      await hosted.sdk.attachTerminal('run-a'); await hosted.sdk.attachTerminal('run-b')
      h.latest('run-a').end(new Error('native-reader-only'))
      await vi.waitFor(() => expect(observations(events)).toHaveLength(1))
      expect(observations(events)[0]).toMatchObject({ state: 'unavailable', run: { runId: 'run-a' }, afterByte: 0,
        diagnostic: { message: expect.stringContaining('native-reader-only') } })
      expect(events.some(event => event.type === 'connection-state')).toBe(false)
      h.append('run-b', bytes('unaffected'))
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'terminal-output', data: 'unaffected' })))
      await hosted.sdk.refreshRunAttachment({ runId: 'run-a' }, 0)
      await vi.waitFor(() => expect(observations(events).map(event => event.state)).toEqual(['unavailable', 'restored']))
      expect(hosted.sdk.runtimeIdentity().instanceId).toBe('11111111-1111-4111-8111-111111111111')
    } finally { await hosted.dispose() }
  })
})
