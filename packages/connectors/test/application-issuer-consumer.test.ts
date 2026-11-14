import { afterEach, expect, it } from 'vitest'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'
import { ChannelStorage } from '../src/channel-storage.js'
import { parseConnectionApplication } from '@agentmux/core/connections'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('keeps the same native identity and message on distinct authenticated application scopes', async () => {
  const application = { domain: 'chat.example', appId: '@member:example.org', issuer: 'https://one.example:8443' }
  const secondApplication = { ...application, issuer: 'https://two.example:9443' }
  const f = await ingressFixture(false, { ...config, application }); cleanup.push(() => f.close())
  await f.connections.configure({ operationId: 'configure-second', expectedRevision: null, connection: { ...config, connectionId: 'second-connection', application: secondApplication } })
  const second = { ...f.input, operationId: 'bind-second', bindingId: 'second-binding', connectionId: 'second-connection' }
  expect(await f.bindings.bind(second, context)).toMatchObject({ state: 'applied', binding: { application: secondApplication } })
  const actor = { ...f.actor, application: secondApplication }
  expect(f.bindings.effectiveGrant('second-binding', 1, f.actor)).toBeNull()
  expect(f.bindings.effectiveGrant('second-binding', 1, actor)).toBeNull()
  expect(await f.bindings.grant({ ...f.grant, operationId: 'second-grant', grantId: 'second-grant', bindingId: 'second-binding', actor }, context)).toMatchObject({ state: 'applied' })
  expect(f.bindings.effectiveGrant('second-binding', 1, actor)?.actor).toEqual(actor)
  const first = await f.receive({ conversationKind: 'group' })
  const event = { ...f.event({ conversationKind: 'group' }), actor }
  const other = await f.ingress.receive({ connectionId: 'second-connection', raw: JSON.stringify({ proof: 'adapter-private-witness', event }) }, async () => {})
  expect(other.duplicate).toBeNull(); expect(other.ingress.ingressId).not.toBe(first.ingress.ingressId)
  expect(other.ingress.application).toEqual(secondApplication)
  expect((await f.ingress.inspect({ ingressId: first.ingress.ingressId })).ingress!.application).toEqual(application)
  expect(f.ingress.listApplication(application, { after: 0 }, 10).rows.map(row => row.record.ingressId)).toEqual([first.ingress.ingressId])
  expect(f.ingress.listApplication(secondApplication, { before: Number.MAX_SAFE_INTEGER }, 10).rows.map(row => row.record.ingressId)).toEqual([other.ingress.ingressId])
  expect(f.ingress.countApplication(secondApplication, 0, 5)).toEqual({ count: 1, more: false })
  expect(f.ingress.newestApplication(application)).toBe(f.ingress.listApplication(application, { after: 0 }, 1).rows[0]!.sequence)
  expect(f.ingress.newestApplication({ domain: application.domain, appId: application.appId })).toBeNull()
  const store = new ChannelStorage(f.connections.database)
  const a = store.namespace({ adapterId: 'sample', application }), b = store.namespace({ adapterId: 'sample', application: secondApplication })
  a.put({ key: 'cursor', value: { kind: 'json', value: 'one' }, expectedRevision: null })
  b.put({ key: 'cursor', value: { kind: 'json', value: 'two' }, expectedRevision: null })
  expect(a.get('cursor')?.value).toEqual({ kind: 'json', value: 'one' })
  expect(b.get('cursor')?.value).toEqual({ kind: 'json', value: 'two' })
  // Historical profile receipts predate issuers; an issuer-scoped application never inherits one.
  const historical = { operationId: 'historical-profile-write', connectionId: 'historical-alias', connectionRevision: 1, application: { domain: application.domain, appId: application.appId }, language: null,
    fields: ['name', 'avatar'], desired: { name: 'Historical name', avatarSha256: 'a'.repeat(64) }, upload: { state: 'confirmed' }, patch: { state: 'unknown' }, publication: 'not-requested', online: null }
  f.connections.database.exec('CREATE TABLE connection_profile_operation (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL UNIQUE,connection_id TEXT NOT NULL,input_json TEXT NOT NULL,config_json TEXT NOT NULL,actor_json TEXT NOT NULL,record_json TEXT NOT NULL,upload_wire TEXT,patch_wire TEXT,avatar_url TEXT)')
  f.connections.database.prepare('INSERT INTO connection_profile_operation(operation_id,connection_id,input_json,config_json,actor_json,record_json) VALUES(?,?,?,?,?,?)')
    .run(historical.operationId, historical.connectionId, '{}', '{}', JSON.stringify(context.actor), JSON.stringify(historical))
  expect(f.connections.unresolvedProfileWrite(historical.application, context.actor)).toEqual({ unresolved: true, original: { operationId: historical.operationId, connectionId: historical.connectionId } })
  expect(f.connections.unresolvedProfileWrite(application, context.actor)).toBeNull()
  expect(f.connections.unresolvedProfileWrite(secondApplication, context.actor)).toBeNull()
  expect(parseConnectionApplication({ domain: 'chat.example', appId: '+123456' }).appId).toBe('+123456')
  expect(() => parseConnectionApplication({ domain: 'chat.example', appId: 'bad\u0000id' })).toThrow()
}, 30_000)

