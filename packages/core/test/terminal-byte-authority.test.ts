import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../src/errors.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxRpcService, type AgentMuxRpcCallContext } from '../src/public-rpc-service.js'
import { encodeHostedValue, decodeHostedValue } from '../src/hosted-value.js'
import type { AgentMuxHostedInvocation } from '../src/hosted-client-contract.js'
import type { AgentMuxRunInputData } from '../src/types.js'
import type { InputObservationReference } from '../src/performance-diagnostics.js'
import { correlationParent, flushInput, inputCorrelationCore, inputDeferred } from './helpers/input-correlation.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

const cleanups: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks()
  if (errors.length) throw new AggregateError(errors, 'Terminal byte fixture cleanup failed')
})
function barrier() {
  const gate = inputDeferred()
  cleanups.push(gate.resolve)
  return gate
}
const checkpoint = async () => { await flushInput(); await new Promise<void>(resolve => setImmediate(resolve)) }
const outcome = <T>(promise: Promise<T>) => promise.then(value => ({ value, error: null }), error => ({ value: null, error }))

/** Real Core, Hosted SDK, finite Hosted service and public authority routing.
 * Only native capacity/bytes/ACKs and transport authority are controlled. */
async function fixture() {
  const h = await inputCorrelationCore()
  cleanups.push(h.dispose)
  const owner = hostedTestOwner(h.core)
  const fence = () => ({ runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId })
  const hosted = new AgentMuxHostedRuntimeService(h.core, null, () => owner)
  cleanups.push(() => hosted.dispose())
  const rpc = new AgentMuxRpcService({ coreClients: () => [{ hostId: 'local', client: h.core }], hostedRuntime: () => hosted })
  cleanups.push(() => rpc.dispose())
  let permitted = true, cursor = 0
  const revoked = new AgentMuxError('Original device authority revoked', 'CONTROL_PERMISSION_DENIED')
  const context: AgentMuxRpcCallContext = { principal: { kind: 'device', id: 'original-terminal-device' },
    assertCurrent: () => { if (!permitted) throw revoked } }
  const state = { capacity: null as ReturnType<typeof barrier> | null, ack: null as ReturnType<typeof barrier> | null,
    ackError: null as Error | null }
  const writes: Array<{ runId: string; bytes: number[]; startByte: number; endByte: number }> = []
  const waitWritable = vi.fn(async (_bytes: number, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    if (state.capacity) {
      const gate = state.capacity
      let abort!: () => void
      try {
        await Promise.race([gate.promise, new Promise<never>((_, reject) => {
          abort = () => reject(signal?.reason)
          signal?.addEventListener('abort', abort, { once: true })
        })])
      } finally { signal?.removeEventListener('abort', abort) }
    }
    signal?.throwIfAborted()
  })
  const native = vi.fn((runId: string, data: AgentMuxRunInputData) => {
    const bytes = [...Buffer.from(data)], startByte = cursor
    cursor += bytes.length
    writes.push({ runId, bytes, startByte, endByte: cursor })
    const appliedByteRange = { startByte, endByte: cursor }, ack = state.ack, error = state.ackError
    return (ack?.promise ?? Promise.resolve()).then(() => {
      if (error) throw error
      return { appliedByteRange }
    })
  })
  const kernel = (h.core as any).kernel
  kernel.openInput = vi.fn(async (runId: string) => ({ run: { ...h.run(), runId }, waitWritable,
    input: (data: AgentMuxRunInputData) => native(runId, data) }))
  kernel.stop = vi.fn()
  const rawInvoke = async (invocation: unknown, callContext = context, originalFence = fence()) => {
    const result = await rpc.call('runtime.invoke', { fence: originalFence, consumerId: 'terminal-byte-consumer',
      invocation: invocation as AgentMuxHostedInvocation }, callContext)
    return decodeHostedValue(result.value)
  }
  const invoke = (data: AgentMuxRunInputData, callContext = context, observation?: unknown) => rawInvoke(
    encodeHostedValue({ method: 'writeTerminalBytes', args: [{ runId: 'original' }, data, observation] }), callContext)
  return { ...h, owner, fence, state, context, revoked, kernel, writes, native, waitWritable, rawInvoke, invoke,
    revoke: () => { permitted = false }, ref: { runId: 'original' },
    text: () => Buffer.from(writes.flatMap(write => write.bytes)).toString('utf8') }
}

