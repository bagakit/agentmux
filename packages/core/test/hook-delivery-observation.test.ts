import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer, type AgentHookBinding, type HookIngressObserver } from '../src/hook-server.js'

/**
 * One exact Run's Hook delivery health is one fact held where the receipts live: the binding.
 * N failing receipts set it once and change it at most once more (when processing may have
 * started). Only a receipt admitted after the latest lost observation and accepted by the owner
 * clears it, because only that receipt carries newer native state. Replays, pending-run receipts,
 * earlier-admitted receipts and other bindings are not recovery evidence.
 */
const servers: AgentHookServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.stop())) })
const post = (binding: AgentHookBinding, receiptId: string, payload: unknown = {}) => fetch(binding.endpoint.url, {
  method: 'POST', headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ receiptId, eventName: 'observation', payload })
})
function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

async function owner(onEvent: ConstructorParameters<typeof AgentHookServer>[0], observer: HookIngressObserver = {}) {
  const changes: Array<[string, string]> = []
  const server = new AgentHookServer(onEvent, 0, { ...observer,
    deliveryChanged: (agentSessionId, runId) => { changes.push([agentSessionId, runId]) } })
  servers.push(server); await server.start()
  return { server, changes }
}

it('twenty failing receipts of one Run set one fact, and the next delivered receipt clears it', async () => {
  let failing = true
  const { server, changes } = await owner(() => { if (failing) throw new Error('private store unavailable') })
  const binding = server.createBinding('converge-session', 'codex'); await binding.bindRun('converge-run')
  for (let index = 0; index < 20; index++) expect((await post(binding, `failing-${index}`)).status).toBe(503)
  expect(changes).toEqual([['converge-session', 'converge-run']])
  const fact = server.deliveryObservation('converge-session', 'converge-run')
  expect(fact).toEqual({ run: { runId: 'converge-run' }, since: expect.any(Number), accepted: 'unknown', code: 'HOOK_DELIVERY_FAILED' })
  expect(Object.keys(fact!).sort(), 'The fact holds no receipt id and no failure count').toEqual(['accepted', 'code', 'run', 'since'])
  expect(server.deliveryObservation('converge-session', 'other-run')).toBeUndefined()
  expect(server.deliveryObservation('other-session', 'converge-run')).toBeUndefined()
  failing = false
  expect((await post(binding, 'delivered')).status).toBe(204)
  expect(server.deliveryObservation('converge-session', 'converge-run')).toBeUndefined()
  expect(changes).toEqual([['converge-session', 'converge-run'], ['converge-session', 'converge-run']])
})

it('a refusal before processing escalates once to unknown, and earlier-admitted successes do not clear it', async () => {
  const started = gate()
  const { server, changes } = await owner(async (event, signal) => {
    if (event.receiptId !== 'blocked') return
    started.release()
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('aborted owner work')
  })
  const binding = server.createBinding('escalate-session', 'codex'); await binding.bindRun('escalate-run')
  const lane = [...(server as unknown as { bindings: Map<string, { pendingDeliveries: number }> }).bindings.values()][0]!
  const blocked = post(binding, 'blocked')
  await started.promise
  const queued = Array.from({ length: 7 }, (_, index) => post(binding, `queued-${index}`))
  await vi.waitFor(() => expect(lane.pendingDeliveries).toBe(8), { timeout: 1_000, interval: 5 })
  const refused = await post(binding, 'refused-before-processing')
  expect(refused.status).toBe(429)
  expect(await refused.json()).toMatchObject({ error: 'HOOK_DELIVERY_BACKPRESSURE', accepted: false })
  const first = server.deliveryObservation('escalate-session', 'escalate-run')!
  expect(first).toMatchObject({ accepted: false, code: 'HOOK_DELIVERY_BACKPRESSURE' })
  expect(changes).toHaveLength(1)
  expect((await blocked).status).toBe(503)
  const escalated = { ...first, accepted: 'unknown', code: 'HOOK_DELIVERY_TIMEOUT' }
  expect(server.deliveryObservation('escalate-session', 'escalate-run')).toEqual(escalated)
  expect(changes).toHaveLength(2)
  expect((await Promise.all(queued)).map(response => response.status)).toEqual([204, 204, 204, 204, 204, 204, 204])
  expect(server.deliveryObservation('escalate-session', 'escalate-run'), 'Receipts admitted before the refusal carry older state').toEqual(escalated)
  expect(changes).toHaveLength(2)
  expect((await post(binding, 'admitted-after-refusal')).status).toBe(204)
  expect(server.deliveryObservation('escalate-session', 'escalate-run')).toBeUndefined()
  expect(changes).toHaveLength(3)
}, 8_000)

it('a replayed failure, a pending-run receipt and another binding neither clear nor re-announce the fact', async () => {
  const { server, changes } = await owner(event => {
    if (event.receiptId === 'unknown-commit') throw new Error('commit acknowledgement unavailable')
  })
  const failing = server.createBinding('replay-session', 'codex'); await failing.bindRun('replay-run')
  const neighbor = server.createBinding('neighbor-session', 'codex'); await neighbor.bindRun('neighbor-run')
  const pending = server.createBinding('pending-session', 'codex')
  expect((await post(failing, 'unknown-commit', { original: true })).status).toBe(503)
  expect(changes).toHaveLength(1)
  const replay = await post(failing, 'unknown-commit', { original: true })
  expect(replay.status).toBe(503)
  expect(await replay.json()).toMatchObject({ receiptId: 'unknown-commit', accepted: 'unknown' })
  expect((await post(neighbor, 'neighbor-healthy')).status).toBe(204)
  expect((await post(pending, 'pending-receipt')).status).toBe(202)
  expect(server.deliveryObservation('replay-session', 'replay-run')).toMatchObject({ accepted: 'unknown' })
  expect(server.deliveryObservation('neighbor-session', 'neighbor-run')).toBeUndefined()
  expect(changes, 'Replays and other bindings announce nothing').toHaveLength(1)
})

