import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ConnectionApiIdentity, ConnectionRecord } from '@agentmux/core/connections'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import * as core from '../../core/src/index.js'
import { agentPromptCondition } from '../../core/src/agent-prompt-condition.js'
import { createWorkspaceLayout } from '../../core/src/spatial-layout.js'
import { rpcOwnerFixture } from '../../core/test/helpers/public-rpc-owner.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { createBuiltinConnectionAdapters } from '../src/platform-adapters.js'
import { TelegramAdapter } from '../src/adapters/telegram/index.js'
import { ChannelStorage } from '../src/channel-storage.js'
import { telegramConfig, telegramCredential, telegramTransport } from './fixtures/telegram.js'
import { context } from './fixtures/room-binding.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
const until = <T>(read: () => T | Promise<T>, options: { timeout?: number; interval?: number } = {}) => vi.waitFor(read, { timeout: 5_000, ...options })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function fixture(backlog?: string | string[]) {
  const wire = await telegramTransport(); cleanup.push(wire.close)
  if (backlog) { wire.pausePolls(); if (typeof backlog === 'string') wire.message(backlog); else for (const body of backlog) wire.message(body, { mention: false }) }
  const nativeFetch = fetch
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin === 'https://api.telegram.org') return await nativeFetch(wire.origin + url.pathname + url.search, init)
    return await nativeFetch(input, init)
  })
  let services: Awaited<ReturnType<typeof createConnectionServices>>
  class Owner extends core.AgentMuxClient {
    constructor(options: ConstructorParameters<typeof core.AgentMuxClient>[0]) {
      super({ ...options, externalConversationAuthority: { resolveConversationMessage: input => services.ingress!.recordAuthority(input) } })
    }
  }
  const f = await rpcOwnerFixture(['original-agent'], { AgentMuxClient: Owner, AgentMuxFileAgentSessionStore: core.AgentMuxFileAgentSessionStore }, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(f.close)
  const transcript = join(f.root, 'native.jsonl')
  await writeFile(transcript, JSON.stringify({ sessionId: 'original-native', uuid: 'header', type: 'system', subtype: 'init', cwd: f.root }) + '\n')
  f.client.providers.get('claude').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
  const spatial = new core.AgentMuxSpatialStateStore(join(f.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [{ spaceId: 'space', kind: 'topic', name: 'Telegram team', hostId: 'local', directoryPath: f.root, projectId: 'project' }],
    zones: [{ zoneId: 'zone', workspaceId: 'resource', kind: 'directory', hostId: 'local', directoryPath: f.root, branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'resource', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-agent', runId: null, execution: { hostId: 'local', cwd: f.root } }],
    bindings: [{ zoneId: 'zone', spaceId: 'space' }], layouts: { resource: createWorkspaceLayout('group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: {}
  } })
  const options: Parameters<typeof createConnectionServices>[0] = { directory: join(f.root, 'connections'), bindings: { spatial, checkpoint: input => f.client.conversationCheckpoint(input) },
    ingress: { core: host => host === 'local' ? f.client : undefined }, publication: createPublicationConversationPort(f.coreClients) }
  const cursorCustody: number[] = [], namespace = ChannelStorage.prototype.namespace
  vi.spyOn(ChannelStorage.prototype, 'namespace').mockImplementation(function (scope) {
    const port = namespace.call(this, scope)
    if (scope.adapterId !== 'telegram') return port
    return { ...port, put(input) {
      if (input.key === 'telegram-update-offset' && input.value.kind === 'json') {
        const updateId = Number(input.value.value) - 1, disk = new DatabaseSync(join(options.directory, 'connections.sqlite'))
        try {
          expect(disk.prepare("SELECT count(*) AS n FROM connection_ingress_event WHERE app_id=? AND json_extract(raw_payload,'$.update_id')=?").get(scope.application.appId, updateId)?.n).toBe(1)
          cursorCustody.push(updateId)
        } finally { disk.close() }
      }
      return port.put(input)
    } }
  })
  services = await createConnectionServices(options); cleanup.push(() => services.close())
  expect(createBuiltinConnectionAdapters().map(adapter => adapter.adapterId)).toContain('telegram')
  const credential = await services.secrets.store({ operationId: 'telegram-secret', secret: telegramCredential })
  await services.connections.configure({ operationId: 'telegram-config', expectedRevision: null, connection: { ...telegramConfig, credentialRef: credential.credentialRef } })
  const bind = async (chatId: string, bindingId: string, connection = telegramConfig) => {
    const result = await services.connections.bindings!.bind({ operationId: 'bind-' + bindingId, bindingId, connectionId: connection.connectionId, expectedConnectionRevision: 1,
      executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: chatId,
      expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }, context)
    expect(result.state, JSON.stringify(result)).toBe('applied'); if (result.state !== 'applied') throw Error('The original Telegram Binding is required')
    await services.connections.bindings!.grant({ operationId: 'grant-' + bindingId, bindingId, expectedBindingRevision: result.binding.revision, grantId: 'grant-' + bindingId, expectedRevision: null,
      actor: { application: connection.application, idType: 'user_id', userId: '400' }, capabilities: ['input'], state: 'active' }, context)
    return result.binding
  }
  const binding = await bind('-300', 'telegram-binding')
  await until(() => expect(wire.calls.some(call => call.method === 'getUpdates' && (backlog || call.body.timeout === 30))).toBe(true))
  return { ...f, wire, spatial, binding, bind, transcript, cursorCustody, get services() { return services },
    async restart() { await services.close(); services = await createConnectionServices(options); await until(() => expect(wire.calls.filter(call => call.method === 'getUpdates').length).toBeGreaterThan(1)) },
    submit: (operationId: string, prompt: string) => f.client.submitAgentPrompt({ ...agentPromptCondition(f.client.agentSession('original-agent')), agentSessionId: 'original-agent', operationId, prompt, authorHuman: true, allowUncertainTurn: true }) }
}
const speech = (uuid: string, text: string) => JSON.stringify({ sessionId: 'original-native', uuid, type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } }) + '\n'

it('default Telegram registration carries native mentions through durable ingress and Core and sends public replies to the exact native chat', async () => {
  const f = await fixture(), update = f.wire.message()
  await until(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const ingress = (await f.services.ingress!.list({ connectionId: telegramConfig.connectionId })).ingresses[0]!
  expect(ingress).toMatchObject({ externalMessageId: '-300:' + update.message!.message_id, actor: { idType: 'user_id', userId: '400' }, state: 'claimed' })
  expect(f.cursorCustody).toContain(update.update_id)
  expect((f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls[0]![1].data).toContain('Original Telegram input')
  await appendFile(f.transcript, speech('telegram-public-reply', 'Exact original Telegram reply')); f.services.publication!.refresh()
  await until(() => expect([...f.wire.messages.values()].some(message => message.chat.id === -300 && message.text?.includes('Exact original Telegram reply'))).toBe(true))
  expect(f.wire.calls.filter(call => call.method === 'sendMessage' && call.body.text.includes('Original Telegram input'))).toHaveLength(0)
  const adapter = new TelegramAdapter()
  const raw = JSON.stringify(update)
  await expect(adapter.verify(telegramConfig, raw, { raw, application: telegramConfig.application, signal: new AbortController().signal, bot: { id: 100, is_bot: true, username: 'original_bot' }, sourceBoundaryUnconfirmed: false })).rejects.toMatchObject({ code: 'TELEGRAM_TRANSPORT_PROOF_REQUIRED' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('Telegram compiled CLI discovers the registered native API and configures, checks, binds and inspects the original message through RPC', async () => {
  const f = await fixture()
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'cli.sock'), connections: f.services.connections, spatialState: f.spatial, coreClients: f.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const run = (args: string[], input?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(f.root), input === undefined ? undefined : JSON.stringify(input))
  const cli = async <T>(args: string[], input?: unknown) => {
    const result = await run(args, input)
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout).result as T
  }
  const credential = await f.services.secrets.store({ operationId: 'telegram-cli-secret', secret: '102:fixture-token' })
  const connection = { ...telegramConfig, connectionId: 'telegram-cli-bot', application: { ...telegramConfig.application, appId: '102' }, credentialRef: credential.credentialRef }
  expect((await cli<{ connection: ConnectionRecord }>(['connection', 'configure', '--input', '-'], { operationId: 'telegram-cli-configure', expectedRevision: null, connection })).connection.config.application).toEqual(connection.application)
  expect((await cli<ConnectionRecord>(['connection', 'test', '--connection', connection.connectionId])).observation.authentication.state).toBe('ready')
  const bind = { operationId: 'telegram-cli-bind', bindingId: 'telegram-cli-binding', connectionId: connection.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: 'original-agent', regionAnchor: { regionId: 'region' }, externalConversationId: '-302',
    expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } }
  expect(await cli(['connection', 'bind', '--input', '-'], bind)).toMatchObject({ state: 'applied' })
  const identities = await cli<{ identities: ConnectionApiIdentity[] }>(['connection', 'api', 'identities', '--session', 'original-agent'])
  const identity = identities.identities.find(value => value.connectionId === connection.connectionId)!
  expect(identity).toMatchObject({ adapterId: 'telegram', application: connection.application, externalConversationId: '-302', api: { documentationUrl: 'https://core.telegram.org/bots/api' } })
  const selected = { bindingId: identity.bindingId, bindingRevision: identity.bindingRevision, connectionId: identity.connectionId, connectionRevision: identity.connectionRevision }
  expect(await cli(['connection', 'api', 'request', '--input', '-'], { operationId: 'telegram-cli-native-getme', identity: selected, request: { method: 'POST', path: '/getMe', body: {} } })).toMatchObject({ state: 'responded', response: { status: 200, body: { format: 'json', value: { ok: true, result: { id: 102 } } } } })
  expect(await cli(['connection', 'api', 'request', '--input', '-'], { operationId: 'telegram-cli-native-business-error', identity: selected, request: { method: 'POST', path: '/ordinaryNativeBusinessMethod', body: {} } })).toMatchObject({ state: 'responded', response: { status: 404, body: { format: 'json', value: { ok: false } } } })
  for (const method of ['getUpdates', 'getWebhookInfo', 'getManagedBotToken', 'replaceManagedBotToken']) {
    const rejected = await run(['connection', 'api', 'request', '--input', '-'], { operationId: 'telegram-cli-reserved-' + method, identity: selected, request: { method: 'POST', path: '/' + method, body: { offset: -1, user_id: 987 } } })
    expect(rejected.code).not.toBe(0)
    expect(rejected.stderr + rejected.stdout).toContain('CONNECTION_API_ENDPOINT_UNAVAILABLE')
    expect(f.wire.calls.filter(call => call.method === method && (method !== 'getUpdates' || call.body.offset === -1))).toHaveLength(0)
  }
  await until(() => expect(f.wire.calls.some(call => call.method === 'getUpdates' && call.body.timeout === 30)).toBe(true))
  f.wire.message('An ungranted Telegram member has no Core input authority', { botId: 102, chatId: -302, actorId: 499 })
  let refused: import('@agentmux/core/connections').ConnectionIngressRecord | undefined
  await until(async () => { refused = (await f.services.ingress!.list({ connectionId: connection.connectionId })).ingresses[0]; expect(refused?.state).toBe('refused') })
  expect(await cli(['connection', 'ingress', 'inspect', '--ingress', refused!.ingressId])).toMatchObject({ ingress: { ingressId: refused!.ingressId, application: connection.application, code: 'INGRESS_ACTOR_NOT_AUTHORIZED' } })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('Telegram retains a full native page of long messages beyond the public API byte budget and continues from its exact native cut', async () => {
  const body = '漢'.repeat(4096), f = await fixture(Array.from({ length: 100 }, () => body))
  const database = new DatabaseSync(join(f.root, 'connections/connections.sqlite'), { readOnly: true }); cleanup.push(() => database.close())
  f.wire.resumePolls()
  await until(() => expect(database.prepare('SELECT count(*) AS n FROM connection_ingress_event').get()?.n).toBe(100), { timeout: 15_000 })
  expect(Math.max(...f.wire.batchBytes)).toBeGreaterThan(1024 * 1024)
  expect(f.cursorCustody).toHaveLength(100)
  const first = database.prepare('SELECT ingress_id FROM connection_ingress_message ORDER BY sequence LIMIT 1').get()!
  expect((await f.services.ingress!.inspect({ ingressId: String(first.ingress_id) })).ingress).toMatchObject({ body, state: 'refused', code: 'INGRESS_SOURCE_BOUNDARY_UNCONFIRMED', group: { target: null } })
  await until(() => expect(f.wire.calls.some(call => call.method === 'getUpdates' && call.body.timeout === 30)).toBe(true))
  await f.restart()
  f.wire.message('Healthy fresh input after the full native page and original owner reopen')
  await until(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect(f.cursorCustody).toHaveLength(101)
  expect(database.prepare('SELECT count(*) AS n FROM connection_ingress_event').get()?.n).toBe(101)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it('Telegram shares untriggered group and App conversation text across original audiences without granting input or echoing the source group', async () => {
  const f = await fixture(), credential = await f.services.secrets.store({ operationId: 'telegram-peer-secret', secret: '101:fixture-token' })
  const peer = { ...telegramConfig, connectionId: 'telegram-peer', application: { ...telegramConfig.application, appId: '101' }, credentialRef: credential.credentialRef }
  await f.services.connections.configure({ operationId: 'telegram-peer-config', expectedRevision: null, connection: peer })
  await f.bind('-301', 'telegram-peer-binding', peer)
  f.wire.message('Untriggered original group text', { mention: false, actorId: 401 })
  await until(async () => expect([...f.wire.messages.values()].some(message => message.chat.id === -301 && message.text?.includes('Untriggered original group text')),
    JSON.stringify({ ingress: await f.services.ingress!.list({ connectionId: telegramConfig.connectionId }), deliveries: await f.services.publication!.list({ connectionId: peer.connectionId, bindingId: 'telegram-peer-binding', bindingRevision: 1 }) })).toBe(true), { timeout: 8000 })
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect([...f.wire.messages.values()].some(message => message.chat.id === -300 && message.text?.includes('Untriggered original group text'))).toBe(false)
  const conversation = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent', limit: 30 })
  expect(JSON.stringify(conversation)).toContain('Untriggered original group text')
  await f.submit('telegram-app-user', 'Original App user text'); f.services.publication!.refresh()
  await until(() => {
    for (const chatId of [-300, -301]) expect([...f.wire.messages.values()].some(message => message.chat.id === chatId && message.text?.includes('Original App user text'))).toBe(true)
  })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('Telegram preserves unsupported native content and the durable cursor through Host reopen without replaying original Core input', async () => {
  const f = await fixture(), update = f.wire.message('Original before reopen')
  await until(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  await until(() => expect(f.wire.calls.some(call => call.method === 'getUpdates' && call.body.offset === update.update_id + 1)).toBe(true))
  await f.restart()
  f.wire.message('Unsupported original photo caption', { unsupported: true })
  await until(async () => expect((await f.services.ingress!.list({ connectionId: telegramConfig.connectionId })).ingresses.some(record => record.code === 'INGRESS_CONTENT_UNSUPPORTED')).toBe(true))
  expect(f.inner.kernel.input).toHaveBeenCalledOnce()
  expect((await f.services.ingress!.list({ connectionId: telegramConfig.connectionId })).ingresses).toHaveLength(2)
})

it('Telegram retains a lost send as the same unknown operation across reopen and never guesses absence from the missing Bot API read method', async () => {
  const f = await fixture()
  await until(() => expect(f.services.publication!.store.list(f.binding).every(operation => operation.state === 'confirmed')).toBe(true))
  f.wire.loseNextSend()
  await appendFile(f.transcript, speech('telegram-unknown-reply', 'Original Telegram unknown reply')); f.services.publication!.refresh()
  const operation = () => f.services.publication!.store.list(f.binding).find(item => item.payload.kind === 'speech')
  await until(() => expect(operation()?.state).toBe('unknown'))
  const frozen = structuredClone(operation()!), count = f.wire.calls.filter(call => call.method === 'sendMessage').length
  await f.restart(); f.services.publication!.refresh()
  expect(operation()).toEqual(frozen)
  expect(f.wire.calls.filter(call => call.method === 'sendMessage')).toHaveLength(count)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})


it('Telegram checks distinguish a native identity mismatch from an unconfirmed probe while the original authenticated receiver stays usable', async () => {
  const f = await fixture()
  f.wire.identityStatus(503)
  expect((await f.services.connections.test({ connectionId: telegramConfig.connectionId })).observation.authentication.state).toBe('unknown')
  f.wire.message('Healthy native input while a separate identity probe is unconfirmed')
  await until(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce(), { timeout: 5_000 })
  f.wire.identityStatus(200); f.wire.changeBot(999)
  expect((await f.services.connections.test({ connectionId: telegramConfig.connectionId })).observation.authentication.state).toBe('unavailable')
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  const adapter = new TelegramAdapter()
  await expect(adapter.test({ ...telegramConfig, application: { ...telegramConfig.application, issuer: 'https://forged-server.invalid' } }, telegramCredential)).resolves.toMatchObject({ authentication: { state: 'unavailable' } })
})


it('Telegram never promotes a pending pre-connection update into the new sharing boundary or a newly granted Core request', async () => {
  const body = 'Original pending Telegram history before the connection and Binding existed'
  const f = await fixture(body)
  f.wire.resumePolls()
  const original = () => f.services.ingress!.list({ connectionId: telegramConfig.connectionId })
  await until(async () => { const retained = (await original()).ingresses[0]; expect(retained).toBeDefined(); expect(retained!.state).not.toBe('received') }, { timeout: 5_000 })
  const intake = (await original()).ingresses[0]!
  expect(intake.body).toContain(body)
  expect(intake.state).toBe('refused')
  expect(intake.code).toBe('INGRESS_SOURCE_BOUNDARY_UNCONFIRMED')
  expect(intake.input).toBeUndefined()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  expect(JSON.stringify(await f.client.readAgentConversation({ hostId: 'local', agentSessionId: 'original-agent', limit: 30 }))).not.toContain(body)
  await until(() => expect(f.wire.calls.some(call => call.method === 'getUpdates' && call.body.timeout === 30)).toBe(true))
  const originalUpdate = f.wire.updates[0]!
  f.wire.message(body, { messageId: originalUpdate.message!.message_id })
  await until(() => expect(f.wire.calls.some(call => call.method === 'getUpdates' && call.body.offset === f.wire.updates[1]!.update_id + 1)).toBe(true))
  expect((await original()).ingresses).toEqual([intake])
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.restart()
  f.wire.message('Fresh original Telegram message after the initial cut and owner reopen')
  await until(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect((await original()).ingresses.find(record => record.ingressId === intake.ingressId)).toEqual(intake)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
