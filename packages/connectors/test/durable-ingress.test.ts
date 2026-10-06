import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { DurableIngressHost } from '../src/durable-ingress.js'
import { ConnectionHost } from '../src/connection-host.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(running = false) { const f = await ingressFixture(running); cleanup.push(() => f.close()); return f }

it('commits complete authenticated payload before ACK, and keeps original event/message identities across redelivery', async () => {
  const f = await fixture(), ack = vi.fn(() => {
    const disk = new DatabaseSync(f.databasePath)
    try {
      const rows = disk.prepare('SELECT raw_payload,event_json FROM connection_ingress_event').all()
      expect(rows).toHaveLength(1)
      expect(JSON.parse(String(rows[0]!.raw_payload))).toMatchObject({ opaqueOriginal: { complete: 'preserved payload' }, event: { body: f.event().body } })
      expect(JSON.parse(String(rows[0]!.event_json))).toEqual(f.event())
    } finally { disk.close() }
  })
  const first = await f.receive({}, ack)
  expect(ack).toHaveBeenCalledOnce(); expect(first.duplicate).toBeNull()
  expect((await f.receive()).ingress).toEqual(first.ingress)
  expect((await f.ingress.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event(), deliveryMetadata: 'new verified transport attempt' }) }, vi.fn())).ingress).toEqual(first.ingress)
  const repeated = await f.receive({ eventId: 'another-event' })
  expect(repeated).toEqual({ ingress: first.ingress, duplicate: 'message' })
  const independent = await f.receive({ eventId: 'independent-event', messageId: 'independent-message' })
  expect(independent.ingress.ingressId).not.toBe(first.ingress.ingressId)
  expect(f.connections.database.prepare('SELECT COUNT(*) AS n FROM connection_ingress_event').get()!.n).toBe(3)
  expect((await f.ingress.list({ connectionId: config.connectionId })).ingresses).toHaveLength(2)
  await expect(f.receive({ eventId: 'conflicting-event', body: 'Replacement is forbidden' })).rejects.toMatchObject({ code: 'INGRESS_MESSAGE_CONFLICT' })
  expect((await f.ingress.inspect({ ingressId: first.ingress.ingressId })).ingress!.body).toBe(f.event().body)
  expect(await f.client.inspectAgentInput({ kind: 'message-control', originalControlOperationId: 'not-created' })).toBeNull()
})

it('both dedup indexes include issuer and app, while local connection aliases share one application message', async () => {
  const f = await fixture(), first = await f.receive()
  for (const [id, application] of [['other-app', { ...config.application, appId: 'second-app' }], ['other-issuer', { ...config.application, domain: 'other.example' }], ['local-alias', config.application]] as const) {
    await f.connections.configure({ operationId: `configure-${id}`, expectedRevision: null, connection: { ...config, connectionId: id, application } })
    const outcome = await f.ingress.receive({ connectionId: id, raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ actor: { ...f.actor, application } }), opaqueOriginal: { complete: 'preserved payload' } }) }, vi.fn()).then(accepted => ({ accepted, error: null }), error => ({ accepted: null, error: error.code }))
    expect(outcome.error).toBeNull()
    expect(outcome.accepted!.ingress.ingressId === first.ingress.ingressId).toBe(id === 'local-alias')
  }
  expect(f.connections.database.prepare('SELECT COUNT(*) AS n FROM connection_ingress_message').get()!.n).toBe(3)
})

it('authentication failure and failed persistence never ACK or create Core input; post-commit failure retains original payload', async () => {
  const f = await fixture(), ack = vi.fn()
  await expect(f.ingress.receive({ connectionId: config.connectionId, raw: JSON.stringify({ authenticated: true, event: f.event() }) }, ack)).rejects.toMatchObject({ code: 'INGRESS_AUTHENTICATION_FAILED' })
  expect(ack).not.toHaveBeenCalled()
  const originalPrepare = f.connections.database.prepare.bind(f.connections.database)
  const failure = vi.spyOn(f.connections.database, 'prepare').mockImplementation(sql => {
    if (sql.startsWith('INSERT INTO connection_ingress_event')) throw new Error('Injected disk failure before durable event')
    return originalPrepare(sql)
  })
  await expect(f.receive({}, ack)).rejects.toMatchObject({ code: 'INGRESS_STORAGE_UNCONFIRMED' })
  failure.mockRestore()
  const before = new DatabaseSync(f.databasePath)
  expect(before.prepare('SELECT COUNT(*) AS n FROM connection_ingress_message').get()!.n).toBe(0); before.close()
  expect(ack).not.toHaveBeenCalled()
  await expect(f.receive({}, () => { throw new Error('Transport response lost after durable commit') })).rejects.toThrow('Transport response lost')
  const reopened = new ConnectionHost({ databasePath: f.databasePath, secrets: { resolve: async () => null } })
  try {
    const restored = new DurableIngressHost({ ...f.options, connections: reopened })
    const page = await restored.list({ connectionId: config.connectionId })
    expect(page.ingresses).toHaveLength(1); expect(page.ingresses[0]!.body).toBe(f.event().body)
    const retry = await restored.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event(), opaqueOriginal: { complete: 'preserved payload' } }) }, ack)
    expect(retry.duplicate).toBe('event'); expect(ack).toHaveBeenCalledOnce()
  } finally { reopened.close() }
})

