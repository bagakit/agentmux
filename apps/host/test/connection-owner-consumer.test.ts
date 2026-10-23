import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '../../../packages/core/src/index.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { ConnectionSecrets } from '../../../packages/connectors/src/connection-secrets.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp } from '../../../packages/connectors/test/fixtures/feishu-publication.js'
import { discordConfig, discordRoomId, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'
import { startAgentMuxHost } from '../src/host.js'
import type { ConnectionConfig, RoomBinding } from '@agentmux/core/connections'

const cleanup: Array<() => void | Promise<void>> = []
const runtimeFacts: unknown[] = []
afterAll(async () => { if (process.env.HOST_CONNECTION_FACTS) await writeFile(process.env.HOST_CONNECTION_FACTS, JSON.stringify({
  schema: 'agentmux.actual-host-connection-consumer.v1',
  scope: 'Actual startAgentMuxHost, complete Core owner, public Unix endpoint, private credential store and default platform adapters. Synthetic credential values and controlled Runtime/official-SDK I/O; no live account, installed App or real remote Linux qualification.',
  facts: runtimeFacts
}, null, 2) + '\n') })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Real original Host/Core/SQLite/public endpoint; only native platform and Runtime I/O leaves are controlled. */
async function independentHost() {
  const feishu = feishuSdkTransport(), feishuHttp = await feishuPublicationHttp(); cleanup.push(feishuHttp.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(feishuHttp.http.request)
  const discord = await discordTransport(); cleanup.push(discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'original-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(original.close)
  const transcript = join(original.root, 'native.jsonl'), directory = join(original.root, 'connections'), socketPath = join(original.root, 'host.sock')
  const native = (id: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'original-native', uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await writeFile(transcript, native('private-before-sharing', 'Original earlier unshared answer'))
  await mkdir(directory, { mode: 0o700 })
  // Seed only synthetic credential bytes through the original credential owner; never a second connection/SDK owner.
  const database = new DatabaseSync(join(directory, 'connections.sqlite')), secrets = new ConnectionSecrets(database)
  const configs: ConnectionConfig[] = []
  for (const config of [feishuConfig, discordConfig]) {
    const receipt = await secrets.store({ operationId: config.adapterId + '-secret', secret: 'synthetic-' + config.adapterId })
    configs.push({ ...config, credentialRef: receipt.credentialRef })
  }
  database.close()
  const runtime = original.inner.kernel
  let available = true
  runtime.isConnected = () => available
  await original.client.dispose()
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const name of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = runtime[name]
      this.providers.get('claude').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
    })
    try {
      host = await startAgentMuxHost({ store: original.store, socketPath,
        desktopSocketPath: join(original.root, 'never-created-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile-assets'),
        connections: { directory } })
      await vi.waitFor(() => expect((host!.client as unknown as typeof original.inner).connected).toBe(true))
      return host
    } finally { connect.mockRestore() }
  }
  const stop = async () => { const previous = host; host = undefined; await previous?.dispose() }
  cleanup.push(stop)
  await start()
  const rpc = () => core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  const manage = async () => {
    const client = await rpc()
    try { return await Promise.all(configs.map(async config => {
      await client.call('connection.configure', { operationId: config.adapterId + '-configure', expectedRevision: null, connection: config })
      const result = await client.call('connection.bind', { operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding',
        connectionId: config.connectionId, expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent',
        externalConversationId: config.adapterId === 'feishu' ? 'original-room' : discordRoomId,
        expectedSource: { providerId: 'claude', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
      expect(result.state).toBe('applied'); if (result.state !== 'applied') throw Error('Original audience not bound')
      return result.binding
    })) } finally { await client.dispose() }
  }
  const grant = async (bindings: RoomBinding[], active = true) => {
    const client = await rpc()
    try { for (const binding of bindings) {
      const config = configs.find(value => value.connectionId === binding.connectionId)!
      await client.call('connection.grant', { operationId: config.adapterId + '-grant-' + String(active), grantId: config.adapterId + '-member',
        bindingId: binding.bindingId, expectedBindingRevision: 1, expectedRevision: active ? null : 1,
        actor: { application: config.application, idType: config.adapterId === 'feishu' ? 'open_id' : 'snowflake', userId: config.adapterId === 'feishu' ? 'original-external-user' : '400' },
        capabilities: ['input'], state: active ? 'active' : 'revoked' })
    } } finally { await client.dispose() }
  }
  const inspect = async () => {
    const client = await rpc()
    try { return await Promise.all(configs.map(config => client.call('connection.ingress.ls', { connectionId: config.connectionId }))) }
    finally { await client.dispose() }
  }
  const posts = () => ({ feishu: feishuHttp.messageCalls().filter(call => call.method === 'POST').map(call => call.body),
    discord: discord.calls.filter(call => call.method === 'POST' && call.path === '/channels/300/messages').map(call => call.body) })
  const copies = (text: string) => Object.fromEntries(Object.entries(posts()).map(([kind, bodies]) => [kind, bodies.filter(body => body.includes(text)).length]))
  const incoming = async (suffix: string) => {
    const payload = feishuPayload({ message_id: 'feishu-' + suffix, content: JSON.stringify({ text: 'Feishu input ' + suffix }) }); payload.header.event_id = 'feishu-' + suffix
    await feishu.receive(payload); discord.message(suffix, 'Discord input ' + suffix)
    return payload
  }
  return { original, configs, feishu, discord, copies, posts, start, stop, manage, grant, inspect, incoming, rpc,
    runtimeAvailable: (value: boolean) => { available = value },
    authority: () => host!.deviceAuthority(),
    owner: async () => { const client = await rpc(); try { return (await client.call('runtime.owner.identity', {})).owner } finally { await client.dispose() } },
    noDesktop: async () => expect(stat(join(original.root, 'never-created-desktop.sock'))).rejects.toMatchObject({ code: 'ENOENT' }),
    client: () => host!.client, native: async (id: string, body: string) => appendFile(transcript, native(id, body)),
    identity: async () => JSON.parse(await readFile(join(original.root, 'semantic-runtime.json'), 'utf8')) }
}

it('actual Host receives and publishes with every Desktop client absent, then reopens the same original owner', async () => {
  const f = await independentHost(), bindings = await f.manage(); await f.grant(bindings)
  expect(bindings.every(binding => binding.regionAnchor === undefined)).toBe(true)
  await f.noDesktop()
  const originalIdentity = await f.identity(), originalOwner = await f.owner(), originalRun = f.client().agentSession('original-agent').run
  await vi.waitFor(() => { expect(f.feishu.sockets).toHaveLength(1); expect(f.discord.sessions).toHaveLength(1) })
  const payload = await f.incoming('701')
  await vi.waitFor(() => expect(f.original.inner.kernel.input).toHaveBeenCalledTimes(2), { timeout: 15_000 })
  const first = await f.inspect()
  for (const page of first) {
    const record = page.ingresses[0]!
    expect(record).toMatchObject({ state: 'claimed', input: { agentSessionId: 'original-agent', expectedRun: originalRun }, group: { recorded: { agentSessionId: 'original-agent', ingressId: record.ingressId } } })
    const rpc = await f.rpc()
    try { expect(await rpc.call('connection.ingress.inspect', { ingressId: record.ingressId })).toMatchObject({ observation: 'observed', inputReceipt: { status: 'terminal-confirmed', originalControlOperationId: record.input!.operationId } }) }
    finally { await rpc.dispose() }
    const original = await new core.DurableAgentMuxMessageQueue(f.client().agentMessageQueuePath()).readByOperationId(record.input!.operationId)
    expect(original!.envelope.body).toBe(record.body); expect(original!.envelope.sender).toEqual(record.input!.author)
  }
  await f.native('host-reply-one', 'Independent original Host reply')
  await vi.waitFor(() => expect(f.copies('Independent original Host reply')).toEqual({ feishu: 1, discord: 1 }), { timeout: 15_000 })
  expect(JSON.stringify(f.posts())).not.toContain('Original earlier unshared answer')
  await f.stop(); await f.start()
  expect(await f.identity()).toEqual(originalIdentity)
  const reopenedOwner = await f.owner()
  expect(reopenedOwner.runtimeId).toBe(originalOwner.runtimeId); expect(reopenedOwner.ownerInstanceId).not.toBe(originalOwner.ownerInstanceId)
  expect(f.client().agentSession('original-agent').run).toEqual(originalRun)
  const reopened = await f.inspect()
  expect(reopened.map(page => page.ingresses.map(record => [record.ingressId, record.input]))).toEqual(first.map(page => page.ingresses.map(record => [record.ingressId, record.input])))
  await vi.waitFor(() => { expect(f.feishu.sockets).toHaveLength(2); expect(f.discord.sessions).toHaveLength(2) })
  payload.header.event_id = 'feishu-701-redelivered'; await f.feishu.receive(payload)
  await f.incoming('702')
  await vi.waitFor(() => expect(f.original.inner.kernel.input).toHaveBeenCalledTimes(4), { timeout: 15_000 })
  await f.native('host-reply-two', 'Reply after original Host restart')
  await vi.waitFor(() => expect(f.copies('Reply after original Host restart')).toEqual({ feishu: 1, discord: 1 }), { timeout: 15_000 })
  expect(f.copies('Independent original Host reply')).toEqual({ feishu: 1, discord: 1 })
  expect((await f.client().readAgentSessions()).map(session => session.agentSessionId)).toEqual(['original-agent'])
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.original.inner.kernel.attach).not.toHaveBeenCalled()
  const failedFlush = new Error('Controlled original device persistence failure'), authority = await f.authority()
  vi.spyOn(authority, 'flush').mockRejectedValueOnce(failedFlush)
  await expect(f.stop()).rejects.toBe(failedFlush)
  await expect(f.start()).resolves.toBeDefined()
  expect(await f.identity()).toEqual(originalIdentity)
  const afterFlushOwner = await f.owner()
  expect(afterFlushOwner.runtimeId).toBe(originalOwner.runtimeId); expect(afterFlushOwner.ownerInstanceId).not.toBe(reopenedOwner.ownerInstanceId)
  expect(f.client().agentSession('original-agent').run).toEqual(originalRun)
  const afterFlushFailure = await f.inspect()
  expect(afterFlushFailure.map(page => page.ingresses.map(record => record.input!.agentSessionId))).toEqual([['original-agent', 'original-agent'], ['original-agent', 'original-agent']])
  await vi.waitFor(() => { expect(f.feishu.sockets).toHaveLength(3); expect(f.discord.sessions).toHaveLength(3) })
  await f.noDesktop()
  runtimeFacts.push({ case: 'independent-start-and-reopen', runtimeId: originalIdentity.runtimeId, owners: [originalOwner, reopenedOwner, afterFlushOwner], sameRuntimeId: true, originalRun, bindings,
    originalIngress: first, reopenedIngress: reopened, inputEffects: 4, originalReplyCopies: f.copies('Independent original Host reply'),
    newReplyCopies: f.copies('Reply after original Host restart'), desktopEndpointAbsent: true, originalFlushErrorRetained: true, reopenedAfterFlushFailure: true })
})

it('actual Host public rejoin checks the same in-process authority with Desktop absent and retains the original waiting input', async () => {
  const f = await independentHost(), bindings = await f.manage(); await f.grant(bindings)
  await vi.waitFor(() => { expect(f.feishu.sockets).toHaveLength(1); expect(f.discord.sessions).toHaveLength(1) })
  f.runtimeAvailable(false); await f.incoming('721')
  const rpc = await f.rpc()
  try {
    const receipts: core.AgentInputSubmissionReceipt[] = []
    await vi.waitFor(async () => {
      receipts.splice(0)
      for (const page of await f.inspect()) {
        const record = page.ingresses[0]!
        const inspected = await rpc.call('connection.ingress.inspect', { ingressId: record.ingressId })
        expect(inspected.inputReceipt).toMatchObject({ status: 'waiting' }); receipts.push(inspected.inputReceipt!)
      }
    }, { timeout: 10_000 })
    expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
    runtimeFacts.push({ case: 'original-waiting-authority-witness', originalRefs: receipts.map(receipt => receipt.ref), originalKeys: receipts.map(receipt => receipt.key), ingress: await f.inspect(), inputWrites: 0 })
    await rpc.call('connection.service.configure', { operationId: 'wait-off', expectedRevision: 0, service: { enabled: false } })
    f.runtimeAvailable(true)
    for (const receipt of receipts) await expect(rpc.call('agent.input.rejoin', { ref: receipt.ref })).rejects.toMatchObject({ code: 'INGRESS_SERVICE_DISABLED' })
    expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
    await rpc.call('connection.service.configure', { operationId: 'wait-on', expectedRevision: 1, service: { enabled: true } })
    for (const receipt of receipts) {
      const rejoined = await rpc.call('agent.input.rejoin', { ref: receipt.ref })
      expect(rejoined.key).toEqual(receipt.key); expect(rejoined.ref).toEqual(receipt.ref)
    }
    await vi.waitFor(() => expect(f.original.inner.kernel.input).toHaveBeenCalledTimes(2), { timeout: 10_000 })
    for (const page of await f.inspect()) expect(page.ingresses).toHaveLength(1)
    expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
    runtimeFacts.push({ case: 'original-waiting-authority-rejoin', originalRefs: receipts.map(receipt => receipt.ref),
      originalKeys: receipts.map(receipt => receipt.key), serviceDisabledCode: 'INGRESS_SERVICE_DISABLED', resumedEffects: 2 })
  } finally { await rpc.dispose() }
})

it('actual Host refuses an ungranted or revoked native member without revoking healthy local input', async () => {
  const f = await independentHost(), bindings = await f.manage()
  await vi.waitFor(() => { expect(f.feishu.sockets).toHaveLength(1); expect(f.discord.sessions).toHaveLength(1) })
  await f.incoming('711')
  await vi.waitFor(async () => { for (const page of await f.inspect()) { expect(page.ingresses[0]).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }); expect(page.ingresses[0]!.input).toBeUndefined() } }, { timeout: 15_000 })
  expect(f.original.inner.kernel.input).not.toHaveBeenCalled()
  await f.grant(bindings); await f.incoming('712')
  await vi.waitFor(() => expect(f.original.inner.kernel.input).toHaveBeenCalledTimes(2), { timeout: 15_000 })
  await f.grant(bindings, false); await f.incoming('713')
  await vi.waitFor(async () => { for (const page of await f.inspect()) { const record = page.ingresses.find(record => record.externalMessageId.endsWith('713')); expect(record).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }); expect(record!.input).toBeUndefined() } }, { timeout: 15_000 })
  await f.client().submitAgentPrompt({ agentSessionId: 'original-agent', ...core.agentPromptCondition((await f.client().readAgentSession('original-agent'))!),
    operationId: 'healthy-local-input', prompt: 'Original healthy local input', authorHuman: true, allowUncertainTurn: true })
  expect(f.original.inner.kernel.input).toHaveBeenCalledTimes(3)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
  runtimeFacts.push({ case: 'ungranted-revoked-local-healthy', ingress: await f.inspect(), effects: 3, originalRunRetained: true })
})