it('global native adapters refuse a configured issuer before native authentication or setup', async () => {
  const { FeishuAdapter } = await import('../src/adapters/feishu/index.js')
  const { DiscordAdapter } = await import('../src/adapters/discord/index.js')
  const { beginFeishuSession, applicationRequest } = await import('../src/adapters/feishu/setup-session.js')
  const feishu = new FeishuAdapter(), discord = new DiscordAdapter()
  cleanup.push(async () => { feishu.close(); discord.close() })
  const unsupported = { ...config, adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: 'cli_original', issuer: 'https://other.example' } }
  await expect(feishu.test(unsupported, 'unused')).rejects.toMatchObject({ code: 'FEISHU_APPLICATION_INVALID' })
  expect((await discord.test({ ...unsupported, adapterId: 'discord', application: { domain: 'discord.com', appId: '12345', issuer: 'https://other.example' } }, 'unused')).authentication.state).toBe('unavailable')
  const setup = { application: unsupported.application, operationId: 'op', connectionId: 'conn', attemptId: 'attempt' } as Parameters<typeof beginFeishuSession>[0]
  expect(await beginFeishuSession(setup)).toEqual({ kind: 'unknown' })
  expect(await applicationRequest({ ...setup, privateState: '{}' }, '/test', {})).toEqual({ payload: null })
})