it.each(['wrong-room', 'wrong-actor', 'wrong-id-type', 'ordinary-message', 'revoked'] as const)('rejects only the %s intake with a durable reason and retains a healthy original Session', async scenario => {
  const f = await fixture(), overrides = scenario === 'wrong-room' ? { externalConversationId: 'different-room' } : scenario === 'wrong-actor' ? { actor: { ...f.actor, userId: 'different-user' } } : scenario === 'wrong-id-type' ? { actor: { ...f.actor, idType: 'union_id' } } : scenario === 'ordinary-message' ? { selection: 'message' as const } : {}
  if (scenario === 'revoked') await f.bindings.grant({ ...f.grant, operationId: 'revoke', expectedRevision: 1, state: 'revoked' }, context)
  const received = await f.receive(overrides), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const result = await f.ingress.dispatch(received.ingress.ingressId)
  expect(result.ingress).toMatchObject({ state: 'refused', code: scenario === 'wrong-room' ? 'INGRESS_BINDING_UNAVAILABLE' : scenario === 'ordinary-message' ? 'INGRESS_INPUT_OUTSIDE_SCOPE' : 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(submit).not.toHaveBeenCalled()
  expect((await f.client.readAgentSessions()).find(session => session.agentSessionId === f.input.agentSessionId)!.run).toEqual(f.session.run)
})

it('saves stable IDs before the possible Core call, and a lost reply or restart only inspects the same original operation', async () => {
  const f = await fixture(), received = await f.receive(), original = f.client.submitAgentMessage.bind(f.client)
  const submit = vi.spyOn(f.client, 'submitAgentMessage').mockImplementation(async (input, callContext) => {
    const disk = new DatabaseSync(f.databasePath)
    try { const row = disk.prepare('SELECT record_json FROM connection_ingress_message WHERE ingress_id=?').get(received.ingress.ingressId)!; expect(JSON.parse(String(row.record_json)).input).toMatchObject({ operationId: input.envelope.operationId, messageId: input.envelope.messageId, expectedRun: f.session.run }) }
    finally { disk.close() }
    await original(input, callContext); throw new Error('Lost original Core response')
  })
  const first = await f.ingress.dispatch(received.ingress.ingressId)
  expect(first.ingress!.state).toBe('claimed'); expect(first.inputReceipt).not.toBeNull()
  const ref = first.ingress!.input!
  const restarted = new DurableIngressHost(f.options)
  const second = await restarted.dispatch(received.ingress.ingressId)
  expect(second.ingress!.input).toEqual(ref); expect(second.inputReceipt!.originalControlOperationId).toBe(ref.operationId)
  expect(submit).toHaveBeenCalledOnce()
  // Revocation affects future admission/rejoin only; reading original facts remains available.
  await f.bindings.grant({ ...f.grant, operationId: 'revoke-original', expectedRevision: 1, state: 'revoked' }, context)
  expect((await restarted.inspect({ ingressId: received.ingress.ingressId })).inputReceipt!.key).toEqual(first.inputReceipt!.key)
  await expect(f.client.rejoinAgentInputWaiting({ ref: first.inputReceipt!.ref })).rejects.toMatchObject({ code: 'EXTERNAL_AUTHOR_REQUIRED' })
  await expect(restarted.rejoin(received.ingress.ingressId)).rejects.toMatchObject({ code: 'INGRESS_ACTOR_NOT_AUTHORIZED' })
  expect(submit).toHaveBeenCalledOnce()
})

it('a crash window before Core persistence stays unknown without retargeting or resubmitting, while later messages use the current Run', async () => {
  const f = await fixture(), received = await f.receive(), submit = vi.spyOn(f.client, 'submitAgentMessage').mockRejectedValueOnce(new Error('Before original Core save'))
  const first = await f.ingress.dispatch(received.ingress.ingressId), frozen = first.ingress!.input!
  expect(first.inputReceipt).toBeNull()
  const originalSession = (await f.store.readMetadata(f.input.agentSessionId))!
  await f.store.compareAndSwap(originalSession, { ...originalSession, run: { runId: 'replacement-run' } })
  const restarted = new DurableIngressHost(f.options)
  expect((await restarted.dispatch(received.ingress.ingressId)).ingress!.input).toEqual(frozen)
  expect(submit).toHaveBeenCalledOnce()
  const later = await f.receive({ eventId: 'later-event', messageId: 'later-message' })
  const next = await restarted.dispatch(later.ingress.ingressId)
  expect(next.ingress!.input!.expectedRun.runId).toBe('replacement-run')
  expect(next.ingress!.input!.operationId).not.toBe(frozen.operationId)
  expect(submit).toHaveBeenCalledTimes(2)
})

it.each(['before', 'after'] as const)('real process crash %s intake commit preserves ACK and original persistence boundaries', async phase => {
  const f = await fixture()
  const { spawn } = await import('node:child_process'), { existsSync } = await import('node:fs'), { pathToFileURL } = await import('node:url')
  const { join, resolve } = await import('node:path')
  const raw = JSON.stringify({ proof: 'adapter-private-witness', event: f.event(), opaqueOriginal: { complete: 'preserved payload' } }), ackPath = join(f.root, 'crash-ack')
  const program = `
    const [entry, databasePath, phase, connectionId, raw, ackPath] = process.argv.slice(1);
    const { ConnectionHost, DurableIngressHost } = await import(entry);
    const { writeFileSync } = await import('node:fs');
    const connections = new ConnectionHost({ databasePath, secrets: { resolve: async () => null } });
    const ingress = new DurableIngressHost({ connections, bindings: {}, core: () => undefined, authenticators: [{ adapterId: 'sample', verify: async (_config, raw) => JSON.parse(raw).event }] });
    const original = connections.database.exec.bind(connections.database);
    connections.database.exec = sql => {
      if (sql === 'COMMIT' && phase === 'before') process.exit(71);
      const result = original(sql);
      if (sql === 'COMMIT' && phase === 'after') process.exit(72);
      return result;
    };
    await ingress.receive({ connectionId, raw }, () => writeFileSync(ackPath, 'acknowledged'));
  `
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, pathToFileURL(resolve('packages/connectors/dist/index.js')).href, f.databasePath, phase, config.connectionId, raw, ackPath], { stdio: 'ignore' })
    child.once('error', reject); child.once('exit', resolveExit)
  })
  expect(code).toBe(phase === 'before' ? 71 : 72); expect(existsSync(ackPath)).toBe(false)
  const reopened = new ConnectionHost({ databasePath: f.databasePath, secrets: { resolve: async () => null } })
  try {
    const records = reopened.database.prepare('SELECT raw_payload FROM connection_ingress_event').all()
    expect(records).toHaveLength(phase === 'before' ? 0 : 1)
    if (phase === 'after') expect(records[0]!.raw_payload).toBe(raw)
    const owner = new DurableIngressHost({ ...f.options, connections: reopened })
    const retry = await owner.receive({ connectionId: config.connectionId, raw }, vi.fn())
    expect(retry.duplicate).toBe(phase === 'after' ? 'event' : null)
  } finally { reopened.close() }
})

