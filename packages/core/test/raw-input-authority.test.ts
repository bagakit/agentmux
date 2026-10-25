import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { AgentMuxError } from '../src/errors.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { AgentMuxRpcService, type AgentMuxRpcCallContext } from '../src/public-rpc-service.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import { encodeHostedValue, decodeHostedValue } from '../src/hosted-value.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { DeviceAuthority } from '../../../apps/host/src/device-authority.js'
import { createMobileTerminalControl } from '../../../apps/mobile/src/terminal/control.js'
import type { AgentRawInputCallContext, AgentInputSubmissionReceipt } from '../src/agent-input-wait.js'
import type { AgentMuxHostedInvocation } from '../src/hosted-client-contract.js'
import type { AgentMuxRunInputOperation } from '../src/types.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private raw input fixture cleanup failed')
})
function barrier() {
  let resolve!: () => void, reject!: (reason: unknown) => void
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  cleanups.push(resolve)
  return { pending, resolve, reject }
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve))
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: null }), error => ({ value: null, error }))
const pasted = (text: string) => '\x1b[200~' + text + '\x1b[201~'

function nativeRequest(run: { runId: string }) {
  return { kind: 'permission' as const, id: 'original-permission', agentSessionId: 'recipient', title: 'Original request',
    nativeToolCallId: 'original-call', toolName: 'tool', toolInput: '{}',
    options: [{ id: 'allow', label: 'Allow', kind: 'allow-once' as const }],
    evidence: { source: 'native-hook' as const, observedAt: 1, run, hookReceiptId: 'original-receipt' } }
}

// Production Core/Store/Provider/public service/DeviceAuthority. Runtime byte I/O
// is controlled at its machine port; this does not claim vendor consumption.
async function fixture() {
  const h = await rpcOwnerFixture(); cleanups.push(h.close)
  let connected = true
  h.inner.kernel.isConnected = () => connected
  h.inner.kernel.connect = async () => { connected = true }
  h.inner.kernel.disconnect = () => { connected = false }
  for (const method of ['onEvent', 'onError', 'onConnectionLost', 'onConnectionAvailable']) h.inner.kernel[method] = () => () => {}
  const recoverableInput = h.inner.kernel.input as (id: string, operation: AgentMuxRunInputOperation) => Promise<{
    run: ReturnType<typeof h.run>; appliedByteRange: { startByte: number; endByte: number }
  }>
  type Write = AgentMuxRunInputOperation | { data: AgentMuxRunInputOperation['data'] }
  const rawInput = h.rawInput.getMockImplementation()!
  const native = (id: string, operation: Write) => 'operationId' in operation
    ? recoverableInput(id, operation)
    : rawInput(id, operation.data).then(ack => ({ run: h.run(id), ...ack }))
  const writes = vi.fn(native)
  h.inner.kernel.input = writes
  h.rawInput.mockImplementation((id, data) => writes(id, { data }))
  const original = h.client.agentSession('recipient'), run = original.run
  const owner = hostedTestOwner(h.client), fence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
  const hosted = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => owner)
  cleanups.push(() => hosted.dispose())
  const service = new AgentMuxRpcService({ coreClients: h.coreClients, hostedRuntime: () => hosted })
  cleanups.push(() => service.dispose())
  const authority = await DeviceAuthority.open(join(h.root, 'raw-devices.json')); cleanups.push(() => authority.flush())
  const publicKey = Buffer.alloc(32, 37).toString('base64'), device = await authority.authorizeKey(publicKey)
  const context: AgentMuxRpcCallContext = { principal: { kind: 'device', id: authority.hostId + ':' + device.deviceId },
    assertCurrent: () => authority.assertCurrentKey({ deviceId: device.deviceId, createdAt: device.createdAt }, publicKey) }
  const args = (kind: 'writeAgent' | 'pasteAgent' | 'writeTerminal', body = 'remote'): AgentMuxHostedInvocation => kind === 'writeTerminal'
    ? { method: kind, args: [run, { ownerInstanceId: 'fixture-runtime', operationId: 'terminal-' + body, expectedByte: h.run(run.runId).acceptedInputBytes!, data: body }] }
    : kind === 'pasteAgent' ? { method: kind, args: [{ agentSessionId: original.agentSessionId, expectedRun: run, text: body, terminalData: body }] }
    : { method: kind, args: [{ agentSessionId: original.agentSessionId, expectedRun: run, data: body, source: 'user' }] }
  const invoke = async (input: AgentMuxHostedInvocation, callContext: AgentMuxRpcCallContext = context) => decodeHostedValue((await service.call('runtime.invoke', {
    fence, consumerId: 'original-raw-consumer', invocation: encodeHostedValue(input) as AgentMuxHostedInvocation }, callContext)).value)
  const write = (data: string, callContext?: AgentRawInputCallContext) => h.client.writeAgent({ agentSessionId: original.agentSessionId, expectedRun: run, data, source: 'user' }, callContext)
  const bytes = () => writes.mock.calls.map(([, operation]) => operation.data)
  const typed = async (id: string) => await h.client.submitAgentPrompt({ agentSessionId: original.agentSessionId, expectedRun: run,
    operationId: id, prompt: id, admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true }) as AgentInputSubmissionReceipt
  const settled = async (receipt: AgentInputSubmissionReceipt) => {
    try { await expect.poll(async () => (await h.client.inspectAgentInput({ key: receipt.key }))?.status).toBe('terminal-confirmed') }
    catch { expect((await h.client.inspectAgentInput({ key: receipt.key }))?.status).toBe('terminal-confirmed') }
  }
  return { ...h, currentRun: h.run, native, writes, original, run, owner, fence, hosted, service, authority, device, context, args, invoke, write, bytes, typed, settled }
}