it('rechecks original Hosted device authority after capacity, preserving local input on the same Agent-owned Run', async () => {
  const h = await fixture()
  // This is intentionally an Agent-owned Run; raw terminal authority is not a
  // guess based on whether a cold local registry classifies it as a Terminal.
  expect(h.core.agentSession('private-agent').run).toEqual(h.ref)
  const missing = await outcome(h.invoke('missing', { principal: h.context.principal }))
  expect(missing.error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(h.writes).toEqual([])
  h.state.capacity = barrier()
  const pending = outcome(h.invoke('revoked'))
  await checkpoint()
  expect(h.waitWritable).toHaveBeenCalledTimes(2)
  h.revoke(); h.state.capacity.resolve()
  expect((await pending).error).toBe(h.revoked)
  expect(h.writes).toEqual([])
  await expect(h.core.writeTerminalBytes(h.ref, 'local')).resolves.toMatchObject({ runId: 'original', acceptedThroughByte: 5 })
  expect(h.text()).toBe('local')
  expect(h.kernel.stop).not.toHaveBeenCalled()
})

it('rejects a wire-supplied call context and methods outside the finite Hosted surface before byte dispatch', async () => {
  const h = await fixture()
  const dispatched = vi.spyOn(h.core, 'writeTerminalBytes')
  await expect(h.rawInvoke(encodeHostedValue({ method: 'writeTerminalBytes', args: [h.ref, 'forged', undefined,
    { requestSignal: {}, assertCurrent: 'wire-approval' }] }))).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(h.rawInvoke({ method: 'dispatchRawInput', args: ['original', 'forged'] })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(dispatched).not.toHaveBeenCalled()
  expect(h.writes).toEqual([])
  await h.invoke('ok')
  expect(h.text()).toBe('ok')
})

it('drops malformed optional diagnostics in the SDK and wire receiver without changing binary business input', async () => {
  const h = await fixture(), getter = vi.fn(() => { throw new Error('optional getter must not run') })
  const malformed = Object.defineProperty({ source: 'user', sequence: 1 }, 'observerId', { enumerable: true, get: getter })
  const bytes = Uint8Array.from([0, 0xff, 0xe4, 0xb8, 0xad, 0x1b, 0x0d])
  await h.hosted.writeTerminalBytes(h.ref, bytes, malformed as InputObservationReference)
  await h.rawInvoke({ method: 'writeTerminalBytes', args: [h.ref, encodeHostedValue(bytes),
    { $agentmuxValue: 'bytes', data: 'not base64' }] })
  expect(getter).not.toHaveBeenCalled()
  expect(h.writes.map(write => write.bytes)).toEqual([[...bytes], [...bytes]])
  expect((await h.core.clientPerformanceDiagnostics()).input.recent.map(entry => entry.parent)).toEqual([null, null])
  await expect(h.rawInvoke({ method: 'writeTerminalBytes', args: [h.ref,
    { $agentmuxValue: 'bytes', data: 'not base64' }, correlationParent()] })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(h.writes).toHaveLength(2)
  await h.invoke('healthy', h.context, correlationParent())
  expect((await h.core.clientPerformanceDiagnostics()).input.recent.at(-1)?.parent).toEqual(correlationParent())
})

it('cancels a held Host authority observation before dispatch and releases local input without waiting for its late answer', async () => {
  const h = await fixture(), gate = barrier(), controller = new AbortController()
  const reason = new Error('original terminal request cancelled'), author = vi.fn(async () => { await gate.promise })
  const pending = outcome(h.invoke('cancelled', { ...h.context, signal: controller.signal, assertCurrent: author }))
  await checkpoint()
  expect(author).toHaveBeenCalledOnce()
  controller.abort(reason)
  await checkpoint()
  let localDone = false
  const local = h.core.writeTerminalBytes(h.ref, 'local').then(value => { localDone = true; return value })
  await checkpoint()
  const beforeLateAnswer = { localDone, text: h.text() }
  gate.resolve()
  expect((await pending).error).toBe(reason)
  await local
  expect(beforeLateAnswer).toEqual({ localDone: true, text: 'local' })
  expect(h.text()).toBe('local')
})

it.each(['ack', 'unknown'] as const)('retains the original %s after native admission despite cancellation, revocation and current daemon replacement', async mode => {
  const h = await fixture(), controller = new AbortController(), ack = barrier()
  const unknown = new AgentMuxError('Original ACK observation lost', 'CTXMUX_CONNECTION_LOST')
  h.state.ack = ack; h.state.ackError = mode === 'unknown' ? unknown : null
  const first = outcome(h.invoke('first', { ...h.context, signal: controller.signal }, correlationParent('user', 1)))
  await checkpoint()
  expect(h.text()).toBe('first')
  controller.abort(new Error('cancel after admission')); h.revoke(); h.changeDaemon('replacement-daemon')
  h.state.ack = null; h.state.ackError = null
  let suffixDone = false
  const suffix = h.core.writeTerminalBytes(h.ref, 'suffix', correlationParent('user', 2)).then(value => { suffixDone = true; return value })
  await checkpoint()
  const beforeAck = { suffixDone, text: h.text() }
  ack.resolve()
  const result = await first
  await suffix
  expect(beforeAck).toEqual({ suffixDone: true, text: 'firstsuffix' })
  if (mode === 'unknown') expect(result.error).toBe(unknown)
  else expect(result).toMatchObject({ value: { runId: 'original', appliedByteRange: { startByte: 0, endByte: 5 }, acceptedThroughByte: 5 }, error: null })
  expect(h.native).toHaveBeenCalledTimes(2)
  const entries = (await h.core.clientPerformanceDiagnostics()).input.recent
  expect(entries.find(entry => entry.parent?.sequence === 1)?.ownerInstanceId).toBe('controlled-daemon')
  expect(entries.find(entry => entry.parent?.sequence === 2)?.ownerInstanceId).toBe('replacement-daemon')
  expect(h.kernel.stop).not.toHaveBeenCalled()
})

it('does not let C pass unadmitted A when middle waiter B cancels while waiting for A', async () => {
  const h = await fixture(), firstAuthority = barrier(), middle = new AbortController()
  const author = vi.fn(async () => { await firstAuthority.promise })
  const a = h.core.writeTerminalBytes(h.ref, 'A', undefined, { assertCurrent: author })
  await checkpoint()
  expect(author).toHaveBeenCalledOnce()
  const reason = new Error('cancel only middle waiter'), b = outcome(h.core.writeTerminalBytes(h.ref, 'B', undefined, { requestSignal: middle.signal }))
  await checkpoint()
  middle.abort(reason)
  await checkpoint()
  let cDone = false, bDone = false
  void b.then(() => { bDone = true })
  const c = h.core.writeTerminalBytes(h.ref, 'C').then(value => { cDone = true; return value })
  await checkpoint()
  const beforeA = { bDone, cDone, text: h.text() }
  firstAuthority.resolve()
  await Promise.all([a, c])
  expect((await b).error).toBe(reason)
  expect(beforeA).toEqual({ bDone: true, cDone: false, text: '' })
  expect(h.text()).toBe('AC')
  expect(h.writes.map(write => [write.startByte, write.endByte])).toEqual([[0, 1], [1, 2]])
})

it('rejects an old semantic Host fence changed during runtime preparation and accepts an explicit fresh owner invocation', async () => {
  const h = await fixture(), oldFence = h.fence(), preparation = barrier()
  h.gates.connect = preparation
  const pending = outcome(h.invoke('old-owner'))
  await checkpoint()
  expect(h.core.connectRuntime).toHaveBeenCalled()
  h.owner.ownerInstanceId = 'replacement-owner'
  preparation.resolve()
  expect((await pending).error).toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  expect(h.writes).toEqual([])
  await expect(h.rawInvoke(encodeHostedValue({ method: 'writeTerminalBytes', args: [h.ref, 'stale'] }), h.context, oldFence))
    .rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
  await h.invoke('fresh-owner')
  expect(h.text()).toBe('fresh-owner')
  expect(h.kernel.stop).not.toHaveBeenCalled()
})


it('empty terminal bytes report an unknown cursor without opening a channel or accepting bytes', async () => {
  const h = await fixture()
  const empty = { runId: 'original', appliedByteRange: null, acceptedThroughByte: null }
  await expect(h.hosted.writeTerminalBytes(h.ref, '')).resolves.toEqual(empty)
  await expect(h.invoke(new Uint8Array())).resolves.toEqual(empty)
  expect(h.kernel.openInput).not.toHaveBeenCalled()
  expect(h.native).not.toHaveBeenCalled()
  await h.invoke('live')
  expect(h.text()).toBe('live')
})
