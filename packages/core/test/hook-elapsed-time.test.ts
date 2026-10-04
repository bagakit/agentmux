import { performance } from 'node:perf_hooks'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../src/hook-server.js'
import { sendHookReceipt } from '../src/agent-hook-delivery.js'

it.each([0, 60_000, -60_000])('retains unknown receipt observations across a %ims wall-clock change', async offset => {
  const mutations: string[] = [], observations: Array<{ receiptId: string; status: number; detail: unknown }> = []
  let wallClockOffset = 0
  const server = new AgentHookServer(event => {
    mutations.push(event.receiptId)
    if (event.receiptId === 'same-unknown') throw new Error('mutation committed; acknowledgement unavailable')
  }, 0)
  const realNow = Date.now.bind(Date), originalFetch = globalThis.fetch
  await server.start()
  const binding = server.createBinding('clock-session', 'pi'); await binding.bindRun('clock-run')
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + wallClockOffset)
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const response = await originalFetch(url, init)
    observations.push({ receiptId: JSON.parse(String(init.body)).receiptId, status: response.status, detail: await response.clone().json() })
    if (observations.length === 1) wallClockOffset = offset
    return response
  }) as typeof fetch
  const post = (receiptId: string, payload = {}) => originalFetch(binding.endpoint.url, { method: 'POST',
    headers: { authorization: `Bearer ${binding.endpoint.token}` }, body: JSON.stringify({ receiptId, eventName: 'observation', payload }) })
  try {
    await expect(sendHookReceipt(binding.endpoint.url, binding.endpoint.token,
      JSON.stringify({ receiptId: 'same-unknown', eventName: 'observation', payload: {} }))).rejects.toThrow('HOOK_DELIVERY_FAILED')
    expect(observations).toHaveLength(2)
    for (const observation of observations) {
      expect(observation).toMatchObject({ receiptId: 'same-unknown', status: 503,
        detail: { receiptId: 'same-unknown', stage: 'owner', accepted: 'unknown' } })
    }
    expect(mutations).toEqual(['same-unknown'])
    expect((await post('same-unknown', { changed: true })).status).toBe(409)
    expect((await post('new-receipt')).status).toBe(204)
    expect(mutations).toEqual(['same-unknown', 'new-receipt'])
  } finally { globalThis.fetch = originalFetch; vi.restoreAllMocks(); await server.stop() }
})

it.each([60_000, -60_000])('keeps accepted queued work executable across a %ims wall-clock change', async offset => {
  const delivered: string[] = []
  let release!: () => void, wallClockOffset = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = new AgentHookServer(async event => {
    delivered.push(event.receiptId)
    if (event.receiptId === 'first') await gate
  }, 0)
  await server.start()
  const binding = server.createBinding('queue-clock-session', 'codex'); await binding.bindRun('queue-clock-run')
  const realNow = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + wallClockOffset)
  const post = (receiptId: string) => fetch(binding.endpoint.url, { method: 'POST',
    headers: { authorization: `Bearer ${binding.endpoint.token}` }, body: JSON.stringify({ receiptId }) })
  const first = post('first')
  let second: Promise<Response> | undefined
  try {
    await vi.waitFor(() => expect(delivered).toEqual(['first']))
    second = post('second')
    const state = server as unknown as { bindings: Map<string, { pendingDeliveries: number }> }
    await vi.waitFor(() => expect(state.bindings.get(binding.endpoint.token)?.pendingDeliveries).toBe(2))
    wallClockOffset = offset
    release()
    expect((await first).status).toBe(204)
    expect((await second).status).toBe(204)
    expect(delivered).toEqual(['first', 'second'])
  } finally { release(); await Promise.allSettled([first, second]); vi.restoreAllMocks(); await server.stop() }
})

it('expires confirmed receipt metadata by elapsed time despite a wall-clock rollback', async () => {
  const delivered: string[] = []
  const server = new AgentHookServer(event => { delivered.push(event.receiptId) }, 0)
  await server.start()
  const binding = server.createBinding('expiry-clock-session', 'opencode'); await binding.bindRun('expiry-clock-run')
  const post = () => fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` },
    body: JSON.stringify({ receiptId: 'confirmed-expiry' }) })
  try {
    expect((await post()).status).toBe(204)
    const realWallNow = Date.now.bind(Date), realElapsedNow = performance.now.bind(performance)
    vi.spyOn(Date, 'now').mockImplementation(() => realWallNow() - 60_000)
    vi.spyOn(performance, 'now').mockImplementation(() => realElapsedNow() + 9_000)
    // Outside the finite successful-receipt window: metadata must be released,
    // rather than making wall-clock rollback consume cache capacity indefinitely.
    expect((await post()).status).toBe(204)
    expect(delivered).toEqual(['confirmed-expiry', 'confirmed-expiry'])
  } finally { vi.restoreAllMocks(); await server.stop() }
})
