import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../../packages/core/src/index.js'
import { connectHostedAgentMux, type AgentMuxHostedClient } from '../../../packages/core/src/hosted.js'
import type { AgentProviderPreparedNativeInput } from '../../../packages/core/src/agent-provider.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { savedQuestionEvent, savedQuestionJsonl } from '../../../packages/core/test/helpers/codex-saved-question.js'
import { feishuConfig, feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp, feishuCardElements } from '../../../packages/connectors/test/fixtures/feishu-publication.js'
import { createHostedIngressCorePort } from '../../../packages/connectors/src/core-ingress-port.js'
import { DurableIngressHost } from '../../../packages/connectors/src/durable-ingress.js'
import { startAgentMuxHost } from '../src/host.js'

const cleanup: Array<() => void | Promise<void>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
afterAll(async () => { if (process.env.EXTERNAL_ACTION_FACTS) await writeFile(process.env.EXTERNAL_ACTION_FACTS, JSON.stringify({
  schema: 'agentmux.external-action-consumer.v1',
  scope: 'Actual semantic Hosts, public Unix/Hosted RPC, durable ingress/Core journals, authenticated official SDK callbacks and original HTTP Hook. Platform HTTP/WS uses loopback; native Runtime and Provider native-input send are controlled ports. No live tenant or running user Agent is touched.', facts
}, null, 2) + '\n') })
const actor = { application: feishuConfig.application, idType: 'open_id' as const, userId: 'original-external-user' }

async function owner(name: string) {
  const original = await rpcOwnerFixture(['same-agent'], core, root => ({ providerId: 'codex', executorId: 'codex',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'same-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(original.close)
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(AGENTMUX_|CTXMUX_)/u.test(key)))
  const directory = join(original.root, 'connections'), socketPath = join(original.root, name + '.sock')
  await mkdir(directory, { mode: 0o700 }); await writeFile(join(original.root, 'native.jsonl'), savedQuestionJsonl([
    { type: 'session_meta', payload: { id: 'same-native', cwd: original.root } }
  ]))
  const nativeActor = { protocolId: 'codex-app-server-v2-0.163', actorId: name + '-actor', lifecycleOperationId: name + '-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  const saved = (await original.store.readMetadata('same-agent'))!
  await original.store.compareAndSwap(saved, { ...saved, nativeActor })
  const native = original.inner.kernel
  native.status = vi.fn(async (id: string) => ({ ...original.run(id), pid: 123 }))
  await original.client.dispose()
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined, clients: { hostId: string; client: AgentMuxHostedClient }[] = []
  const send = vi.fn<AgentProviderPreparedNativeInput['send']>(async () => ({ outcome: 'admitted', turnId: 'answer-native-turn' }))
  const start = async () => {
    for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
    for (const [key, value] of Object.entries(environment)) vi.stubEnv(key, value)
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const key of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = native[key]
      const provider = this.providers.get('codex')
      provider.discoverNativeSession = async () => ({ handle: { kind: 'provider', providerId: 'codex', sessionId: 'same-native', transcriptPath: join(original.root, 'native.jsonl') }, assertCurrent: async () => {} })
      provider.observeSessionStatus = async () => ({ dispose() {} })
      provider.prepareNativeInput = async (_context, source) => ({ plan: { kind: 'native-rpc', protocolId: nativeActor.protocolId,
        sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), actorId: nativeActor.actorId, threadId: source.nativeSessionId, operation: 'start-or-steer' },
        assertCurrent: async () => {}, send, dispose() {} })
    })
    try {
      host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: join(original.root, 'no-desktop.sock'),
        mobileBuildDirectory: join(original.root, 'no-mobile'), connections: { directory, clients: () => clients } })
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
    reader = await connectHostedAgentMux({ rpc: exact, expectedRuntimeId: identity.runtimeId, forwardRpc: (method, params, context) => exact.call(method, params, context) })
    const observed = reader; cleanup.push(() => observed.dispose())
  }
  await connectReader()
  return { original, native, send, socketPath, identity, start, stop, get rpc() { return rpc }, get reader() { return reader }, client: () => host!.client,
    routes: (value: typeof clients) => { clients = value }, reconnect: async () => { rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); await connectReader() } }
}