it.each(['@account:example.org', '+123456'])('retains native identity %s across the real services and public RPC owner', async (appId) => {
  const core = await import('../../core/dist/index.js')
  const { createConnectionServices, createPublicationConversationPort } = await import('../src/index.js')
  const { applicationScopeWire } = await import('./fixtures/application-scope-wire.js')
  const { join } = await import('node:path')
  const { appendFile } = await import('node:fs/promises')
  const { vi } = await import('vitest')
  const f = await ingressFixture(true); cleanup.push(() => f.close())
  const wire = await applicationScopeWire(appId); cleanup.push(() => wire.close())
  const options = { directory: join(f.root, 'scoped-services'), adapters: [wire.adapter],
    bindings: { spatial: f.spatial, checkpoint: input => f.client.conversationCheckpoint(input) },
    ingress: { core: host => host === 'local' ? f.client : undefined }, publication: createPublicationConversationPort(f.coreClients) } satisfies Parameters<typeof createConnectionServices>[0]
  let service = await createConnectionServices(options)
  cleanup.push(async () => service.close())
  const runtime = new core.AgentMuxHostedRuntimeService(f.client, null, () => ({ runtimeId: 'issuer-runtime', ownerInstanceId: 'issuer-owner', protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null }))
  cleanup.push(() => runtime.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'scoped.sock'), connections: new Proxy({} as typeof service.connections, { get: (_, key) => { const value = Reflect.get(service.connections, key); return typeof value === 'function' ? value.bind(service.connections) : value } }), spatialState: f.spatial, coreClients: f.coreClients, hostedRuntime: () => runtime })
  await server.start(); cleanup.push(async () => server.stop())
  const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(async () => sdk.dispose())
  const credential = await service.secrets.store({ operationId: 'scoped-credential', secret: 'native-secret-one' })
  const credential2 = await service.secrets.store({ operationId: 'scoped-credential-two', secret: 'native-secret-two' })
  const app = { domain: 'signed.example', appId, issuer: wire.origins[0]! }
  const app2 = { ...app, issuer: wire.origins[1]! }
  const first = { connectionId: 'issuer-first', adapterId: 'issuer-fixture', application: app, enabled: true, label: 'First', credentialRef: credential.credentialRef }
  const second = { ...first, connectionId: 'issuer-second', label: 'Second', application: app2, credentialRef: credential2.credentialRef }
  expect((await sdk.call('connection.configure', { operationId: 'issuer-config-first', expectedRevision: null, connection: first })).connection.config.application).toEqual(app)
  const { objectCliEnvironment, runCompiledObjectCli } = await import('../../core/test/helpers/object-cli-rpc.js')
  const { resolve } = await import('node:path')
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const help = await runCompiledObjectCli(['connection', 'configure', '--help'], objectCliEnvironment(f.root))
  expect(help.code, help.stderr).toBe(0)
  expect(help.stdout).toContain('optional issuer')
  const configured = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'configure', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ operationId: 'issuer-config-second', expectedRevision: null, connection: second }))
  expect(configured.code, configured.stderr).toBe(0)
  expect(JSON.parse(configured.stdout).result.connection.config.application).toEqual(app2)
  const base = { ...f.input, connectionId: first.connectionId, bindingId: 'issuer-first-binding', operationId: 'issuer-bind-first', scope: { ...f.input.scope, input: 'all-messages' as const } }
  expect((await sdk.call('connection.bind', base)).state).toBe('applied')
  expect((await sdk.call('connection.bind', { ...base, connectionId: second.connectionId, bindingId: 'issuer-second-binding', operationId: 'issuer-bind-second' })).state).toBe('applied')
  const actor = { application: app, idType: 'native-user', userId: 'original-external-user' }
  const actor2 = { ...actor, application: app2 }
  const grant = { ...f.grant, operationId: 'issuer-grant-first', grantId: 'issuer-first-grant', bindingId: base.bindingId, actor }
  expect((await sdk.call('connection.grant', grant)).state).toBe('applied')
  expect(service.bindings!.effectiveGrant('issuer-second-binding', 1, actor)).toBeNull()
  expect((await sdk.call('connection.grant', { ...grant, operationId: 'issuer-grant-second', grantId: 'issuer-second-grant', bindingId: 'issuer-second-binding', actor: actor2 })).state).toBe('applied')
  const rule = { operationId: 'issuer-app-rule', connectionId: first.connectionId, expectedConnectionRevision: 1, grantId: 'issuer-app-rule', expectedRevision: null, actor, state: 'active' as const, capabilities: ['input' as const] }
  expect((await sdk.call('connection.application.access.configure', rule)).state).toBe('applied')
  expect((await sdk.call('connection.application.access.get', { connectionId: first.connectionId })).grants.map(value => value.grantId)).toEqual([rule.grantId])
  expect((await sdk.call('connection.application.access.get', { connectionId: second.connectionId })).grants).toEqual([])
  expect((await sdk.call('connection.ls', {})).connections.map(value => value.config.application)).toEqual(expect.arrayContaining([app, app2]))
  expect((await sdk.call('connection.test', { connectionId: first.connectionId })).observation.authentication.state).toBe('ready')
  expect((await sdk.call('connection.test', { connectionId: second.connectionId })).observation.authentication.state).toBe('ready')
  await vi.waitFor(() => expect(wire.origins.every(origin => wire.state(origin).receive)).toBe(true), { timeout: 10000 })
  const event = { eventId: 'same-event', messageId: 'same-message', room: base.externalConversationId, actor: actor.userId, body: 'Original issuer scoped input' }
  const raw = JSON.stringify(event)
  const { createHmac } = await import('node:crypto')
  const foreignProof = { origin: app2.issuer, signature: createHmac('sha256', 'native-secret-two').update(raw).digest('hex') }
  await expect(service.ingress!.receive({ connectionId: first.connectionId, raw, transportProof: foreignProof }, async () => {})).rejects.toThrow()
  expect((await sdk.call('connection.ingress.ls', { connectionId: first.connectionId })).ingresses).toHaveLength(0)
  expect(await wire.post(app.issuer, event)).toBe(202)
  expect(await wire.post(app2.issuer, event)).toBe(202)
  const received = await sdk.call('connection.ingress.ls', { connectionId: first.connectionId })
  const received2 = await sdk.call('connection.ingress.ls', { connectionId: second.connectionId })
  expect(received.ingresses[0]!.application).toEqual(app)
  expect(received2.ingresses[0]!.application).toEqual(app2)
  expect(received.ingresses[0]!.ingressId).not.toBe(received2.ingresses[0]!.ingressId)
  expect((await sdk.call('connection.ingress.inspect', { ingressId: received2.ingresses[0]!.ingressId })).ingress?.application).toEqual(app2)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2), { timeout: 15000 })
  await appendFile(f.transcript, JSON.stringify({ type: 'assistant', sessionId: 'ingress-native', uuid: 'scoped-native-reply', message: { role: 'assistant', content: [{ type: 'text', text: 'Original scoped outgoing reply' }] } }) + '\n')
  service.publication!.refresh()
  await vi.waitFor(() => expect(wire.origins.every(origin => wire.state(origin).messages.some(value => JSON.stringify(value).includes('Original scoped outgoing reply')))).toBe(true), { timeout: 15000 })
  const page = { connectionId: second.connectionId, bindingId: 'issuer-second-binding', bindingRevision: 1 }
  const delivery = await sdk.call('connection.delivery.ls', page)
  expect(delivery.deliveries.some(value => value.target.application.issuer === app2.issuer && value.state === 'confirmed')).toBe(true)
  const { connectHostedAgentMux } = await import('../../core/dist/hosted.js')
  const hosted = await connectHostedAgentMux({ rpc: sdk, waitForReady: false, forwardRpc: (method, params, context = {}) => sdk.call(method, params, { ...(context.runtimeFence ? { runtimeFence: context.runtimeFence } : {}), ...(context.signal ? { signal: context.signal } : {}) }) })
  cleanup.push(() => hosted.dispose())
  expect((await hosted.forwardRpc!('connection.delivery.ls', page)).deliveries.some(value => value.target.application.issuer === app2.issuer && value.state === 'confirmed')).toBe(true)
  const detail = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'inspect', '--connection', second.connectionId], objectCliEnvironment(f.root))
  expect(detail.code, detail.stderr).toBe(0)
  expect(JSON.parse(detail.stdout).result.connection.config.application).toEqual(app2)
  const sent = wire.origins.map(origin => wire.state(origin).messages.length)
  await service.close()
  service = await createConnectionServices(options)
  expect((await sdk.call('connection.ls', {})).connections.map(value => value.config.application)).toEqual(expect.arrayContaining([app, app2]))
  expect(service.bindings!.effectiveGrant('issuer-second-binding', 1, actor)).toBeNull()
  expect(service.bindings!.effectiveGrant('issuer-second-binding', 1, actor2)?.actor).toEqual(actor2)
  await vi.waitFor(() => expect(wire.origins.every(origin => wire.state(origin).receive)).toBe(true), { timeout: 10000 })
  expect(wire.origins.map(origin => wire.state(origin).messages.length)).toEqual(sent)
}, 30_000)