it.each(['writeAgent', 'pasteAgent', 'writeTerminal'] as const)('the actual public owner rejects revoked %s while local input stays usable', async kind => {
  const h = await fixture()
  await h.authority.revoke(h.device.deviceId)
  const result = await outcome(h.invoke(h.args(kind)))
  await h.write('local')
  expect(h.bytes()).toEqual(['local'])
  expect(result.error).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.client.agentSession('recipient').run).toEqual(h.run)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['writeAgent', 'pasteAgent', 'writeTerminal'] as const)('missing device authority remains unknown for %s and cannot write', async kind => {
  const h = await fixture(), result = await outcome(h.invoke(h.args(kind), { principal: h.context.principal! }))
  await h.write('healthy-local')
  expect(h.bytes()).toEqual(['healthy-local'])
  expect(result.error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['writeAgent', 'pasteAgent', 'writeTerminal'] as const)('wire arguments cannot supply %s trusted context', async kind => {
  const h = await fixture(), input = h.args(kind), dispatch = vi.spyOn(h.client, kind)
  const forged = { ...input, args: [...input.args, ...(kind === 'writeTerminal' ? [undefined] : []), { assertCurrent: {}, requestSignal: {} }] }
  const result = await outcome(h.invoke(forged as AgentMuxHostedInvocation))
  expect(dispatch).not.toHaveBeenCalled()
  expect(h.bytes()).toEqual([])
  expect(result.error).toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it.each(['writeAgent', 'pasteAgent'] as const)('rechecks queued %s after current Run observation and preserves the exact local suffix', async kind => {
  const h = await fixture(), entered = barrier(), release = barrier()
  const openInput = h.inner.kernel.openInput as (id: string) => Promise<{ run: ReturnType<typeof h.currentRun> }>
  h.inner.kernel.openInput = vi.fn(async (id: string) => { entered.resolve(); await release.pending; return openInput(id) })
  const pending = outcome(h.invoke(h.args(kind)))
  await entered.pending
  await h.authority.revoke(h.device.deviceId)
  release.resolve(); const result = await pending
  await h.write('local-suffix')
  expect(h.bytes()).toEqual(['local-suffix'])
  expect(result.error).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['writeAgent', 'pasteAgent'] as const)('a revoked %s waiting for native capacity cannot dispatch or block the local suffix', async kind => {
  const h = await fixture(), entered = barrier(), capacity = barrier(), ack = barrier()
  h.writes.mockImplementation(async (id, operation) => {
    const accepted = h.native(id, operation)
    if (operation.data === 'prior') { entered.resolve(); await ack.pending }
    return accepted
  })
  const prior = h.write('prior'); await entered.pending
  const waiting = barrier()
  h.waitWritable.mockImplementationOnce(async (_bytes, signal) => {
    waiting.resolve(); await capacity.pending; signal?.throwIfAborted()
  })
  const pending = outcome(h.invoke(h.args(kind)))
  await waiting.pending
  await h.authority.revoke(h.device.deviceId)
  const next = h.write('local-suffix')
  expect(h.bytes()).toEqual(['prior'])
  capacity.resolve(); const result = await pending; await next
  // Raw dispatch uses native capacity/order, independent from the prior ACK.
  expect(result.error).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.bytes()).toEqual(['prior', 'local-suffix'])
  ack.resolve(); await prior
  expect(h.client.agentSession('recipient').run).toEqual(h.run)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)('cancelled author observation releases its lane and late %s cannot write or preempt a later prompt', async late => {
  const h = await fixture(), entered = barrier(), held = barrier(), controller = new AbortController()
  const preempt = vi.spyOn(h.client as unknown as { cancelPromptRenderObservation(...args: unknown[]): void }, 'cancelPromptRenderObservation')
  const old = outcome(h.write('old', { requestSignal: controller.signal, assertCurrent: async () => { entered.resolve(); await held.pending } }))
  await entered.pending
  controller.abort(new AgentMuxError('Original request ended.', 'CONTROL_CANCELLED'))
  let nextDone = false
  const next = h.write('local-next').then(() => { nextDone = true })
  // A finite fallback releases a broken implementation but cannot make the
  // before-release business observations green.
  for (let n = 0; n < 8; n++) await checkpoint()
  const before = { bytes: h.bytes(), nextDone, preemptions: preempt.mock.calls.length }
  if (late === 'resolve') held.resolve(); else held.reject(new Error('Late original authority failure'))
  const result = await old; await next; await checkpoint()
  expect(before).toEqual({ bytes: ['local-next'], nextDone: true, preemptions: 1 })
  expect(h.bytes()).toEqual(['local-next'])
  expect(preempt).toHaveBeenCalledTimes(1)
  expect(result.error).toMatchObject({ code: 'CONTROL_CANCELLED' })
})

it('a denied original raw author cannot preempt a healthy local render observation', async () => {
  const h = await fixture()
  const preempt = vi.spyOn(h.client as unknown as { cancelPromptRenderObservation(...args: unknown[]): void }, 'cancelPromptRenderObservation')
  const result = await outcome(h.write('denied', { assertCurrent: () => { throw new AgentMuxError('Original author denied.', 'CONTROL_PERMISSION_DENIED') } }))
  const deniedPreemptions = preempt.mock.calls.length
  await h.write('healthy-local')
  expect(deniedPreemptions).toBe(0)
  expect(preempt).toHaveBeenCalledTimes(1)
  expect(result.error).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(h.bytes()).toEqual(['healthy-local'])
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('initial authority completion cannot reorder original raw bytes', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  let checks = 0
  const first = h.write('A', { assertCurrent: async () => { if (++checks === 1) { entered.resolve(); await held.pending } } })
  await entered.pending
  const secondAuthor = vi.fn(async () => {})
  const second = h.write('B', { assertCurrent: secondAuthor })
  await checkpoint(); const before = h.bytes()
  held.resolve(); await Promise.all([first, second])
  expect(before).toEqual([])
  expect(h.bytes()).toEqual(['A', 'B'])
  expect(checks).toBe(2)
  expect(secondAuthor).toHaveBeenCalledTimes(2)
})

it.each(['request', 'disconnect'] as const)('ending the original Terminal %s abandons held authority without affecting its healthy Run', async reason => {
  const h = await fixture(), entered = barrier(), held = barrier(), controller = new AbortController()
  const pending = outcome(h.invoke(h.args('writeTerminal'), { ...h.context, signal: controller.signal, assertCurrent: async () => {
    await h.context.assertCurrent!(); entered.resolve(); await held.pending
  } }))
  await entered.pending
  if (reason === 'request') controller.abort(new AgentMuxError('Original Terminal reader ended.', 'CONTROL_CANCELLED'))
  else { h.client.disconnect(); await h.client.connectRuntime() }
  let rejected = false
  const observing = pending.then(result => { rejected = result.error !== null; return result })
  await h.write('healthy-local')
  const before = { rejected, bytes: h.bytes() }
  held.resolve(); const result = await observing
  expect(before).toEqual({ rejected: true, bytes: ['healthy-local'] })
  expect(h.bytes()).toEqual(['healthy-local'])
  expect(result.error).toMatchObject({ code: reason === 'request' ? 'CONTROL_CANCELLED' : 'CTXMUX_DISCONNECTED' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['request', 'disconnect'] as const)('ending the original %s releases a held raw Run read without reviving it after reconnect', async reason => {
  const h = await fixture(), entered = barrier(), held = barrier(), controller = new AbortController()
  const openInput = h.inner.kernel.openInput as (id: string) => Promise<{ run: ReturnType<typeof h.currentRun> }>
  let first = true
  h.inner.kernel.openInput = async (id: string) => { if (first) { first = false; entered.resolve(); await held.pending }; return openInput(id) }
  const old = outcome(h.invoke(h.args('writeAgent', 'old'), { ...h.context, signal: controller.signal }))
  await entered.pending
  if (reason === 'request') controller.abort(new AgentMuxError('Request ended.', 'CONTROL_CANCELLED'))
  else { h.client.disconnect(); await h.client.connectRuntime() }
  let nextDone = false
  const next = h.write('local-next').then(() => { nextDone = true })
  for (let n = 0; n < 8; n++) await checkpoint()
  const before = { bytes: h.bytes(), nextDone }
  held.resolve(); const result = await old; await next
  expect(before).toEqual({ bytes: ['local-next'], nextDone: true })
  expect(h.bytes()).toEqual(['local-next'])
  expect(result.error).toMatchObject({ code: reason === 'request' ? 'CONTROL_CANCELLED' : 'CTXMUX_DISCONNECTED' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['ack', 'unknown'] as const)('disconnect preserves typed completion ordering while fresh raw bypasses a prior %s ACK', async result => {
  const h = await fixture(), entered = barrier(), held = barrier()
  h.writes.mockImplementation(async (id, operation) => {
    if (operation.data === 'in-flight') {
      const ack = await h.native(id, operation)
      entered.resolve(); await held.pending
      if (result === 'unknown') throw new AgentMuxError('Original ACK unavailable.', 'CTXMUX_CONNECTION_LOST')
      return ack
    }
    return h.native(id, operation)
  })
  const original = outcome(h.write('in-flight')); await entered.pending
  const authorEntered = barrier(), authorHeld = barrier()
  const stale = outcome(h.write('old-queued', { assertCurrent: async () => { authorEntered.resolve(); await authorHeld.pending } }))
  await authorEntered.pending
  h.client.disconnect(); await h.client.connectRuntime()
  const fresh = h.write('fresh')
  const typed = await h.typed('typed-after-reconnect')
  for (let n = 0; n < 8; n++) await checkpoint()
  const before = h.bytes()
  held.resolve(); const originalResult = await original, staleResult = await stale
  await fresh; await h.settled(typed)
  expect(before).toEqual(['in-flight', 'fresh'])
  expect(h.bytes()).toEqual(['in-flight', 'fresh', pasted('typed-after-reconnect'), '\r'])
  expect(staleResult.error).toMatchObject({ code: 'CTXMUX_DISCONNECTED' })
  if (result === 'ack') expect(originalResult.value).toMatchObject({ appliedByteRange: { startByte: 0, endByte: 9 } })
  else expect(originalResult.error).toMatchObject({ code: 'CTXMUX_CONNECTION_LOST' })
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('disconnect abandons the old typed pre-dispatch Run read and preserves new local input', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  const lanes = Reflect.get(h.client, 'agentInputLanes') as Map<string, { renderObservations: Set<unknown> }>
  const status = h.inner.kernel.status as (id: string) => Promise<ReturnType<typeof h.currentRun>>
  let armed = true
  h.inner.kernel.status = async (id: string) => {
    if (armed && lanes.get('recipient')?.renderObservations.size) { armed = false; entered.resolve(); await held.pending }
    return status(id)
  }
  const old = outcome(h.client.submitAgentPrompt({ ...agentPromptCondition(h.original), agentSessionId: 'recipient',
    expectedRun: h.run, operationId: 'typed-before-disconnect', prompt: 'old-typed' }))
  await entered.pending
  h.client.disconnect(); await h.client.connectRuntime()
  let nextDone = false
  const next = h.write('healthy-local').then(() => { nextDone = true })
  for (let n = 0; n < 12; n++) await checkpoint()
  const before = { nextDone, bytes: h.bytes() }
  held.resolve(); const result = await old; await next
  expect(before).toEqual({ nextDone: true, bytes: ['healthy-local'] })
  expect(result.error).toMatchObject({ code: 'CTXMUX_DISCONNECTED' })
  expect(h.bytes()).toEqual(['healthy-local'])
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['original', 'another-operation', 'another-request'] as const)('a final authorization refusal preserves the %s native-input identity', async identity => {
  const h = await fixture(), entered = barrier(), held = barrier()
  const stored = (await h.store.readMetadata('recipient'))!
  const request = nativeRequest(h.run)
  await h.store.compareAndSwapMetadata(stored, { ...stored, pendingInteraction: { request } })
  await h.inner.registry.load('local')
  const save = h.store.compareAndSwapMetadata.bind(h.store)
  vi.spyOn(h.store, 'compareAndSwapMetadata').mockImplementation(async (...args) => {
    const result = await save(...args)
    if (args[1]?.pendingInteraction?.nativeInput?.delivery === 'unknown') { entered.resolve(); await held.pending }
    return result
  })
  const pending = outcome(h.invoke(h.args('writeAgent')))
  await entered.pending
  const prepared = (await h.store.readMetadata('recipient'))!
  const retained = identity === 'original' ? { request } : { request: identity === 'another-request'
    ? { ...request, id: 'later-request', nativeToolCallId: 'later-call' } : request,
    nativeInput: { operationId: identity === 'another-operation' ? 'another-original-operation'
      : prepared.pendingInteraction!.nativeInput!.operationId, delivery: 'unknown' as const, observedAt: 2 } }
  if (identity !== 'original') {
    await save(prepared, { ...prepared, pendingInteraction: retained })
  }
  await h.authority.revoke(h.device.deviceId); held.resolve()
  const result = await pending
  expect(h.bytes()).toEqual([])
  expect(result.error).toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await h.store.readMetadata('recipient'))?.pendingInteraction).toEqual(retained)
  await h.write('local-after-refusal')
  expect(h.bytes()).toEqual(['local-after-refusal'])
})

it('a queued native-hook write owns fresh uncertainty after its prior input was not applied', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  const stored = (await h.store.readMetadata('recipient'))!, request = nativeRequest(h.run)
  await h.store.compareAndSwapMetadata(stored, { ...stored, pendingInteraction: { request } })
  await h.inner.registry.load('local')
  let secondMarker: { operationId: string; delivery: string } | undefined
  h.writes.mockImplementation(async (id, operation) => {
    if (operation.data === 'first') {
      entered.resolve(); await held.pending
      throw new AgentMuxError('Original input was not applied.', 'CTXMUX_INPUT_REJECTED', 'not_applied')
    }
    secondMarker = (await h.store.readMetadata('recipient'))?.pendingInteraction?.nativeInput
    return h.native(id, operation)
  })
  const first = outcome(h.write('first')); await entered.pending
  const originalMarker = (await h.store.readMetadata('recipient'))!.pendingInteraction!.nativeInput!
  expect(originalMarker.delivery).toBe('unknown')
  const second = h.write('second')
  for (let n = 0; n < 8; n++) await checkpoint()
  const before = { bytes: h.bytes(), marker: (await h.store.readMetadata('recipient'))!.pendingInteraction!.nativeInput }
  held.resolve(); const firstResult = await first; await second
  expect(before).toEqual({ bytes: ['first'], marker: originalMarker })
  expect(firstResult.error).toMatchObject({ code: 'CTXMUX_INPUT_REJECTED', detail: 'not_applied' })
  expect(secondMarker).toMatchObject({ delivery: 'unknown' })
  expect(secondMarker!.operationId).not.toBe(originalMarker.operationId)
  expect((await h.store.readMetadata('recipient'))!.pendingInteraction).toMatchObject({ request,
    nativeInput: { operationId: secondMarker!.operationId, delivery: 'accepted' } })
  expect(h.bytes()).toEqual(['first', 'second'])
  expect(h.rawInput).not.toHaveBeenCalled()
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the exact Session Run is rechecked after the final original authority read', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  let checks = 0
  const pending = outcome(h.invoke(h.args('writeAgent'), { ...h.context, assertCurrent: async () => {
    await h.context.assertCurrent!()
    if (++checks === 2) { entered.resolve(); await held.pending }
  } }))
  await entered.pending
  const stored = (await h.store.readMetadata('recipient'))!, nextRun = { runId: 'replacement-run' }
  await h.store.compareAndSwapMetadata(stored, { ...stored, run: nextRun })
  await h.inner.registry.load('local')
  held.resolve(); const result = await pending
  await h.client.writeAgent({ agentSessionId: 'recipient', expectedRun: nextRun, data: 'healthy-current', source: 'user' })
  expect(result.error).toMatchObject({ code: 'STALE_AGENT_SESSION' })
  expect(h.writes.mock.calls.map(([id, operation]) => [id, operation.data])).toEqual([['replacement-run', 'healthy-current']])
  expect(h.client.agentSession('recipient').run).toEqual(nextRun)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each((['writeAgent', 'pasteAgent', 'writeTerminal'] as const).flatMap(kind => (['ack', 'unknown'] as const).map(receipt => ({ kind, receipt }))))('reader cancellation after $kind native dispatch preserves its original $receipt without replay', async ({ kind, receipt }) => {
  const h = await fixture(), entered = barrier(), held = barrier(), controller = new AbortController()
  h.writes.mockImplementation(async (id, operation) => {
    const ack = await h.native(id, operation); entered.resolve(); await held.pending
    if (receipt === 'unknown') throw new AgentMuxError('Original native reply lost.', 'CTXMUX_CONNECTION_LOST')
    return ack
  })
  const pending = outcome(h.invoke(h.args(kind), { ...h.context, signal: controller.signal }))
  await entered.pending; controller.abort(new AgentMuxError('Reader ended after dispatch.', 'CONTROL_CANCELLED'))
  await h.authority.revoke(h.device.deviceId); held.resolve()
  const result = await pending
  const expected = kind === 'pasteAgent' ? pasted('remote') : 'remote', endByte = Buffer.byteLength(expected)
  expect(h.bytes()).toEqual([expected])
  if (receipt === 'ack') expect(result).toMatchObject({ error: null, value: { runId: h.run.runId, appliedByteRange: { startByte: 0, endByte }, acceptedThroughByte: endByte } })
  else expect(result.error).toMatchObject({ code: 'CTXMUX_CONNECTION_LOST' })
  h.writes.mockImplementation(h.native)
  await h.write('healthy-local')
  expect(h.bytes()).toEqual([expected, 'healthy-local'])
  expect(h.client.agentSession('recipient').run).toEqual(h.run)
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the actual Hosted SDK and Mobile controller preserve unknown bytes and send only a reviewed suffix', async () => {
  const h = await fixture(), entered = barrier(), held = barrier()
  const server = new AgentMuxControlServer({ coreClients: h.coreClients, hostedRuntime: () => h.hosted,
    socketPath: join(h.root, 'raw-mobile.sock'), http: { host: '127.0.0.1', port: 0,
      authorize: async () => ({ principal: h.context.principal!, assertCurrent: h.context.assertCurrent! }) } })
  cleanups.push(() => server.stop()); await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'http', url: `http://127.0.0.1:${server.httpAddress!.port}/`, token: 'original-device' } })
  cleanups.push(() => rpc.dispose())
  const client = await connectHostedAgentMux({ rpc }); cleanups.push(() => client.dispose())
  const storage = new Map<string, string>()
  const control = createMobileTerminalControl({ client, agentSessionId: 'recipient', report: () => {}, storage: () => ({
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value) }, removeItem: key => { storage.delete(key) }
  }) }); cleanups.push(() => control.dispose())
  h.writes.mockImplementation(async (id, operation) => {
    const ack = await h.native(id, operation)
    if (operation.data === 'uncertain') { entered.resolve(); await held.pending; throw new AgentMuxError('Lost native ACK.', 'CTXMUX_CONNECTION_LOST') }
    return ack
  })
  expect(control.enable()).toBe(true)
  control.send('uncertain', 'user'); control.send('suffix', 'user')
  await entered.pending; held.resolve()
  await expect.poll(() => control.facts().phase).toBe('unknown')
  expect(h.bytes()).toEqual(['uncertain'])
  expect(control.queuedText()).toBe('suffix')
  expect(control.continueAfterReview()).toBe(true); expect(control.enable()).toBe(true)
  await expect.poll(() => control.facts().phase).toBe('idle')
  expect(h.bytes()).toEqual(['uncertain', 'suffix'])
  // The third wire position remains optional diagnostic metadata, not authority.
  await client.writeTerminal(h.run, { ownerInstanceId: 'fixture-runtime', operationId: 'terminal-with-observation',
    expectedByte: h.currentRun(h.original.run.runId).acceptedInputBytes!, data: 'terminal' }, { observerId: 'original-observer', source: 'user', sequence: 1 })
  expect(h.bytes()).toEqual(['uncertain', 'suffix', 'terminal'])
  expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})