async function fixture(remote = true) {
  const transport = feishuSdkTransport(), http = await feishuPublicationHttp(call => call.path.endsWith('/members')
    ? { status: 200, body: { code: 0, data: { items: [{ member_id_type: 'open_id', member_id: actor.userId, name: 'Original member' }], has_more: false } } } : undefined)
  cleanup.push(http.close); vi.spyOn(defaultHttpInstance, 'request').mockImplementation(http.http.request)
  const hosting = await owner('hosting'), execution = remote ? await owner('execution') : hosting
  const routes = () => { if (remote) { hosting.routes([{ hostId: 'execution-route', client: execution.reader }]); execution.routes([{ hostId: 'hosting-route', client: hosting.reader }]) } }
  routes()
  const source = { hostingRuntimeId: hosting.identity.runtimeId, executionRuntimeId: execution.identity.runtimeId }
  const secret = await hosting.rpc.call('connection.credential.store', { operationId: 'credential', secret: 'fixture-value' },
    { runtimeFence: { runtimeId: hosting.identity.runtimeId, ownerInstanceId: hosting.identity.ownerInstanceId } })
  await hosting.rpc.call('connection.configure', { operationId: 'configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: secret.credentialRef } })
  const bound = await hosting.rpc.call('connection.bind', { operationId: 'bind', bindingId: 'binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: remote ? 'execution-route' : 'local', agentSessionId: 'same-agent', externalConversationId: 'original-room',
    expectedSource: { providerId: 'codex', nativeSessionId: 'same-native' }, scope: { input: 'all-messages', publication: 'future-shared-conversation' } })
  expect(bound.state, JSON.stringify(bound)).toBe('applied')
  const grant = (active = true) => hosting.rpc.call('connection.grant', { operationId: 'grant-' + active, grantId: 'member', bindingId: 'binding', expectedBindingRevision: 1,
    expectedRevision: active ? null : 1, actor, capabilities: ['permission', 'answer'], state: active ? 'active' : 'revoked' })
  await grant(); await vi.waitFor(() => expect(transport.sockets).toHaveLength(1))
  const intake = async () => (await hosting.rpc.call('connection.ingress.ls', { connectionId: feishuConfig.connectionId })).ingresses.filter(value => value.kind === 'action')
  const inspect = async () => { const record = (await intake())[0]!; return await hosting.rpc.call('connection.ingress.inspect', { ingressId: record.ingressId }) }
  const open = async (kind: 'permission' | 'question') => {
    let callback: Promise<unknown> | undefined
    if (kind === 'question') {
      const event = savedQuestionEvent(); event.payload.thread_id = 'same-native'
      await appendFile(join(execution.original.root, 'native.jsonl'), savedQuestionJsonl([event]))
    } else {
      const server = Reflect.get(execution.client(), 'hookServer') as any
      await server.start(); const hook = server.createBinding('same-agent', 'codex'); await hook.bindRun('run-same-agent')
      let request: ReturnType<typeof httpRequest>
      callback = new Promise((resolve, reject) => {
        request = httpRequest(hook.endpoint.url, { method: 'POST', headers: { authorization: 'Bearer ' + hook.endpoint.token } }, response => {
          let body = ''; response.setEncoding('utf8'); response.on('data', value => { body += value }); response.on('error', reject)
          response.on('end', () => { try { resolve(JSON.parse(body)) } catch (error) { reject(error) } })
        }); request.on('error', reject); request.end(JSON.stringify({ receiptId: 'original-permission', eventName: 'PermissionRequest', decision: true,
          payload: { hook_event_name: 'PermissionRequest', session_id: 'same-native', turn_id: 'original-turn', tool_name: 'Bash', tool_input: { command: 'original command' } } }))
      }); void callback.catch(() => {})
      cleanup.push(async () => { request!.destroy(); await Promise.allSettled([callback!]) })
      await vi.waitFor(() => expect(execution.client().agentSession('same-agent').pendingInteraction?.request.id).toBe('original-permission'))
    }
    let messageId = '', button: any
    try { await vi.waitFor(() => {
      for (const [id, message] of http.records) {
        if (message.msg_type !== 'interactive') continue
        const card = JSON.parse((message.body as { content: string }).content)
        const buttons = feishuCardElements(card).flatMap(element => element.actions ?? (element.tag === 'button' ? [element] : []))
        const found = buttons.find(value => value.value?.actionRef && (kind === 'question' ? value.name === 'submit_original_answer' : /deny|reject/iu.test(value.text?.content ?? '')))
        if (found) { messageId = id; button = found; break }
      }
      expect(button, 'The actual original publication exposes its typed action').toBeDefined()
    }, { timeout: 12_000 }) } catch (error) {
      process.stderr.write(JSON.stringify({ pending: execution.client().agentSession('same-agent').pendingInteraction,
        hosted: execution.reader.agentSession('same-agent').pendingInteraction, calls: http.calls, records: [...http.records],
        deliveries: await hosting.rpc.call('connection.delivery.ls', { bindingId: 'binding' }) }) + '\n')
      throw error
    }
    const wire = (eventId = 'action-event') => ({ schema: '2.0', header: { app_id: feishuConfig.application.appId, event_id: eventId, event_type: 'card.action.trigger' },
      event: { operator: { open_id: actor.userId }, context: { open_chat_id: 'original-room', open_message_id: messageId },
        action: { tag: 'button', value: structuredClone(button.value), ...(kind === 'question' ? { form_value: { question_0_option: '0' } } : {}) } } })
    return { callback, wire }
  }
  const receive = async (wire: unknown) => { await transport.receive(wire); expect(transport.ack().at(-1)).toMatchObject({ code: 200 }) }
  return { hosting, execution, transport, source, http, routes, grant, intake, inspect, open, receive }
}

for (const remote of [false, true]) for (const kind of ['permission', 'question'] as const) it(`${remote ? 'remote' : 'local'} ${kind} callback uses original authority and receipt once`, async () => {
  const f = await fixture(remote), action = await f.open(kind)
  await f.receive(action.wire())
  await vi.waitFor(async () => expect(await f.inspect()).toMatchObject(kind === 'permission' ? { interactionReceipt: { delivery: 'hook-written' } } : { questionReceipt: { outcome: 'submitted' } }), { timeout: 12_000 })
  const original = (await f.intake())[0]!
  expect(original.input!.author.authoritySource).toEqual(f.source)
  if (kind === 'permission') await expect(action.callback).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  else expect(f.execution.send).toHaveBeenCalledOnce()
  await f.receive(action.wire()); await f.receive(action.wire('duplicate-event'))
  await vi.waitFor(async () => expect(await f.intake()).toHaveLength(2))
  expect((await f.intake()).map(record => record.input?.operationId)).toEqual([original.input!.operationId, original.input!.operationId])
  if (kind === 'question') expect(f.execution.send).toHaveBeenCalledOnce()
  expect(f.execution.native.input).not.toHaveBeenCalled(); expect(f.execution.native.stop).not.toHaveBeenCalled()
  if (remote) expect(f.hosting.send).not.toHaveBeenCalled()
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.hosting.socketPath, 'connection', 'ingress', 'inspect', '--ingress', original.ingressId], objectCliEnvironment(f.hosting.original.root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.ingress.input.author.authoritySource).toEqual(f.source)
  facts.push({ case: `${remote ? 'remote' : 'local'}-${kind}`, source: f.source, receipt: await f.inspect(), cli: JSON.parse(cli.stdout).result })
})

it('claimed permission survives original Hosting restart and missing return route without another callback', async () => {
  const prepare = DatabaseSync.prototype.prepare, plans: string[][] = []
  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.includes('FROM connection_ingress_action_intent work INDEXED')) {
      const all = statement.all.bind(statement), database = this
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        plans.push(prepare.call(database, 'EXPLAIN QUERY PLAN ' + sql).all(...args).map(row => String(row.detail)))
        return all(...args)
      })
    }
    return statement
  })
  const f = await fixture(), action = await f.open('permission')
  f.execution.routes([]); await f.receive(action.wire())
  await vi.waitFor(async () => expect((await f.intake())[0]).toMatchObject({ state: 'claimed' }))
  const original = (await f.intake())[0]!, before = await f.inspect()
  expect(before).toMatchObject({ observation: 'observed', interactionReceipt: null })
  await f.hosting.stop(); await f.hosting.start(); await f.hosting.reconnect(); f.routes()
  await vi.waitFor(async () => expect(await f.inspect()).toMatchObject({ interactionReceipt: { delivery: 'hook-written', operationId: original.input!.operationId } }), { timeout: 12_000 })
  await expect(action.callback).resolves.toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } })
  expect(await f.intake()).toHaveLength(1)
  expect(plans.length).toBeGreaterThan(0)
  for (const plan of plans) {
    expect(plan.some(detail => detail.startsWith('SEARCH work USING INDEX connection_ingress_action_recovery'))).toBe(true)
    expect(plan.some(detail => detail.startsWith('SEARCH connection_ingress_event USING INDEX connection_ingress_action_operation')),
      'Recovering one original action must not scan unrelated historical action claims').toBe(true)
  }
  facts.push({ case: 'claimed-restart-no-new-callback', before, after: await f.inspect(), plans })
})

