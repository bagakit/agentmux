import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/dist/index.js'
import { parseConnectionIngressRecord, parseIngressResult } from '../../core/dist/connections.js'
import { ConnectionHost, DurableIngressHost } from '../dist/index.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { ingressFixture } from './fixtures/ingress.js'
import { feishuConfig, feishuSdkTransport } from './fixtures/feishu.js'
import { config } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function actionPayload(eventId = 'native-action-event') {
  return { schema: '2.0', header: { app_id: feishuConfig.application.appId, event_id: eventId, event_type: 'card.action.trigger', token: 'private-header-token' },
    event: { operator: { open_id: 'original-external-user', user_id: 'other-id-namespace' }, token: 'private-update-token', host: 'im_message',
      context: { open_chat_id: 'original-room', open_message_id: 'original-card' },
      action: { tag: 'button', value: { actionRef: 'opaque-original-action', permission: 'untrusted-permission-word' }, form_value: { answer: '原文\n' + '完整'.repeat(12_000) } },
      untouched: { original: ['complete', 'callback'] } } }
}

it('default Desktop receives original SDK actions before ACK and exposes unsupported receipts through actual CLI without input', async () => {
  const f = await ingressFixture(true, feishuConfig); cleanup.push(() => f.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const sdk = feishuSdkTransport()
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(sdk.http.request)
  const services = await createDesktopConnections({ directory: join(f.root, 'desktop-actions'),
    encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    bindings: { spatial: f.spatial, checkpoint: async ref => ({ ...ref, checkpoint: await f.client.conversationCheckpoint(ref.agentSessionId) }) },
    ingress: { core: hostId => hostId === 'local' ? f.client : undefined } })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'action-credential', secret: 'fixture-credential' })
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'actions.sock'), connections: services.connections, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(f.root), cli = async (args: string[], input?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], env, input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    return JSON.parse(result.stdout).result
  }
  await cli(['configure', '--input', '-'], { operationId: 'enable-action-receiver', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  const ingress = services.ingress!, payload = actionPayload(), raw = JSON.stringify(payload)
  const submit = vi.spyOn(f.client, 'submitAgentMessage'), reply = vi.spyOn(f.client, 'replySessionQuestion'), respond = vi.spyOn(f.client, 'respondAgentInteraction')
  const receive = ingress.receive.bind(ingress), received: Awaited<ReturnType<typeof receive>>[] = []
  vi.spyOn(ingress, 'receive').mockImplementation(async (input, acknowledge) => {
    const originalAckCount = sdk.ack().length
    const result = await receive(input, async () => {
      expect(sdk.ack()).toHaveLength(originalAckCount)
      const disk = new DatabaseSync(join(f.root, 'desktop-actions', 'connections.sqlite'))
      try {
        const stored = disk.prepare('SELECT raw_payload,record_json FROM connection_ingress_event WHERE event_id=?').get(resultEvent(input.raw))!
        expect(stored.raw_payload).toBe(input.raw)
        expect(JSON.parse(String(stored.record_json))).toMatchObject({ kind: 'action', state: 'refused', code: 'INGRESS_ACTION_UNSUPPORTED' })
      } finally { disk.close() }
      await acknowledge()
    })
    received.push(result)
    return result
  })
  await sdk.receive(payload)
  await sdk.receive(payload)
  await sdk.receive(actionPayload('another-native-action-event'))
  expect(sdk.ack().map(ack => ack.code)).toEqual([200, 200, 200])
  expect(received.map(item => item.duplicate)).toEqual([null, 'event', null])
  expect(received[1]!.ingress).toEqual(received[0]!.ingress)
  expect(received[2]!.ingress.ingressId).not.toBe(received[0]!.ingress.ingressId)
  const firstPage = await cli(['ingress', 'ls', '--connection', feishuConfig.connectionId, '--limit', '1'])
  expect(firstPage.ingresses).toEqual([received[0]!.ingress])
  expect(firstPage.nextAfterIngressId).toBe(received[0]!.ingress.ingressId)
  const secondPage = await cli(['ingress', 'ls', '--connection', feishuConfig.connectionId, '--after-ingress', firstPage.nextAfterIngressId, '--limit', '1'])
  expect(secondPage.ingresses).toEqual([received[2]!.ingress]); expect(secondPage.nextAfterIngressId).toBeNull()
  const inspected = await cli(['ingress', 'inspect', '--ingress', received[0]!.ingress.ingressId])
  expect(inspected).toEqual({ ingress: received[0]!.ingress, inputReceipt: null, observation: 'not-started' })
  expect(inspected.ingress).toMatchObject({ kind: 'action', actor: { application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' },
    sourceMessageId: 'original-card', externalConversationId: 'original-room', actionRef: 'opaque-original-action', state: 'refused', code: 'INGRESS_ACTION_UNSUPPORTED' })
  for (const field of ['body', 'input', 'externalMessageId', 'token', 'transportProof', 'form_value']) expect(inspected.ingress).not.toHaveProperty(field)
  expect(JSON.stringify(inspected)).not.toContain('private-update-token')
  const conflicting = actionPayload(); conflicting.event.action.form_value.answer = 'Different authenticated callback content'
  await sdk.receive(conflicting)
  expect(sdk.ack().map(ack => ack.code)).toEqual([200, 200, 200, 500])
  expect((await cli(['ingress', 'inspect', '--ingress', inspected.ingress.ingressId])).ingress).toEqual(inspected.ingress)
  const missing = actionPayload('missing-context-event')
  Reflect.deleteProperty(missing.event, 'operator'); Reflect.deleteProperty(missing.event, 'context'); Reflect.deleteProperty(missing.event.action, 'value')
  await sdk.receive(missing)
  expect(sdk.ack().map(ack => ack.code)).toEqual([200, 200, 200, 500, 200])
  const missingRecord = (await cli(['ingress', 'ls', '--connection', feishuConfig.connectionId])).ingresses.find((record: { eventId: string }) => record.eventId === 'missing-context-event')
  expect(missingRecord).toMatchObject({ kind: 'action', state: 'refused', code: 'INGRESS_ACTION_UNSUPPORTED' })
  for (const field of ['actor', 'externalConversationId', 'sourceMessageId', 'actionRef']) expect(missingRecord).not.toHaveProperty(field)
  const fakeAck = vi.fn()
  await expect(ingress.receive({ connectionId: feishuConfig.connectionId, raw, transportProof: { authenticated: true, appId: feishuConfig.application.appId } }, fakeAck))
    .rejects.toMatchObject({ code: 'INGRESS_AUTHENTICATION_FAILED' })
  expect(fakeAck).not.toHaveBeenCalled()
  expect(await ingress.dispatch(inspected.ingress.ingressId)).toEqual(inspected)
  expect(await ingress.rejoin(inspected.ingress.ingressId)).toEqual(inspected)
  expect(ingress.received(feishuConfig.connectionId).ingressIds).toEqual([])
  expect(await ingress.authority({ operationId: 'opaque-original-action' })).toEqual({ ingress: null, authority: 'refused', code: 'INGRESS_CLAIM_UNAVAILABLE' })
  expect(submit).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  await f.client.submitAgentPrompt({ agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, operationId: 'ordinary-local-prompt',
    prompt: 'Ordinary local prompt remains available', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', authorHuman: true })
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const ordinary = await f.client.inspectAgentInput({ key: { kind: 'prompt', agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, submissionId: 'ordinary-local-prompt' } })
  expect(ordinary?.status).toBe('terminal-confirmed')
  await f.client.writeAgent({ agentSessionId: f.input.agentSessionId, expectedRun: f.session.run, source: 'user', data: 'Ordinary local input remains available' })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(2)
  expect(f.client.agentSession(f.input.agentSessionId).run).toEqual(f.session.run)
  const evidence = resolve('.bagakit/evidence/action-ingress'); await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'default-desktop-consumer.json'), JSON.stringify({
    scope: 'Default Desktop registered SDK receiver, controlled official SDK network/WS I/O, actual Core and compiled CLI; no live platform or Native qualification',
    rawBytes: Buffer.byteLength(raw), ack: sdk.ack(), receipts: received, firstPage, secondPage, inspected,
    externalQuestionInputs: 0, ordinaryLocalPrompt: ordinary, ordinaryLocalInputAccepted: true, originalSessionAndRunRetained: true
  }, null, 2) + '\n')
}, 25_000)
function resultEvent(raw: string): string { return JSON.parse(raw).header.event_id }

it('retains truthful missing native context and rejects malformed public action receipts', async () => {
  const base = { kind: 'action', ingressId: 'original-ingress', connectionId: 'original-connection', application: config.application,
    eventId: 'original-event', state: 'refused', code: 'INGRESS_ACTION_UNSUPPORTED' }
  expect(parseConnectionIngressRecord(base)).toEqual(base)
  for (const malformed of [{ state: 'received' }, { code: ['INGRESS_ACTION_UNSUPPORTED'] }, { body: '' }, { input: {} }, { actor: { application: config.application, idType: 'open_id', userId: [] } }, { actionRef: {} }]) {
    expect(() => parseConnectionIngressRecord({ ...base, ...malformed })).toThrow()
  }
  expect(parseIngressResult('connection.ingress.inspect', { ingress: base, inputReceipt: null, observation: 'not-started' }, { ingressId: base.ingressId })).toEqual({ ingress: base, inputReceipt: null, observation: 'not-started' })
})

it('reopens original message rows unchanged and bounds mixed message/action pages in the original database', async () => {
  const f = await ingressFixture(); cleanup.push(() => f.close())
  const first = await f.receive(), messageRows = f.connections.database.prepare('SELECT * FROM connection_ingress_message').all(), eventRows = f.connections.database.prepare('SELECT domain,app_id,event_id,ingress_id,event_json,raw_payload FROM connection_ingress_event').all()
  const legacyPath = join(f.root, 'original-ingress.sqlite'), legacy = new DatabaseSync(legacyPath)
  legacy.exec('CREATE TABLE connection_ingress_message (sequence INTEGER PRIMARY KEY AUTOINCREMENT, ingress_id TEXT NOT NULL UNIQUE, domain TEXT NOT NULL, app_id TEXT NOT NULL, message_id TEXT NOT NULL, connection_id TEXT NOT NULL, event_json TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(domain,app_id,message_id)); CREATE TABLE connection_ingress_event (domain TEXT NOT NULL, app_id TEXT NOT NULL, event_id TEXT NOT NULL, ingress_id TEXT NOT NULL, event_json TEXT NOT NULL, raw_payload TEXT NOT NULL, PRIMARY KEY(domain,app_id,event_id));')
  for (const row of messageRows) legacy.prepare('INSERT INTO connection_ingress_message VALUES (?,?,?,?,?,?,?,?)').run(row.sequence, row.ingress_id, row.domain, row.app_id, row.message_id, row.connection_id, row.event_json, row.record_json)
  for (const row of eventRows) legacy.prepare('INSERT INTO connection_ingress_event VALUES (?,?,?,?,?,?)').run(row.domain, row.app_id, row.event_id, row.ingress_id, row.event_json, row.raw_payload)
  legacy.close()
  const connections = new ConnectionHost({ databasePath: legacyPath, secrets: { resolve: async () => null } }); cleanup.push(() => connections.close())
  await connections.configure({ operationId: 'reopen-original-config', expectedRevision: null, connection: config })
  const owner = new DurableIngressHost({ ...f.options, connections }), action = { kind: 'action', eventId: 'original-message', actor: f.actor, externalConversationId: 'original-room', sourceMessageId: 'original-message', actionRef: 'original-action' }
  const raw = JSON.stringify({ proof: 'adapter-private-witness', event: action, privateOriginal: 'retained' })
  const second = await owner.receive({ connectionId: config.connectionId, raw }, vi.fn())
  const third = await owner.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ eventId: 'later-event', messageId: 'later-message' }) }) }, vi.fn())
  expect(connections.database.prepare('SELECT * FROM connection_ingress_message WHERE ingress_id=?').get(first.ingress.ingressId)).toEqual(messageRows[0])
  const rows = []
  let afterIngressId: string | undefined
  do {
    const page = await owner.list({ connectionId: config.connectionId, limit: 1, ...(afterIngressId ? { afterIngressId } : {}) })
    rows.push(...page.ingresses); afterIngressId = page.nextAfterIngressId ?? undefined
  } while (afterIngressId)
  expect(rows).toEqual([first.ingress, second.ingress, third.ingress])
  expect((await owner.receive({ connectionId: config.connectionId, raw }, vi.fn())).ingress).toEqual(second.ingress)
  expect((await owner.receive({ connectionId: config.connectionId, raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event() }) }, vi.fn())).ingress).toEqual(first.ingress)
  const query = 'SELECT sequence,connection_id,ingress_id,record_json FROM connection_ingress_message UNION ALL SELECT intake_sequence AS sequence,connection_id,ingress_id,record_json FROM connection_ingress_event WHERE record_json IS NOT NULL'
  const plan = connections.database.prepare(`EXPLAIN QUERY PLAN SELECT record_json FROM (${query}) WHERE connection_id=? AND sequence>? ORDER BY sequence LIMIT ?`).all(config.connectionId, 0, 2).map(row => String(row.detail))
  expect(plan.some(detail => detail.includes('connection_ingress_message_connection'))).toBe(true)
  expect(plan.some(detail => detail.includes('connection_ingress_action_connection'))).toBe(true)
  const sequences = connections.database.prepare(`SELECT sequence FROM (${query}) ORDER BY sequence`).all().map(row => row.sequence)
  expect(sequences).toEqual([messageRows[0]!.sequence, Number(messageRows[0]!.sequence) + 1, Number(messageRows[0]!.sequence) + 2])
})