it('actual Host restart inspects the same unknown native request without replaying it', async () => {
  const f = await independentHost(), bindings = await f.manage()
  const discordBinding = bindings.find(binding => binding.connectionId === discordConfig.connectionId)!
  const list = async () => { const rpc = await f.rpc(); try { return await rpc.call('connection.delivery.ls', { connectionId: discordConfig.connectionId, bindingId: discordBinding.bindingId, bindingRevision: 1, limit: 100 }) } finally { await rpc.dispose() } }
  await vi.waitFor(async () => expect((await list()).deliveries.filter(value => value.reference.source.kind === 'binding-operation').every(value => value.state === 'confirmed')).toBe(true), { timeout: 10_000 })
  f.discord.loseNextMessageResponse(false)
  await f.native('unknown-reply', 'Exact unknown original platform reply')
  let operationId = ''
  await vi.waitFor(async () => { const unknown = (await list()).deliveries.find(value => value.state === 'unknown'); expect(unknown).toBeDefined(); operationId = unknown!.operationId }, { timeout: 15_000 })
  expect(f.copies('Exact unknown original platform reply').discord).toBe(1)
  await f.stop(); await f.start()
  await vi.waitFor(async () => expect((await list()).deliveries.find(value => value.operationId === operationId)).toMatchObject({ state: 'unknown', receipt: { state: 'unknown', reason: 'effect-unconfirmed' } }), { timeout: 10_000 })
  await f.native('after-unknown', 'New independent reply after unknown')
  await vi.waitFor(() => expect(f.copies('New independent reply after unknown')).toEqual({ feishu: 1, discord: 1 }), { timeout: 15_000 })
  expect(f.copies('Exact unknown original platform reply').discord).toBe(1)
  const rpc = await f.rpc()
  try { await expect(rpc.call('connection.delivery.retry', { operationId })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' }) } finally { await rpc.dispose() }
  runtimeFacts.push({ case: 'unknown-no-replay', operationId, originalCopies: f.copies('Exact unknown original platform reply'),
    newReplyCopies: f.copies('New independent reply after unknown'), originalDelivery: (await list()).deliveries.find(value => value.operationId === operationId) })
})
