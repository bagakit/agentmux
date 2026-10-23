import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../../packages/core/src/index.js'
import { connectHostedAgentMux, type AgentMuxHostedClient } from '../../../packages/core/src/hosted.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp } from '../../../packages/connectors/test/fixtures/feishu-publication.js'
import { createHostedIngressCorePort } from '../../../packages/connectors/src/core-ingress-port.js'
import { startAgentMuxHost } from '../src/host.js'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
afterAll(async () => { if (process.env.CROSS_HOST_FACTS) await writeFile(process.env.CROSS_HOST_FACTS, JSON.stringify({
  schema: 'agentmux.cross-host-authority-consumer.v1',
  scope: 'Two actual semantic Hosts, original public Unix/Hosted clients, SQLite ingress and Core journals. Only native Runtime bytes and official Feishu SDK I/O are controlled; no SSH, Linux, live account, default remote-client configuration or migration claim.', facts
}, null, 2) + '\n') })

async function owner(name: string) {
  const original = await rpcOwnerFixture(['same-agent'], core, root => ({ providerId: 'claude', executorId: 'claude',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'same-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(original.close)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(AGENTMUX_|CTXMUX_)/u.test(key)))
  const directory = join(original.root, 'connections'), socketPath = join(original.root, name + '.sock')
  await mkdir(directory, { mode: 0o700 }); await writeFile(join(original.root, 'native.jsonl'), '')
  const native = original.inner.kernel
  let available = true, host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  native.isConnected = () => available
  await original.client.dispose()
  let clients: { hostId: string; client: AgentMuxHostedClient }[] = []
  const start = async () => {
    for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const key of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = native[key]
      this.providers.get('claude').planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
    })
    try {
      host = await startAgentMuxHost({ store: original.store, socketPath,
        desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'),
        connections: { directory, clients: () => clients } })
      await vi.waitFor(() => expect((host!.client as unknown as typeof original.inner).connected).toBe(true))
    } finally { connect.mockRestore() }
  }
  const stop = async () => { const previous = host; host = undefined; await previous?.dispose() }
  cleanup.push(stop); await start()
  let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  const identity = (await rpc.call('runtime.owner.identity', {})).owner
  let reader: AgentMuxHostedClient
  const connectReader = async () => {
    const exact = rpc; cleanup.push(() => exact.dispose())
    reader = await connectHostedAgentMux({ rpc: exact, expectedRuntimeId: identity.runtimeId,
      forwardRpc: (method, params, context) => exact.call(method, params, context) })
    const observed = reader; cleanup.push(() => observed.dispose())
  }
  await connectReader()
  const reconnect = async () => { rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); await connectReader() }
  return { original, native, get rpc() { return rpc }, get reader() { return reader }, identity, start, stop, reconnect, client: () => host!.client,
    available: (value: boolean) => { available = value; if (host) (host.client as unknown as typeof original.inner).connected = value }, routes: (value: typeof clients) => { clients = value } }
}