it('bounded original intake pages retain exact connection cursors without creating input', async () => {
  const f = await fixture(), first = await f.receive(), second = await f.receive({ eventId: 'page-event', messageId: 'page-message' }), submit = vi.spyOn(f.client, 'submitAgentMessage')
  const page = await f.ingress.list({ connectionId: config.connectionId, limit: 1 })
  expect(page.ingresses).toEqual([first.ingress]); expect(page.nextAfterIngressId).toBe(first.ingress.ingressId)
  expect(await f.ingress.list({ connectionId: config.connectionId, afterIngressId: page.nextAfterIngressId!, limit: 1 })).toEqual({ ingresses: [second.ingress], nextAfterIngressId: null })
  await expect(f.ingress.list({ connectionId: 'other-connection', afterIngressId: first.ingress.ingressId })).rejects.toMatchObject({ code: 'INGRESS_CURSOR_MISMATCH' })
  await expect(f.ingress.list({ connectionId: config.connectionId, limit: 101 })).rejects.toMatchObject({ code: 'INVALID_CONNECTION_INGRESS' })
  expect(submit).not.toHaveBeenCalled()
})

it('a wrong original Core input result stays unavailable and cannot rejoin another producer', async () => {
  const f = await fixture(), accepted = await f.receive(), original = await f.ingress.dispatch(accepted.ingress.ingressId)
  await vi.waitFor(async () => expect((await f.ingress.inspect({ ingressId: accepted.ingress.ingressId })).inputReceipt!.control.waiting?.phase).toBe('runtime'))
  const key = { ...original.inputReceipt!.key, agentSessionId: 'foreign-session' }, ref = { ...original.inputReceipt!.ref, key }
  vi.spyOn(f.client, 'inspectAgentInput').mockResolvedValue({ ...original.inputReceipt!, key, ref, control: { ...original.inputReceipt!.control, ref } })
  const rejoin = vi.spyOn(f.client, 'rejoinAgentInputWaiting')
  expect(await f.ingress.rejoin(accepted.ingress.ingressId)).toEqual({ ingress: original.ingress, inputReceipt: null, observation: 'unavailable' })
  expect(rejoin).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