it.each(['before', 'after'] as const)('a real process crash %s action COMMIT keeps the original ACK/raw/receipt boundary', async phase => {
  const f = await ingressFixture(); cleanup.push(() => f.close())
  const event = { kind: 'action', eventId: 'crash-action-event', actor: f.actor, sourceMessageId: 'original-card' }, raw = JSON.stringify({ proof: 'adapter-private-witness', event, original: '完整'.repeat(12_000) }), ackPath = join(f.root, 'action-ack')
  const program = `
    const [entry,databasePath,phase,connectionId,raw,ackPath]=process.argv.slice(1);
    const {ConnectionHost,DurableIngressHost}=await import(entry);
    const {writeFileSync}=await import('node:fs');
    const connections=new ConnectionHost({databasePath,secrets:{resolve:async()=>null}});
    const ingress=new DurableIngressHost({connections,bindings:{},core:()=>undefined,authenticators:[{adapterId:'sample',verify:async(_config,raw)=>JSON.parse(raw).event}]});
    const exec=connections.database.exec.bind(connections.database);
    connections.database.exec=sql=>{if(sql==='COMMIT'&&phase==='before')process.exit(71);const result=exec(sql);if(sql==='COMMIT'&&phase==='after')process.exit(72);return result;};
    await ingress.receive({connectionId,raw},()=>writeFileSync(ackPath,'acknowledged'));
  `
  const code = await new Promise<number | null>((resolveExit, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, pathToFileURL(resolve('packages/connectors/dist/index.js')).href, f.databasePath, phase, config.connectionId, raw, ackPath], { stdio: 'ignore' })
    child.once('error', reject); child.once('exit', resolveExit)
  })
  expect(code).toBe(phase === 'before' ? 71 : 72); expect(existsSync(ackPath)).toBe(false)
  const connections = new ConnectionHost({ databasePath: f.databasePath, secrets: { resolve: async () => null } }); cleanup.push(() => connections.close())
  const rows = connections.database.prepare('SELECT raw_payload,record_json FROM connection_ingress_event WHERE event_id=?').all(event.eventId)
  expect(rows).toHaveLength(phase === 'after' ? 1 : 0)
  if (phase === 'after') { expect(rows[0]!.raw_payload).toBe(raw); expect(JSON.parse(String(rows[0]!.record_json))).toMatchObject({ kind: 'action', code: 'INGRESS_ACTION_UNSUPPORTED' }) }
  const owner = new DurableIngressHost({ ...f.options, connections }), ack = vi.fn()
  const retry = await owner.receive({ connectionId: config.connectionId, raw }, ack)
  expect(ack).toHaveBeenCalledOnce(); expect(retry.duplicate).toBe(phase === 'after' ? 'event' : null)
  if (phase === 'after') expect(retry.ingress).toEqual(JSON.parse(String(rows[0]!.record_json)))
})
