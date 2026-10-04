import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, type AgentHookBinding, type HookDeliveryFailure } from '../src/hook-server.js'
import { sendHookReceipt } from '../src/agent-hook-delivery.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { AgentMuxHostedTransferReader } from '../src/hosted-value.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestOwner, hostedTestFence } from './helpers/hosted-runtime-port.js'
import { createPiManagedHookPlan } from '../src/providers/pi.js'
import { createOpenCodeManagedHookPlan } from '../src/providers/opencode.js'
import type { AgentMuxClientEvent, NativeHookEnvelope } from '../src/types.js'

const servers: AgentHookServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())) })
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))
const post = (binding: AgentHookBinding, receiptId: string, payload: unknown = {}) => fetch(binding.endpoint.url, {
  method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ receiptId, eventName: 'observation', payload })
})

describe('Hook admission, receipt and observation recovery', () => {
  it.each(['pi', 'opencode'] as const)('retries the generated %s sender with the same receipt after backpressure', async provider => {
    const source = provider === 'pi' ? createPiManagedHookPlan({ PI_CODING_AGENT_DIR: fixturePath("isolated") }).mutations[0]!.content
      : createOpenCodeManagedHookPlan('http://127.0.0.1/isolated', 'isolated-token', { OPENCODE_CONFIG_DIR: fixturePath("isolated") }).mutations[0]!.content
    const module = await import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    const originalFetch = globalThis.fetch, url = process.env.AGENTMUX_HOOK_URL, token = process.env.AGENTMUX_HOOK_TOKEN
    const attempts: Array<{ body: string; at: number }> = []
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      attempts.push({ body: String(init.body), at: Date.now() })
      return new Response(attempts.length === 1 ? JSON.stringify({ accepted: false, stage: 'admission' }) : null,
        { status: attempts.length === 1 ? 429 : 204, headers: { 'retry-after': '0.25' } })
    }) as typeof fetch
    process.env.AGENTMUX_HOOK_URL = 'http://127.0.0.1/isolated'; process.env.AGENTMUX_HOOK_TOKEN = 'isolated-token'
    try {
      if (provider === 'pi') {
        const handlers = new Map<string, (event: unknown, ctx: unknown) => void>()
        module.default({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) })
        handlers.get('agent_start')!({}, {})
      } else await (await module.server()).event({ event: { type: 'session.status', properties: { status: { type: 'busy' } } } })
      await vi.waitFor(() => expect(attempts).toHaveLength(2), { timeout: 1_000, interval: 5 })
      expect(attempts).toHaveLength(2)
      expect(attempts[1]!.body).toBe(attempts[0]!.body)
      expect(JSON.parse(attempts[0]!.body).receiptId).toEqual(expect.any(String))
      expect(attempts[1]!.at - attempts[0]!.at).toBeGreaterThanOrEqual(240)
    } finally {
      globalThis.fetch = originalFetch
      if (url === undefined) delete process.env.AGENTMUX_HOOK_URL; else process.env.AGENTMUX_HOOK_URL = url
      if (token === undefined) delete process.env.AGENTMUX_HOOK_TOKEN; else process.env.AGENTMUX_HOOK_TOKEN = token
    }
  })

  it('delivers an eight-event 350ms burst through the production sender without losing acknowledgements', async () => {
    const receipts: string[] = []
    const server = new AgentHookServer(async event => { receipts.push(event.receiptId); await wait(350) }, 0)
    servers.push(server); await server.start()
    const binding = server.createBinding('burst-session', 'codex'); await binding.bindRun('burst-run')
    await Promise.all(Array.from({ length: 8 }, (_, i) => sendHookReceipt(binding.endpoint.url, binding.endpoint.token,
      JSON.stringify({ receiptId: `burst-${i}`, eventName: 'observation' }))))
    expect(receipts).toEqual(Array.from({ length: 8 }, (_, i) => `burst-${i}`))
  }, 6_000)

  it('joins an in-flight receipt and acknowledges a retry after a lost response without mutating twice', async () => {
    const receipts: string[] = []
    const server = new AgentHookServer(async event => { receipts.push(event.receiptId); await wait(80) }, 0)
    servers.push(server); await server.start()
    const binding = server.createBinding('receipt-session', 'pi'); await binding.bindRun('receipt-run')
    await Promise.all([post(binding, 'same', { a: 1, nested: { b: 2, c: 3 } }), post(binding, 'same', { a: 1, nested: { b: 2, c: 3 } })])
    const reordered = await fetch(binding.endpoint.url, { method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}` },
      body: JSON.stringify({ payload: { nested: { c: 3, b: 2 }, a: 1 }, eventName: 'observation', receiptId: 'same', ignored: true }) })
    expect(reordered.status).toBe(204)
    expect(receipts).toEqual(['same'])
    const conflict = await post(binding, 'same', { different: true })
    expect(conflict.status).toBe(409)
    expect(receipts).toEqual(['same'])

    // Abort only the response reader after execution starts. The same original
    // receipt is an observation retry, never a second input or owner mutation.
    const body = JSON.stringify({ receiptId: 'lost-reader', eventName: 'observation' })
    const controller = new AbortController()
    const lost = fetch(binding.endpoint.url, { method: 'POST',
      headers: { authorization: `Bearer ${binding.endpoint.token}` }, body, signal: controller.signal }).catch(error => error)
    await vi.waitFor(() => expect(receipts).toContain('lost-reader'), { timeout: 1_000, interval: 5 })
    controller.abort(); await lost
    await sendHookReceipt(binding.endpoint.url, binding.endpoint.token, body)
    expect(receipts).toEqual(['same', 'lost-reader'])
  })

  it('deduplicates staged receipts and distinguishes memory acceptance from a durable acknowledgement', async () => {
    const receipts: string[] = []
    const server = new AgentHookServer(event => { receipts.push(event.receiptId) }, 0)
    servers.push(server); await server.start()
    const binding = server.createBinding('pending-session', 'opencode')
    const first = await post(binding, 'pending')
    expect(first.status).toBe(202)
    expect(await first.json()).toMatchObject({ stage: 'pending_run', accepted: 'memory' })
    expect((await post(binding, 'pending')).status).toBe(202)
    expect(receipts).toEqual([])
    await binding.bindRun('pending-run')
    expect((await post(binding, 'pending')).status).toBe(204)
    expect(receipts).toEqual(['pending'])
  })

  it('retains original receipt uncertainty and conflicts while a timed-out owner drains', async () => {
    const receipts: string[] = [], failures: HookDeliveryFailure[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const server = new AgentHookServer(async event => {
      receipts.push(event.receiptId)
      if (event.receiptId === 'unknown-draining') await gate
    }, 0, failure => { failures.push(failure) })
    servers.push(server); await server.start()
    const binding = server.createBinding('draining-session', 'codex'); await binding.bindRun('draining-run')
    try {
      const first = await post(binding, 'unknown-draining', { original: true })
      expect(first.status).toBe(503)
      const unknown = { error: 'HOOK_DELIVERY_TIMEOUT', receiptId: 'unknown-draining', stage: 'owner', accepted: 'unknown' }
      expect(await first.json()).toMatchObject(unknown)
      const repeated = await post(binding, 'unknown-draining', { original: true })
      expect(repeated.status).toBe(503)
      expect(await repeated.json()).toMatchObject(unknown)
      expect((await post(binding, 'unknown-draining', { conflicting: true })).status).toBe(409)
      const fresh = await post(binding, 'not-admitted')
      expect(await fresh.json()).toMatchObject({ error: 'HOOK_BINDING_RECOVERING', stage: 'admission', accepted: false })
      expect(receipts).toEqual(['unknown-draining'])
      expect(failures.filter(failure => failure.receiptId === 'unknown-draining')).toEqual([
        expect.objectContaining({ stage: 'owner', accepted: 'unknown' }),
        expect.objectContaining({ stage: 'owner', accepted: 'unknown' })
      ])
      release(); await wait(10)
      expect((await post(binding, 'unknown-draining', { original: true })).status).toBe(503)
      expect((await post(binding, 'new-after-drain')).status).toBe(204)
      expect(receipts).toEqual(['unknown-draining', 'new-after-drain'])
    } finally { release() }
  }, 4_000)

  it('does not execute an unknown receipt twice after owner mutation then rejection', async () => {
    const mutations: string[] = []
    const server = new AgentHookServer(event => {
      mutations.push(event.receiptId)
      if (event.receiptId === 'unknown-commit') throw new Error('commit acknowledgement unavailable after mutation')
    }, 0)
    servers.push(server); await server.start()
    const binding = server.createBinding('unknown-session', 'pi'); await binding.bindRun('unknown-run')
    const first = await post(binding, 'unknown-commit', { original: true })
    expect(await first.json()).toMatchObject({ receiptId: 'unknown-commit', stage: 'owner', accepted: 'unknown' })
    await wait(10) // The rejected owner has drained; unknown is still not proof of no commit.
    const repeated = await post(binding, 'unknown-commit', { original: true })
    expect(repeated.status).toBe(503)
    expect(await repeated.json()).toMatchObject({ receiptId: 'unknown-commit', stage: 'owner', accepted: 'unknown' })
    expect(mutations).toEqual(['unknown-commit'])
    expect((await post(binding, 'unknown-commit', { conflicting: true })).status).toBe(409)
    expect((await post(binding, 'fresh-receipt')).status).toBe(204)
    expect(mutations).toEqual(['unknown-commit', 'fresh-receipt'])
  })

  it('expires queued work before execution, keeps other bindings usable and reopens after aborted work drains', async () => {
    const failures: HookDeliveryFailure[] = []
    const receipts: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let aborted = false
    const server = new AgentHookServer(async (event, signal) => {
      receipts.push(event.receiptId)
      if (event.receiptId !== 'blocked') return
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      await gate // Delayed cleanup must not let another owner race it.
    }, 0, failure => { failures.push(failure) })
    servers.push(server); await server.start()
    const busy = server.createBinding('busy-session', 'codex'); await busy.bindRun('busy-run')
    const healthy = server.createBinding('healthy-session', 'claude'); await healthy.bindRun('healthy-run')
    try {
    const blocked = post(busy, 'blocked')
    await vi.waitFor(() => expect(receipts).toContain('blocked'), { timeout: 1_000, interval: 5 })
    const queued = post(busy, 'not-started')
    expect((await post(healthy, 'healthy')).status).toBe(204)
    expect((await blocked).status).toBe(503)
    expect(aborted).toBe(true)
    const expired = await queued
    expect(expired.status).toBe(503) // Old owner still draining: binding temporarily unavailable.
    expect(await expired.json()).toMatchObject({ error: 'HOOK_QUEUE_TIMEOUT', stage: 'admission', accepted: false })
    expect(receipts).toEqual(['blocked', 'healthy'])
    release(); await wait(10)
    expect((await post(busy, 'not-started')).status).toBe(204)
    expect(receipts).toEqual(['blocked', 'healthy', 'not-started'])
    expect(failures).toEqual(expect.arrayContaining([
      expect.objectContaining({ receiptId: 'blocked', stage: 'owner', accepted: 'unknown' }),
      expect.objectContaining({ receiptId: 'not-started', stage: 'admission', accepted: false })
    ]))
    } finally { release() }
  }, 7_000)

  it('publishes a scoped SDK service failure and retains the original Session after malformed or failed observations', async () => {
    const h = await rpcOwnerFixture(['sdk-session']), { client, store } = h
    const inner = client as unknown as { registry: { load(host: string): Promise<void> }; hookServer: AgentHookServer;
      acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void> }
    h.inner.kernel.identity = () => ({ buildIdentity: 'hook-test', protocolVersion: 1, daemonInstanceId: 'isolated-daemon' })
    inner.acceptHookEvent = async () => { throw new Error('isolated store unavailable') }
    const events: AgentMuxClientEvent[] = []
    client.onEvent(event => { events.push(event) })
    const hosted = new AgentMuxHostedRuntimeService(client, null, () => hostedTestOwner(client))
    const rpc = new AgentMuxRpcService({ coreClients: h.coreClients, hostedRuntime: () => hosted })
    const reader = new AgentMuxHostedTransferReader(), rpcEvents: AgentMuxClientEvent[] = []
    const subscription = await rpc.subscribe('runtime.events', { fence: hostedTestFence, consumerId: 'hook-service-reader' }, event => {
      if (event.type !== 'snapshot') return
      const value = reader.accept(event.data) as { kind: string; event?: AgentMuxClientEvent } | undefined
      if (value?.kind === 'event' && value.event) rpcEvents.push(value.event)
    }, { principal: { kind: 'user', id: 'isolated-hook-reviewer' } })
    await subscription.start?.()
    // Reuse the production failure callback with an isolated loopback port.
    Object.defineProperty(inner.hookServer, 'port', { value: 0 })
    await inner.hookServer.start()
    const binding = inner.hookServer.createBinding('sdk-session', 'codex'); await binding.bindRun('run-sdk-session')
    try {
      const oversized = await post(binding, 'oversized', { text: 'x'.repeat(128 * 1024) })
      expect(oversized.status).toBe(413)
      expect((await post(binding, 'owner-failure')).status).toBe(503)
      expect(events.filter(event => event.type === 'agent-error')).toEqual([
        expect.objectContaining({ agentSessionId: 'sdk-session', code: 'HOOK_BODY_TOO_LARGE', evidence: expect.objectContaining({ run: { runId: 'run-sdk-session' } }) }),
        expect.objectContaining({ agentSessionId: 'sdk-session', code: 'HOOK_DELIVERY_FAILED', message: expect.stringContaining('durable delivery is unconfirmed') })
      ])
      await vi.waitFor(() => expect(rpcEvents).toHaveLength(2), { timeout: 1_000, interval: 5 })
      expect(rpcEvents).toEqual(events)
      expect(await store.load()).toEqual([expect.objectContaining({ agentSessionId: 'sdk-session', run: { runId: 'run-sdk-session' } })])
      expect(h.inner.kernel.stop).not.toHaveBeenCalled()
    } finally { await subscription.dispose(); await hosted.dispose(); await h.close() }
  })
})