it('revoked original grant cannot be revived by a claimed recovery candidate', async () => {
  const f = await fixture(), action = await f.open('permission')
  f.execution.routes([]); await f.receive(action.wire())
  await vi.waitFor(async () => expect((await f.intake())[0]).toMatchObject({ state: 'claimed' }))
  await f.grant(false); f.routes(); await f.receive(action.wire('after-revocation'))
  const original = (await f.intake())[0]!
  expect(await f.hosting.rpc.call('connection.ingress.authority', { operationId: original.input!.operationId })).toMatchObject({ authority: 'refused' })
  expect(await f.inspect()).toMatchObject({ interactionReceipt: null })
  expect(f.execution.client().agentSession('same-agent').pendingInteraction?.request.kind).toBe('permission')
  facts.push({ case: 'revoked-claim', receipt: await f.inspect() })
})

it('an unknown native question operation is inspected without another Core submission', async () => {
  const f = await fixture(); f.execution.send.mockRejectedValue(new Error('Controlled lost native response'))
  const action = await f.open('question'), reply = vi.spyOn(f.execution.client(), 'replySessionQuestion')
  await f.receive(action.wire())
  await vi.waitFor(() => expect(f.execution.send).toHaveBeenCalledOnce())
  await vi.waitFor(async () => expect(await f.inspect()).toMatchObject({ questionReceipt: { outcome: 'unknown' } }), { timeout: 12_000 })
  const dispatch = vi.spyOn(DurableIngressHost.prototype, 'dispatch')
  await f.receive(action.wire('repeat-unknown'))
  await vi.waitFor(async () => expect(await f.intake()).toHaveLength(2))
  const duplicate = (await f.intake()).find(record => record.eventId === 'repeat-unknown')!
  // Join the actual receiver's original dispatch, not merely the SDK's durable intake ACK.
  await vi.waitFor(() => expect(dispatch.mock.calls.some(([id]) => id === duplicate.ingressId)).toBe(true))
  await dispatch.mock.results[dispatch.mock.calls.findIndex(([id]) => id === duplicate.ingressId)]!.value
  expect(reply).toHaveBeenCalledOnce(); expect(f.execution.send).toHaveBeenCalledOnce()
  facts.push({ case: 'unknown-no-replay', receipt: await f.inspect(), coreSubmissions: reply.mock.calls.length })
})