it('re-reading an earlier success after a later loss is not recovery evidence', async () => {
  const { server, changes } = await owner(event => { if (event.receiptId === 'later-loss') throw new Error('private store unavailable') })
  const binding = server.createBinding('reread-session', 'codex'); await binding.bindRun('reread-run')
  expect((await post(binding, 'earlier-success')).status).toBe(204)
  expect((await post(binding, 'later-loss')).status).toBe(503)
  // The sender lost the first answer and asks again: the cached 204 carries the older state.
  expect((await post(binding, 'earlier-success')).status).toBe(204)
  expect(server.deliveryObservation('reread-session', 'reread-run')).toMatchObject({ accepted: 'unknown' })
  expect(changes).toHaveLength(1)
})

it('a replayed failure after recovery does not bring back a stale fact', async () => {
  let failing = true
  const { server, changes } = await owner(event => { if (failing && event.receiptId === 'old-failure') throw new Error('private store unavailable') })
  const binding = server.createBinding('stale-session', 'codex'); await binding.bindRun('stale-run')
  expect((await post(binding, 'old-failure')).status).toBe(503)
  failing = false
  expect((await post(binding, 'newer-delivered')).status).toBe(204)
  expect(server.deliveryObservation('stale-session', 'stale-run')).toBeUndefined()
  expect((await post(binding, 'old-failure')).status).toBe(503)
  expect(server.deliveryObservation('stale-session', 'stale-run')).toBeUndefined()
  expect(changes).toHaveLength(2)
})

it('the HTTP answer to the sender is unchanged by the delivery fact', async () => {
  const { server } = await owner(() => { throw new Error('private store unavailable') })
  const binding = server.createBinding('wire-session', 'codex'); await binding.bindRun('wire-run')
  const response = await post(binding, 'wire-failure')
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({ error: 'HOOK_DELIVERY_FAILED', receiptId: 'wire-failure', stage: 'owner',
    accepted: 'unknown', retryable: true, recovery: expect.stringContaining('Retain the original receipt') })
})

it('closing the binding releases its fact once, and a failure that lands after close records nothing', async () => {
  const held = gate(), started = gate()
  const { server, changes } = await owner(async event => {
    if (event.receiptId === 'first-failure') throw new Error('private store unavailable')
    started.release(); await held.promise
    throw new Error('late owner failure')
  })
  const binding = server.createBinding('close-session', 'codex'); await binding.bindRun('close-run')
  expect((await post(binding, 'first-failure')).status).toBe(503)
  const late = post(binding, 'late-failure')
  await started.promise
  const closing = binding.close()
  expect(server.deliveryObservation('close-session', 'close-run')).toBeUndefined()
  expect(changes).toEqual([['close-session', 'close-run'], ['close-session', 'close-run']])
  held.release(); await closing
  expect((await late).status).toBe(503)
  expect(server.deliveryObservation('close-session', 'close-run')).toBeUndefined()
  expect(changes, 'A failure that lands after close is not a new fact').toHaveLength(2)
})

it('stopping the server releases every fact it held', async () => {
  const { server, changes } = await owner(() => { throw new Error('private store unavailable') })
  const binding = server.createBinding('stop-session', 'codex'); await binding.bindRun('stop-run')
  expect((await post(binding, 'stop-failure')).status).toBe(503)
  await server.stop()
  expect(server.deliveryObservation('stop-session', 'stop-run')).toBeUndefined()
  expect(changes).toEqual([['stop-session', 'stop-run'], ['stop-session', 'stop-run']])
})

it('unreadable request bodies stay one refusal each and never set or clear the delivery fact', async () => {
  const refusals: unknown[] = []
  const { server, changes } = await owner(() => {}, { requestRefused: refusal => { refusals.push(refusal) } })
  const binding = server.createBinding('envelope-session', 'codex'); await binding.bindRun('envelope-run')
  expect((await post(binding, 'oversized', { text: 'x'.repeat(128 * 1024) })).status).toBe(413)
  const malformed = await fetch(binding.endpoint.url, { method: 'POST',
    headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' }, body: '{' })
  expect(malformed.status).toBe(400)
  expect(refusals).toEqual([
    { agentSessionId: 'envelope-session', runId: 'envelope-run', code: 'HOOK_BODY_TOO_LARGE' },
    { agentSessionId: 'envelope-session', runId: 'envelope-run', code: 'INVALID_HOOK_ENVELOPE' }
  ])
  expect(server.deliveryObservation('envelope-session', 'envelope-run')).toBeUndefined()
  expect(changes).toEqual([])
})

it('the public RPC Session reader accepts this Run\'s delivery fact and rejects a malformed or foreign one', async () => {
  const { parseRpcAgentSession } = await import('../src/rpc-native-codec.js')
  const base = { kind: 'agent', agentSessionId: 'rpc-session', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/private/rpc', run: { runId: 'rpc-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1 }
  const fact = { run: { runId: 'rpc-run' }, since: 10, accepted: 'unknown', code: 'HOOK_DELIVERY_FAILED' }
  expect(parseRpcAgentSession({ ...base, hookDeliveryObservation: fact }).hookDeliveryObservation).toEqual(fact)
  for (const bad of [{ ...fact, run: { runId: 'other-run' } }, { ...fact, accepted: true }, { ...fact, since: -1 },
    { ...fact, code: 7 }, { ...fact, receiptId: 'leaked' }]) {
    expect(() => parseRpcAgentSession({ ...base, hookDeliveryObservation: bad }), JSON.stringify(bad)).toThrow()
  }
})
