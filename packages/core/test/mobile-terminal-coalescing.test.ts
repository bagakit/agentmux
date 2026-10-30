import { expect, it } from 'vitest'
import { deferred, mobileRelayOwner, relayInputWitness } from './helpers/mobile-relay-owner.js'

const bytes = (data: string | Uint8Array) => typeof data === 'string' ? new TextEncoder().encode(data) : data
const heldFirst = (f: Awaited<ReturnType<typeof mobileRelayOwner>>) => {
  const held = deferred<void>(), raw = f.rawInput.getMockImplementation()!
  let first = true
  f.rawInput.mockImplementation((id, data) => {
    const result = raw(id, data)
    if (!first) return result
    first = false; return held.promise.then(() => result)
  })
  return held
}

it.each([0, 20])('actual Mobile/Hosted/E2EE/Core combines a 12-event burst with %i ms controlled send delay', async delay => {
  const f = await mobileRelayOwner(delay), start = performance.now(), startRequests = f.requests.length
  const native: Array<{ data: Uint8Array; at: number }> = [], raw = f.rawInput.getMockImplementation()!
  f.rawInput.mockImplementation((id, data) => { native.push({ data: bytes(data), at: performance.now() }); return raw(id, data) })
  expect(f.control.enable()).toBe(true)
  for (const data of 'abcdefghijkl') f.control.send(data, 'user')
  expect(f.control.facts()).toMatchObject({ phase: 'sending', queuedBytes: 11 })
  await expect.poll(() => f.control.facts().phase).toBe('idle')
  const calls = f.requests.slice(startRequests).filter(value => value.invocation === 'writeAgent')
  expect(f.rawInput.mock.calls.map(value => bytes(value[1]))).toEqual([bytes('a'), bytes('bcdefghijkl')])
  expect(calls).toHaveLength(2)
  expect(new Set(calls.map(value => value.id)).size).toBe(2)
  expect(f.control.facts()).toMatchObject({ queuedBytes: 0, pending: null })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  relayInputWitness({ kind: 'mobile-coalesced-burst', controlledSendDelayMs: delay, inputEvents: 12, writeRequests: calls.length,
    nativeBytes: f.rawInput.mock.calls.map(value => Array.from(bytes(value[1]))), inputToNativeMs: native.map(value => value.at - start), finalReceiptMs: performance.now() - start,
    source: 'actual Mobile control, Hosted/E2EE/public dispatcher/Core; deterministic Runtime leaf, not a real phone' })
})

it('keeps original binary/UTF-8 bytes and the resize barrier through the real Relay input owner', async () => {
  const f = await mobileRelayOwner(), held = heldFirst(f), actions: unknown[] = [], raw = f.rawInput.getMockImplementation()!
  f.rawInput.mockImplementation((id, data) => { actions.push(Array.from(bytes(data))); return raw(id, data) })
  f.resize.mockImplementation(async (runId, cols, rows) => { actions.push({ resize: [cols, rows] }); return { run: { ...f.run(runId), cols, rows }, cols, rows } })
  f.control.enable(); f.control.send('a', 'user')
  f.control.send('你', 'user'); f.control.send(Uint8Array.of(0, 255), 'user')
  f.control.send('\ud800', 'user'); f.control.send('\udc00', 'user')
  expect(f.control.resize(52, 18)).toBe(true)
  f.control.send('x', 'user'); f.control.send('y', 'user')
  await expect.poll(() => f.rawInput.mock.calls.length).toBe(1)
  expect(f.control.facts().queuedBytes).toBe(13)
  held.resolve()
  await expect.poll(() => f.control.facts().phase).toBe('idle')
  expect(actions).toEqual([[97], [228, 189, 160, 0, 255, 239, 191, 189, 239, 191, 189], { resize: [52, 18] }, [120, 121]])
  expect(f.control.facts()).toMatchObject({ queuedBytes: 0, pending: null })
  expect(f.requests.filter(value => value.invocation === 'writeAgent' || value.invocation === 'resizeAgent').map(value => value.invocation))
    .toEqual(['writeAgent', 'writeAgent', 'resizeAgent', 'writeAgent'])
  expect(f.client.agentSession('caller').run.runId).toBe('run-caller')
})

it('retains one original unknown batch and sends only its never-called suffix after explicit review', async () => {
  const f = await mobileRelayOwner(), first = heldFirst(f), raw = f.rawInput.getMockImplementation()!, second = deferred<void>()
  let calls = 0
  f.rawInput.mockImplementation((id, data) => {
    const accepted = raw(id, data)
    if (++calls === 2) return second.promise.then(() => { throw new Error('Private lost native ACK after original bytes were applied') })
    return accepted
  })
  f.control.enable(); f.control.send('a', 'user'); f.control.send('b', 'user'); f.control.send('c', 'user')
  await expect.poll(() => f.rawInput.mock.calls.length).toBe(1); first.resolve()
  await expect.poll(() => f.rawInput.mock.calls.length).toBe(2)
  const pending = f.control.facts().pending
  expect(pending).toMatchObject({ runId: 'run-caller', kind: 'input' })
  f.control.send('tail', 'user'); second.resolve()
  await expect.poll(() => f.control.facts().phase).toBe('unknown')
  expect(f.control.facts()).toMatchObject({ queuedBytes: 4, pending })
  expect(f.control.queuedText()).toBe('tail')
  expect(f.rawInput.mock.calls.map(value => Array.from(bytes(value[1])))).toEqual([[97], [98, 99]])
  const saved = [...f.backing.values()][0]!
  expect(JSON.parse(saved)).toMatchObject({ intentId: pending!.intentId, runId: 'run-caller', kind: 'input' })
  expect(Object.keys(JSON.parse(saved)).sort()).toEqual(['createdAt', 'intentId', 'kind', 'runId', 'version'])
  expect(f.control.enable()).toBe(false)
  expect(f.control.continueAfterReview()).toBe(true); expect(f.control.enable()).toBe(true)
  await expect.poll(() => f.control.facts().phase).toBe('idle')
  expect(f.rawInput.mock.calls.map(value => Array.from(bytes(value[1])))).toEqual([[97], [98, 99], [116, 97, 105, 108]])
  expect(f.control.facts()).toMatchObject({ queuedBytes: 0, pending: null })
})
