import { expect, it, vi } from 'vitest'
import { createHostedHistoryFixture } from './helpers/session-history-query.js'
import { decodeHostedValue } from '../src/hosted-value.js'

it('source observation keeps its exact selector on wire and cancellation on the original Unix Host reader', async () => {
  const f = await createHostedHistoryFixture(), controller = new AbortController(), wire = vi.spyOn(f.rpc, 'call')
  let entered!: () => void, release!: () => void, received: AbortSignal | undefined
  const ready = new Promise<void>(resolve => { entered = resolve })
  const blocked = new Promise<null>(resolve => { release = () => resolve(null) })
  vi.spyOn(f.store, 'readHistorySource').mockImplementation((_id, signal) => { received = signal; entered(); return blocked })
  const pending = f.client.sessionHistorySources({ agentSessionId: f.session.agentSessionId, signal: controller.signal })
  const outcome = pending.then(value => ({ value }), error => ({ error }))
  try {
    await ready
    const call = wire.mock.calls.find(([method, params]) => method === 'runtime.invoke' &&
      (decodeHostedValue((params as { invocation: unknown }).invocation) as { method: string }).method === 'sessionHistorySources')
    expect(call).toBeTruthy()
    expect(decodeHostedValue((call![1] as { invocation: unknown }).invocation)).toEqual({ method: 'sessionHistorySources', args: [{ agentSessionId: f.session.agentSessionId }] })
    expect(call![2]?.signal).toBeInstanceOf(AbortSignal); expect(received).toBeInstanceOf(AbortSignal)
    controller.abort(new Error('Only this source invocation closed'))
    expect(await outcome).toMatchObject({ error: { code: 'CONTROL_CANCELLED' } })
    await vi.waitFor(() => expect(received?.aborted).toBe(true))
    const owner = f.client.runtimeOwnerIdentity()
    expect(owner).not.toBeNull()
    await expect(f.service.call('runtime.invoke', { fence: { runtimeId: owner!.runtimeId, ownerInstanceId: owner!.ownerInstanceId }, consumerId: 'invalid-source',
      invocation: { method: 'sessionHistorySources', args: [{ signal: {} }] } })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
    await f.noControls()
  } finally { controller.abort(); release(); await outcome; wire.mockRestore(); await f.dispose() }
})