it('permission invocation retains its preflight fence when the same Hosted client reconnects to another owner instance', async () => {
  const f = await fixture(), action = await f.open('permission')
  f.execution.routes([]); await f.receive(action.wire())
  await vi.waitFor(async () => expect((await f.intake())[0]).toMatchObject({ state: 'claimed' }))
  const original = (await f.intake())[0]!, db = new DatabaseSync(join(f.hosting.original.root, 'connections/connections.sqlite'))
  const input = JSON.parse(String(db.prepare('SELECT intent_json FROM connection_ingress_action_intent WHERE operation_id=?').get(original.input!.operationId)!.intent_json)); db.close()
  let endpoint = f.execution.rpc, changed = false
  const moving = await connectHostedAgentMux({ rpc: { call: (method, params, context) => endpoint.call(method, params, context), subscribe: (method, params, handlers) => endpoint.subscribe(method, params, handlers) },
    forwardRpc: async (method, params, context) => {
      const result = await endpoint.call(method, params, context)
      if (method === 'runtime.owner.identity' && !changed) {
        changed = true; moving.disconnect(); await f.execution.stop(); await f.execution.start(); await f.execution.reconnect(); endpoint = f.execution.rpc
        f.execution.routes([{ hostId: 'hosting-route', client: f.hosting.reader }]); await moving.connect()
      }
      return result
    } })
  cleanup.push(() => moving.dispose())
  const port = createHostedIngressCorePort(() => [{ hostId: 'execution-route', client: moving }])('execution-route', f.source.executionRuntimeId)!
  const result = await port.respondAgentInteraction!(input).then(value => ({ value }), error => ({ error: error.code }))
  expect(changed).toBe(true); expect(result).toMatchObject({ error: 'RUNTIME_OWNER_CHANGED' })
  expect(await f.execution.client().inspectAgentInteractionOperation({ agentSessionId: input.agentSessionId, operationId: input.operationId })).toBeNull()
  facts.push({ case: 'permission-final-fence', result })
})