async function pair() {
  const transport = feishuSdkTransport(), http = await feishuPublicationHttp(); cleanup.push(http.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(http.http.request)
  const hosting = await owner('hosting'), execution = await owner('execution')
  expect(hosting.identity.runtimeId).not.toBe(execution.identity.runtimeId)
  expect(hosting.client().agentSession('same-agent').run).toEqual(execution.client().agentSession('same-agent').run)
  hosting.routes([{ hostId: 'outbound-execution', client: execution.reader }])
  execution.routes([{ hostId: 'original-hosting', client: hosting.reader }])
  const secret = await hosting.rpc.call('connection.credential.store', { operationId: 'synthetic-credential', secret: 'synthetic-feishu-value' },
    { runtimeFence: { runtimeId: hosting.identity.runtimeId, ownerInstanceId: hosting.identity.ownerInstanceId } })
  await hosting.rpc.call('connection.configure', { operationId: 'configure-original', expectedRevision: null,
    connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  const result = await hosting.rpc.call('connection.bind', { operationId: 'bind-original', bindingId: 'original-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'outbound-execution', agentSessionId: 'same-agent', externalConversationId: 'original-room',
    expectedSource: { providerId: 'claude', nativeSessionId: 'same-native' }, scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' } })
  expect(result).toMatchObject({ state: 'applied', binding: { executionRuntimeId: execution.identity.runtimeId } })
  if (result.state !== 'applied') throw Error('Original remote binding not applied')
  await vi.waitFor(() => expect(transport.sockets).toHaveLength(1))
  const grant = (active = true) => hosting.rpc.call('connection.grant', { operationId: 'grant-' + active, grantId: 'original-member', bindingId: result.binding.bindingId,
    expectedBindingRevision: 1, expectedRevision: active ? null : 1, actor: { application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' },
    capabilities: ['input'], state: active ? 'active' : 'revoked' })
  const receive = async (id: string) => {
    const payload = feishuPayload({ message_id: id, content: JSON.stringify({ text: 'Original external body ' + id }) }); payload.header.event_id = id
    await transport.receive(payload); expect(transport.ack().at(-1)).toMatchObject({ code: 200 })
    return payload
  }
  const intake = async (id: string) => (await hosting.rpc.call('connection.ingress.ls', { connectionId: feishuConfig.connectionId })).ingresses.find(value => value.externalMessageId === id)!
  const source = { hostingRuntimeId: hosting.identity.runtimeId, executionRuntimeId: execution.identity.runtimeId }
  return { hosting, execution, transport, http, grant, receive, intake, source, binding: result.binding }
}

it('two actual Hosts record an ungranted group message only in the frozen execution owner without authorizing input', async () => {
  const f = await pair(); await f.receive('record-only')
  await vi.waitFor(async () => expect(await f.intake('record-only')).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED',
    group: { target: { authoritySource: f.source }, recorded: { agentSessionId: 'same-agent', authoritySource: f.source } } }), { timeout: 15_000 })
  const intake = await f.intake('record-only'); expect(intake.input).toBeUndefined()
  await vi.waitFor(async () => expect((await f.execution.original.store.readCapturedHistory('same-agent', {})).records[0]?.item.externalInput).toMatchObject({ state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' }))
  const records = (await f.execution.original.store.readCapturedHistory('same-agent', {})).records
  expect(records).toHaveLength(1); expect(records[0]!.item).toMatchObject({ content: intake.body, authorExternal: { authoritySource: f.source }, externalInput: { state: 'refused', code: 'INGRESS_ACTOR_NOT_AUTHORIZED' } })
  expect((await f.hosting.original.store.readCapturedHistory('same-agent', {})).records).toEqual([])
  expect(await new core.DurableAgentMuxMessageQueue(f.execution.client().agentMessageQueuePath()).listAfter()).toEqual([])
  expect(f.hosting.native.input).not.toHaveBeenCalled(); expect(f.execution.native.input).not.toHaveBeenCalled()
  facts.push({ case: 'two-actual-owners-record-only', source: f.source, binding: f.binding, intake, captured: records, nativeEffects: 0 })
})

it('two actual Hosts authorize a native message through the original hosting database and retain its Runtime pair in the execution journal', async () => {
  const f = await pair(); await f.grant(); await f.receive('authorized')
  try { await vi.waitFor(() => expect(f.execution.native.input).toHaveBeenCalledOnce(), { timeout: 15_000 }) }
  catch (error) { facts.push({ case: 'native-message-failed-business-witness', expectedSource: f.source, intake: await f.intake('authorized'),
    hostingEffects: (f.hosting.native.input as ReturnType<typeof vi.fn>).mock.calls.length,
    executionEffects: (f.execution.native.input as ReturnType<typeof vi.fn>).mock.calls.length }); throw error }
  expect(f.hosting.native.input).not.toHaveBeenCalled()
  const intake = await f.intake('authorized'); expect(intake).toMatchObject({ state: 'claimed', input: { author: { authoritySource: f.source } } })
  const input = intake.input!; if (!('messageId' in input)) throw Error('Expected original message claim')
  const original = await new core.DurableAgentMuxMessageQueue(f.execution.client().agentMessageQueuePath()).readByOperationId(input.operationId)
  expect(original).toMatchObject({ envelope: { sender: { authoritySource: f.source }, body: intake.body } })
  expect(await new core.DurableAgentMuxMessageQueue(f.hosting.client().agentMessageQueuePath()).listAfter()).toEqual([])
  const authority = await f.hosting.rpc.call('connection.ingress.authority', { operationId: input.operationId })
  expect(authority).toMatchObject({ authority: 'current', ingress: { input: { author: original!.envelope.sender } } })
  const receipt = await f.execution.rpc.call('agent.input.inspect', { key: { agentSessionId: 'same-agent', expectedRun: input.expectedRun, kind: 'message', messageId: input.messageId } })
  expect(receipt.input).toMatchObject({ status: 'terminal-confirmed', originalControlOperationId: input.operationId })
  expect(f.hosting.native.stop).not.toHaveBeenCalled(); expect(f.execution.native.stop).not.toHaveBeenCalled()
  facts.push({ case: 'two-actual-owners-native-message', source: f.source, intake, journal: original, receipt, hostingEffects: 0, executionEffects: 1 })
})

it('the Binding pin survives a missing route and refuses a same-ID foreign execution owner before any record or input journal', async () => {
  const f = await pair(); await f.grant()
  f.hosting.routes([]); const payload = await f.receive('temporarily-unrouted')
  await vi.waitFor(async () => expect(await f.intake('temporarily-unrouted')).toMatchObject({ state: 'received', group: { target: { authoritySource: f.source }, recording: { state: 'unavailable' } } }))
  expect(f.execution.native.input).not.toHaveBeenCalled()
  f.hosting.routes([{ hostId: 'outbound-execution', client: f.hosting.reader }])
  await f.transport.receive(payload)
  await vi.waitFor(async () => expect(await f.intake('temporarily-unrouted')).toMatchObject({ state: 'received', group: { recording: { state: 'unavailable', code: 'RUNTIME_OWNER_MISMATCH' } } }))
  expect((await f.hosting.original.store.readCapturedHistory('same-agent', {})).records).toEqual([])
  expect((await f.execution.original.store.readCapturedHistory('same-agent', {})).records).toEqual([])
  expect(await new core.DurableAgentMuxMessageQueue(f.hosting.client().agentMessageQueuePath()).listAfter()).toEqual([])
  expect(f.hosting.native.input).not.toHaveBeenCalled(); expect(f.execution.native.input).not.toHaveBeenCalled()
  const originalId = (await f.intake('temporarily-unrouted')).ingressId
  f.hosting.routes([{ hostId: 'outbound-execution', client: f.execution.reader }]); await f.transport.receive(payload)
  await vi.waitFor(() => expect(f.execution.native.input).toHaveBeenCalledOnce(), { timeout: 10_000 })
  expect((await f.intake('temporarily-unrouted')).ingressId).toBe(originalId)
  facts.push({ case: 'missing-route-and-foreign-execution', source: f.source, originalId, recovered: await f.intake('temporarily-unrouted'), foreignEffects: 0, executionEffects: 1 })
})

it('the exact final invocation stays fenced when the same Hosted client adopts a new owner instance after its preflight', async () => {
  const f = await pair(); f.hosting.routes([]); await f.receive('race-record')
  await vi.waitFor(async () => expect(await f.intake('race-record')).toMatchObject({ state: 'refused', group: { recording: { state: 'unavailable' } } }))
  const original = await f.intake('race-record')
  const reference = { agentSessionId: 'same-agent', ingressId: original.ingressId, authoritySource: f.source }
  // This is the real Hosted wrapper on an actual public RPC port. Only its
  // transport destination changes between the two owning calls.
  let endpoint = f.execution.rpc, swapped = false
  const moving = await connectHostedAgentMux({ rpc: {
    call: (method, params, context) => endpoint.call(method, params, context),
    subscribe: (method, params, handlers) => endpoint.subscribe(method, params, handlers)
  },
    forwardRpc: async (method, params, context) => {
      const value = await endpoint.call(method, params, context)
      if (method === 'runtime.owner.identity' && !swapped) {
        swapped = true; moving.disconnect()
        await f.execution.stop(); await f.execution.start(); await f.execution.reconnect(); endpoint = f.execution.rpc
        // Explicitly reconnect the same consumer to the new instance of E.
        await moving.connect()
      }
      return value
    } })
  cleanup.push(() => moving.dispose())
  const port = createHostedIngressCorePort(() => [{ hostId: 'outbound-execution', client: moving }])('outbound-execution')!
  const outcome = await port.recordExternalConversationMessage(reference).then(value => ({ value }), error => ({ error: error.code }))
  const captured = (await f.execution.original.store.readCapturedHistory('same-agent', {})).records
  facts.push({ case: 'same-client-preflight-destination-change', source: f.source, outcome, captured, wrongInputWrites: 0 })
  expect(outcome).toMatchObject({ error: 'RUNTIME_OWNER_CHANGED' }); expect(captured).toEqual([])
  expect(swapped).toBe(true)
  expect((await f.hosting.original.store.readCapturedHistory('same-agent', {})).records).toEqual([])
  expect(await new core.DurableAgentMuxMessageQueue(f.hosting.client().agentMessageQueuePath()).listAfter()).toEqual([])
  expect(f.hosting.native.input).not.toHaveBeenCalled()
})

it('a genuine hosting-local record cannot be projected into another Runtime with the same Session and Run identifiers', async () => {
  const f = await pair()
  const relinked = await f.hosting.rpc.call('connection.binding.relink', { operationId: 'relink-local', expectedRevision: 1,
    bindingId: f.binding.bindingId, connectionId: feishuConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: 'same-agent', externalConversationId: 'original-room',
    expectedSource: { providerId: 'claude', nativeSessionId: 'same-native' }, scope: f.binding.scope })
  expect(relinked).toMatchObject({ state: 'applied', binding: { executionRuntimeId: f.hosting.identity.runtimeId } })
  await f.receive('hosting-local')
  const source = { hostingRuntimeId: f.hosting.identity.runtimeId, executionRuntimeId: f.hosting.identity.runtimeId }
  await vi.waitFor(async () => expect(await f.intake('hosting-local')).toMatchObject({ state: 'refused', group: { recorded: { authoritySource: source } } }))
  const intake = await f.intake('hosting-local')
  const outcome = await f.execution.rpc.call('agent.conversation.record', { hostId: 'local', agentSessionId: 'same-agent', ingressId: intake.ingressId, authoritySource: source })
    .then(value => ({ value }), error => ({ error: error.code }))
  const captured = (await f.execution.original.store.readCapturedHistory('same-agent', {})).records
  facts.push({ case: 'foreign-execution-same-identifiers', source, intake, outcome, captured })
  expect(outcome).toMatchObject({ error: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' }); expect(captured).toEqual([])
  expect((await f.hosting.original.store.readCapturedHistory('same-agent', {})).records).toHaveLength(1)
  expect(f.execution.native.input).not.toHaveBeenCalled(); expect(f.hosting.native.input).not.toHaveBeenCalled()
})

it('an original remote Binding without a saved Runtime pin remains readable but requires explicit relink before new input', async () => {
  const f = await pair(); await f.grant(); await f.hosting.stop()
  // Synthetic pre-source revision fixture. The product never rewrites these bytes.
  const db = new DatabaseSync(join(f.hosting.original.root, 'connections', 'connections.sqlite'))
  const { executionRuntimeId: _missingOriginalFact, ...historical } = f.binding
  db.prepare('UPDATE room_binding_revision SET snapshot_json=? WHERE binding_id=? AND revision=1').run(JSON.stringify(historical), f.binding.bindingId); db.close()
  await f.hosting.start(); await f.hosting.reconnect()
  f.execution.routes([{ hostId: 'original-hosting', client: f.hosting.reader }])
  await vi.waitFor(() => expect(f.transport.sockets).toHaveLength(2))
  expect(await f.hosting.rpc.call('connection.binding.inspect', { bindingId: f.binding.bindingId })).toMatchObject({ current: historical })
  await f.receive('historical-no-pin')
  await vi.waitFor(async () => expect(await f.intake('historical-no-pin')).toMatchObject({ state: 'refused', code: 'INGRESS_TARGET_UNCONFIRMED', group: { recording: { state: 'unavailable' } } }))
  const original = await f.intake('historical-no-pin')
  expect(original.group!.target!.authoritySource).toBeUndefined()
  expect(f.execution.native.input).not.toHaveBeenCalled()
  const linked = await f.hosting.rpc.call('connection.binding.relink', { operationId: 'explicit-original-relink', expectedRevision: 1,
    bindingId: f.binding.bindingId, connectionId: feishuConfig.connectionId, expectedConnectionRevision: 1,
    executionHostId: 'outbound-execution', agentSessionId: 'same-agent', externalConversationId: 'original-room',
    expectedSource: { providerId: 'claude', nativeSessionId: 'same-native' }, scope: f.binding.scope })
  expect(linked).toMatchObject({ state: 'applied', binding: { executionRuntimeId: f.execution.identity.runtimeId, revision: 2 } })
  await f.hosting.rpc.call('connection.grant', { operationId: 'explicit-relinked-member', grantId: 'relinked-member', bindingId: f.binding.bindingId,
    expectedBindingRevision: 2, expectedRevision: null, actor: { application: feishuConfig.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input'], state: 'active' })
  await f.receive('after-explicit-relink')
  await vi.waitFor(() => expect(f.execution.native.input).toHaveBeenCalledOnce(), { timeout: 10_000 })
  expect((await f.intake('historical-no-pin')).group!.target!.authoritySource).toBeUndefined()
  expect((await f.intake('historical-no-pin')).ingressId).toBe(original.ingressId)
  facts.push({ case: 'historical-source-not-invented', historical, original, linked, newInput: await f.intake('after-explicit-relink') })
})

it('original waiting rejoin survives execution reopen and hosting loss, then rechecks revoked membership without harming local input', async () => {
  const f = await pair(); await f.grant(); f.execution.available(false); await f.receive('saved-wait')
  let saved: core.AgentInputSubmissionReceipt | null = null
  await vi.waitFor(async () => {
    const intake = await f.intake('saved-wait'); expect(intake.input).toBeDefined()
    saved = await f.execution.reader.inspectAgentInput({ kind: 'message-control', originalControlOperationId: intake.input!.operationId })
    expect(saved).toMatchObject({ status: 'waiting' })
  })
  const before = saved!
  await f.execution.stop(); await f.execution.start(); await f.execution.reconnect()
  f.hosting.routes([{ hostId: 'outbound-execution', client: f.execution.reader }]); f.execution.routes([])
  const reopened = await f.execution.reader.inspectAgentInput({ key: before.key })
  expect(reopened?.ref).toEqual(before.ref)
  await expect(f.execution.rpc.call('agent.input.rejoin', { ref: before.ref })).rejects.toMatchObject({ code: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  expect(f.execution.native.input).not.toHaveBeenCalled()
  f.execution.routes([{ hostId: 'original-hosting', client: f.hosting.reader }]); f.execution.available(true)
  const rejoined = await f.execution.rpc.call('agent.input.rejoin', { ref: before.ref })
  expect(rejoined.ref).toEqual(before.ref); expect(rejoined.key).toEqual(before.key)
  try { await vi.waitFor(() => expect(f.execution.native.input).toHaveBeenCalledOnce(), { timeout: 10_000 }) }
  catch (error) { facts.push({ case: 'rejoin-failure-diagnostic', source: f.source,
    receipt: await f.execution.reader.inspectAgentInput({ key: before.key }),
    authority: await f.hosting.rpc.call('connection.ingress.authority', { operationId: before.originalControlOperationId }) }); throw error }
  f.execution.available(false); await f.receive('revoked-wait')
  let revoked: core.AgentInputSubmissionReceipt | null = null
  await vi.waitFor(async () => {
    const intake = await f.intake('revoked-wait'); expect(intake.input).toBeDefined()
    revoked = await f.execution.reader.inspectAgentInput({ kind: 'message-control', originalControlOperationId: intake.input!.operationId })
    expect(revoked).toMatchObject({ status: 'waiting' })
  })
  await f.grant(false); f.execution.available(true)
  const revocation = await f.execution.rpc.call('agent.input.rejoin', { ref: revoked!.ref }).then(value => ({ value }), error => ({ error: error.code }))
  if ('value' in revocation) await vi.waitFor(() => expect(f.execution.native.input).toHaveBeenCalledTimes(2), { timeout: 10_000 })
  facts.push({ case: 'revoked-membership-current-read', source: f.source, ref: revoked!.ref, revocation,
    authority: await f.hosting.rpc.call('connection.ingress.authority', { operationId: revoked!.originalControlOperationId }),
    executionEffects: (f.execution.native.input as ReturnType<typeof vi.fn>).mock.calls.length })
  expect(revocation).toMatchObject({ error: 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED' })
  expect(f.execution.native.input).toHaveBeenCalledOnce()
  await f.execution.client().submitAgentPrompt({ agentSessionId: 'same-agent', ...core.agentPromptCondition((await f.execution.client().readAgentSession('same-agent'))!),
    operationId: 'healthy-local', prompt: 'Original local input remains usable', authorHuman: true, allowUncertainTurn: true })
  expect(f.execution.native.input).toHaveBeenCalledTimes(2); expect(f.hosting.native.input).not.toHaveBeenCalled()
  expect((await f.intake('saved-wait')).input!.operationId).toBe(before.originalControlOperationId)
  const journal = await new core.DurableAgentMuxMessageQueue(f.execution.client().agentMessageQueuePath()).readByOperationId(before.originalControlOperationId)
  expect(journal!.envelope.sender).toMatchObject({ authoritySource: f.source })
  facts.push({ case: 'reopen-loss-rejoin-revocation', source: f.source, originalRef: before.ref, reopenedRef: reopened!.ref,
    originalKey: before.key, revokedRef: revoked!.ref, originalJournal: journal, executionEffects: 2, foreignEffects: 0 })
})
