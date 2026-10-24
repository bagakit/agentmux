import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance, type HttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '@agentmux/core'
import type { ConnectionIngressRecord } from '@agentmux/core/connections'
import * as connectors from '@agentmux/connectors'
import { startAgentMuxHost } from '../src/host.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { nativeInputCorrelationKey } from '../../../packages/core/src/native-input-correlation.js'
import { fixtureEpoch } from '../../../packages/core/test/helpers/fixture-values.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuPublicationHttp } from '../../../packages/connectors/test/fixtures/feishu-publication.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
})

type Stage = 'received' | 'started' | 'completed'
type NativePacket = { prompt: string; plan: core.AgentNativePromptInputPlan; turnId: string }
type Reaction = { reaction_id: string; operator: { operator_type: 'app'; operator_id: string }; reaction_type: { emoji_type: string }; action_time: string }

/** Actual default Node Host/Core/SQLite/SDK; only Runtime, Provider native send and remote HTTP/WebSocket I/O are controlled. */
async function fixture(mode: 'native' | 'waiting' | 'terminal' = 'native') {
  const source = { providerId: 'codex', nativeSessionId: 'feedback-native' }
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'codex', executorId: 'codex',
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: source.nativeSessionId, transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(original.close)
  const transcript = join(original.root, 'native.jsonl'), directory = join(original.root, 'connections'), socket = join(original.root, 'host.sock'), desktop = join(original.root, 'absent-desktop.sock')
  const row = (payload: unknown) => JSON.stringify({ timestamp: new Date(fixtureEpoch(0, 1)).toISOString(), ...payload as object }) + '\n'
  await writeFile(transcript, row({ type: 'session_meta', payload: { id: source.nativeSessionId, cwd: original.root, history_mode: 'paginated' } }))
  const actor = { protocolId: 'fixture-native-protocol', actorId: 'original-native-actor', lifecycleOperationId: 'original-launch', token: 'a'.repeat(64), launch: { command: 'fixture-cli', args: [] } }
  if (mode !== 'terminal') {
    const session = (await original.store.readMetadata('original-agent'))!
    await original.store.compareAndSwapMetadata(session, { ...session, nativeActor: actor })
  }
  await mkdir(directory, { mode: 0o700 }); await original.client.dispose()
  const sdk = feishuSdkTransport(), nativeRows: Array<Record<string, unknown> & { message_id: string; create_time: string; body: { content: string } }> = [], reactions = new Map<string, Reaction[]>()
  const controls: { unknown?: string; fail?: string; reconcileUnavailable?: boolean } = {}
  const remote = await feishuPublicationHttp(call => {
    const reaction = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/reactions$/u.exec(call.path)
    if (reaction) {
      const messageId = decodeURIComponent(reaction[1]!)
      if (call.method === 'GET') return controls.reconcileUnavailable ? { status: 500, body: { code: 99991400 } }
        : { status: 200, body: { code: 0, data: { items: (reactions.get(messageId) ?? []).filter(item => !call.query.reaction_type || item.reaction_type.emoji_type === call.query.reaction_type), has_more: false } } }
      const { reaction_type } = JSON.parse(call.body) as { reaction_type: { emoji_type: string } }
      if (controls.fail === reaction_type.emoji_type) return { status: 403, body: { code: 99991672, msg: 'Controlled reaction permission is absent' } }
      const item: Reaction = { reaction_id: 'reaction-' + messageId + '-' + reaction_type.emoji_type,
        operator: { operator_type: 'app', operator_id: feishuConfig.application.appId }, reaction_type, action_time: String(fixtureEpoch(0, 2)) }
      const prior = reactions.get(messageId) ?? []; reactions.set(messageId, [...prior, item])
      return controls.unknown === reaction_type.emoji_type ? { status: 500, body: { code: 99991400, msg: 'Controlled reply lost after reaction creation' } } : { status: 200, body: { code: 0, data: item } }
    }
    if (call.method === 'GET' && call.path === '/open-apis/im/v1/messages') {
      const start = Number(call.query.page_token ?? 0), size = Number(call.query.page_size ?? 50), items = nativeRows.slice(start, start + size)
      return { status: 200, body: { code: 0, data: { items, has_more: start + size < nativeRows.length, ...(start + size < nativeRows.length ? { page_token: String(start + size) } : {}) } } }
    }
    if (call.method === 'GET') {
      const message = nativeRows.find(item => call.path === '/open-apis/im/v1/messages/' + item.message_id)
      if (message) return { status: 200, body: { code: 0, data: { items: [message] } } }
    }
    return undefined
  }); cleanup.push(remote.close)
  vi.spyOn(defaultHttpInstance as unknown as HttpInstance, 'request').mockImplementation(remote.http.request)
  const opened: connectors.ConnectionServices[] = [], factory = connectors.createConnectionServices
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => { const result = await factory(options); opened.push(result); return result })
  const packets: NativePacket[] = []
  let executionClient: core.AgentMuxClient
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined, rpc: Awaited<ReturnType<typeof core.connectAgentMuxRpc>> | undefined
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
      executionClient = this
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const key of ['isConnected', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = original.inner.kernel[key]
      if (mode === 'waiting') inner.kernel.isConnected = () => false
      inner.kernel.status = vi.fn(async (runId: string) => ({ ...original.run(runId), ...(mode === 'terminal' ? {} : { pid: 1234 }) }))
      const provider = this.providers.get('codex')
      provider.planPromptInput = text => ({ kind: 'single-phase', data: text + '\r' })
      if (mode !== 'terminal') provider.prepareNativeInput = async (_context, target) => {
        expect(target).toEqual(source)
        return { plan: { kind: 'native-rpc', protocolId: actor.protocolId, actorId: actor.actorId, sourceId: JSON.stringify([source.providerId, source.nativeSessionId]),
          threadId: source.nativeSessionId, operation: 'start-or-steer' }, assertCurrent: async () => {}, dispose: () => {},
          send: async (prompt, plan) => {
            const key = nativeInputCorrelationKey(plan.clientCorrelation!)
            expect(key).toMatchObject({ kind: 'message', agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' } })
            const packet = { prompt, plan: structuredClone(plan), turnId: 'original-turn-' + (packets.length + 1) }; packets.push(packet)
            return { outcome: 'admitted', turnId: packet.turnId }
          } }
      }
    })
    try { host = await startAgentMuxHost({ store: original.store, socketPath: socket, desktopSocketPath: desktop,
      mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory } }) }
    finally { connect.mockRestore() }
    rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  }
  const stop = async () => { await rpc?.dispose(); rpc = undefined; const previous = host; host = undefined; await previous?.dispose() }; cleanup.push(stop)
  await start()
  const owner = (await rpc!.call('runtime.owner.identity', {})).owner
  const secret = await rpc!.call('connection.credential.store', { operationId: 'feedback-secret', secret: 'synthetic-feedback-secret' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  const config = { ...feishuConfig, credentialRef: secret.credentialRef }
  await rpc!.call('connection.configure', { operationId: 'feedback-configure', expectedRevision: null, connection: config })
  const binding = await rpc!.call('connection.bind', { operationId: 'feedback-bind', bindingId: 'feedback-binding', connectionId: config.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: 'original-room', expectedSource: source,
    scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' }, ...(mode === 'terminal' ? {} : { inputTarget: { kind: 'native-conversation' as const, source } }) })
  expect(binding.state).toBe('applied'); if (binding.state !== 'applied') throw Error('Original default Host binding required')
  await rpc!.call('connection.grant', { operationId: 'feedback-grant', bindingId: binding.binding.bindingId, expectedBindingRevision: 1, grantId: 'feedback-member', expectedRevision: null,
    actor: { application: config.application, idType: 'open_id', userId: 'original-external-user' }, capabilities: ['input'], state: 'active' })
  await vi.waitFor(() => expect(sdk.sockets).toHaveLength(1))
  const receive = async (messageId: string, addressed = true) => {
    const time = String(1_000 + nativeRows.length), message = { message_id: messageId, chat_id: 'original-room', msg_type: 'text', create_time: time, update_time: time,
      sender: { sender_type: 'user', id_type: 'open_id', id: 'original-external-user' }, body: { content: JSON.stringify({ text: 'Query ' + messageId }) } }
    if (!nativeRows.some(item => item.message_id === messageId)) nativeRows.unshift(message)
    const payload = feishuPayload({ message_id: messageId, create_time: message.create_time, content: message.body.content, ...(addressed ? {} : { mentions: [] }) }); payload.header.event_id = 'event-' + messageId
    await sdk.receive(payload)
    let ingress: ConnectionIngressRecord | undefined
    await vi.waitFor(async () => { ingress = (await rpc!.call('connection.ingress.ls', { connectionId: config.connectionId, limit: 100 })).ingresses.find(item => item.kind !== 'action' && item.externalMessageId === messageId); expect(ingress).toBeDefined() })
    if (!ingress || ingress.kind === 'action') throw Error('Original retained group message required')
    return ingress
  }
  const deliveries = async () => (await rpc!.call('connection.delivery.ls', { connectionId: config.connectionId, bindingId: binding.binding.bindingId, bindingRevision: 1, limit: 100 })).deliveries
  const feedback = async (messageId: string) => (await deliveries()).filter(item => item.queryFeedback?.messageId === messageId)
  const expectStages = async (messageId: string, stages: Stage[]) => {
    await vi.waitFor(async () => expect((await feedback(messageId)).filter(item => item.state === 'confirmed').map(item => item.queryFeedback!.stage).sort()).toEqual([...stages].sort()), { timeout: 15_000 })
  }
  const admitted = async (record: ConnectionIngressRecord): Promise<NativePacket> => {
    let stop = () => {}, timer: ReturnType<typeof setTimeout> | undefined, closed = false
    let last: unknown, first: unknown, events = 0
    const startedAt = performance.now()
    try {
      return await new Promise<NativePacket>((accept, reject) => {
        const inspect = async () => {
          const observed = await rpc!.call('connection.ingress.inspect', { ingressId: record.ingressId })
          if (closed) return
          const receipt = observed.inputReceipt, input = observed.ingress?.kind !== 'action' ? observed.ingress?.input : undefined
          last = { state: observed.ingress?.state, code: observed.ingress?.code, status: receipt?.status,
            control: receipt?.control.state, waiting: receipt?.control.waiting }
          first ??= last
          if (receipt?.status !== 'admitted') return
          expect(input).toMatchObject({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' } })
          expect(receipt.key).toEqual({ kind: 'message', agentSessionId: input!.agentSessionId, expectedRun: input!.expectedRun, messageId: input!.messageId })
          const packet = packets.find(value => {
            const key = nativeInputCorrelationKey(value.plan.clientCorrelation!)
            return key.kind === 'message' && receipt.key.kind === 'message' && key.agentSessionId === receipt.key.agentSessionId &&
              key.expectedRun.runId === receipt.key.expectedRun.runId && key.messageId === receipt.key.messageId
          })
          expect(packet, 'The exact admitted original input must have reached the native port').toBeDefined()
          if (process.env.QUERY_FEEDBACK_INPUT_FACTS) await appendFile(process.env.QUERY_FEEDBACK_INPUT_FACTS,
            JSON.stringify({ ingressId: record.ingressId, first, last, events, elapsedMs: performance.now() - startedAt }) + '\n')
          accept(packet!)
        }
        // The SDK receive ACK and received reaction precede native input dispatch.
        // Observe that original input's receipt, rather than a one-second packet-count race.
        stop = executionClient.onEvent(event => {
          if (event.type === 'agent-input' && event.receipt.key.agentSessionId === 'original-agent') {
            events++; void inspect().catch(reject)
          }
        }, { observeMessages: false })
        timer = setTimeout(() => reject(Error('Original native input admission was not observed: ' + JSON.stringify(last))), 15_000)
        void inspect().catch(reject)
      })
    } finally { closed = true; if (timer) clearTimeout(timer); stop() }
  }
  const adopt = async (packet = packets.at(-1)!, ids: string | readonly string[] = 'canonical-original-user') => await appendFile(transcript, (typeof ids === 'string' ? [ids] : ids).map(id => row({ type: 'event_msg', payload: { type: 'item_completed', thread_id: source.nativeSessionId, turn_id: packet.turnId,
    item: { type: 'UserMessage', id, client_id: packet.plan.clientCorrelation, content: [{ type: 'text', text: packet.prompt, text_elements: [] }] } } })).join(''))
  const complete = async (turnId: string, kind: 'task_complete' | 'turn_aborted' = 'task_complete') => await appendFile(transcript, row({ type: 'event_msg', payload: { type: kind, turn_id: turnId } }))
  const reply = async (text: string, turnId = packets.at(-1)?.turnId ?? 'unrelated-turn') => await appendFile(transcript, row({ type: 'response_item', payload: { type: 'message', id: 'reply-' + text, role: 'assistant', phase: 'final_answer', turn_id: turnId, content: [{ type: 'output_text', text }] } }))
  const reactionPosts = (messageId: string) => remote.calls.filter(call => call.method === 'POST' && call.path === '/open-apis/im/v1/messages/' + messageId + '/reactions')
  return { original, source, transcript, desktop, socket, packets, controls, reactions, remote, sdk, config, binding: binding.binding, receive, admitted, feedback, deliveries, expectStages, adopt, complete, reply, row, reactionPosts,
    get executionClient() { return executionClient },
    get rpc() { return rpc! }, get service() { return opened.at(-1)! }, reopen: async () => { await stop(); await start(); await vi.waitFor(() => expect(sdk.sockets.length).toBeGreaterThan(1)) } }
}

it('default Host reports current native cursor failure while original input and received reactions remain usable', async () => {
  const f = await fixture(), first = await f.receive('native-coverage-original')
  await f.expectStages('native-coverage-original', ['received'])
  await f.admitted(first); expect(f.packets).toHaveLength(1)
  const originalFeedback = (await f.feedback('native-coverage-original'))[0]!
  const provider = f.executionClient.providers.get('codex'), changes = provider.readConversationChanges!.bind(provider)
  const failure = vi.spyOn(provider, 'readConversationChanges').mockImplementation(input => input.after !== undefined
    ? Promise.reject(new core.AgentMuxError('PRIVATE original native cursor detail', 'AGENT_SESSION_HISTORY_TIMEOUT')) : changes(input))
  const list = () => f.rpc.call('connection.delivery.ls', { connectionId: f.config.connectionId, bindingId: f.binding.bindingId, bindingRevision: 1 })
  f.service.publication!.refresh()
  await vi.waitFor(async () => expect((await list()).sourceObservation).toMatchObject({ state: 'unavailable', reason: 'source-gap', code: 'AGENT_SESSION_HISTORY_TIMEOUT' }))
  expect(failure).toHaveBeenCalled()
  const second = await f.receive('native-coverage-independent')
  await f.expectStages('native-coverage-independent', ['received'])
  await f.admitted(second); expect(f.packets).toHaveLength(2)
  expect((await f.rpc.call('connection.ingress.inspect', { ingressId: first.ingressId })).inputReceipt?.status).toBe('admitted')
  expect((await f.rpc.call('connection.ingress.inspect', { ingressId: second.ingressId })).inputReceipt?.status).toBe('admitted')
  expect((await f.feedback('native-coverage-original'))[0]).toEqual(originalFeedback)
  expect((await list()).sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_TIMEOUT' })
  failure.mockRestore(); f.service.publication!.refresh()
  await vi.waitFor(async () => expect((await list()).sourceObservation?.state).toBe('ready'))
  await f.reply('Independent default Host answer after exact source recovery')
  await vi.waitFor(() => expect(JSON.stringify(f.remote.calls)).toContain('Independent default Host answer after exact source recovery'))
  expect(f.reactionPosts('native-coverage-original')).toHaveLength(1)
  expect(f.reactionPosts('native-coverage-independent')).toHaveLength(1)
  expect((await f.feedback('native-coverage-original'))[0]).toEqual(originalFeedback)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 25_000)

it('default Host attaches cumulative feedback only to the exact original adopted query and completed native turn, including late off-page completion', async () => {
  const f = await fixture()
  const record = core.AgentMuxClient.prototype.recordExternalConversationMessage
  let release!: () => void, entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), reading = new Promise<void>(resolve => { entered = resolve })
  const capture = vi.spyOn(core.AgentMuxClient.prototype, 'recordExternalConversationMessage').mockImplementation(async function (this: core.AgentMuxClient, input) {
    entered(); await held; return await record.call(this, input)
  })
  const received = await f.receive('original-query')
  try {
    await reading; await f.expectStages('original-query', ['received'])
    expect(f.packets).toHaveLength(0)
    const retained = (await f.rpc.call('connection.ingress.inspect', { ingressId: received.ingressId })).ingress
    expect(retained?.kind).not.toBe('action')
    expect(retained && retained.kind !== 'action' ? retained.group?.recorded : undefined).toBeUndefined()
  } finally { release(); capture.mockRestore() }
  await f.admitted(received); expect(f.packets).toHaveLength(1)
  const input = (await f.rpc.call('connection.ingress.inspect', { ingressId: received.ingressId })).ingress!.input!
  if (!('messageId' in input)) throw Error('Original group message input required')
  expect(input).toMatchObject({ hostId: 'local', agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' } })
  expect((await f.feedback('original-query')).map(item => item.queryFeedback!.stage)).toEqual(['received'])
  await f.adopt(); await f.expectStages('original-query', ['received', 'started'])
  await f.complete('another-original-turn')
  await f.complete(f.packets[0]!.turnId, 'turn_aborted')
  await f.reply('A final reply is not a completed query')
  await vi.waitFor(() => expect(JSON.stringify(f.remote.calls)).toContain('A final reply is not a completed query'))
  expect((await f.feedback('original-query')).map(item => item.queryFeedback!.stage)).not.toContain('completed')
  // Original system records force the same real Conversation reader across a bounded page; they are not chat speech.
  await appendFile(f.transcript, Array.from({ length: 110 }, (_value, index) => f.row({ type: 'response_item', payload: { type: 'message', id: 'private-system-' + index, role: 'system', content: [{ type: 'input_text', text: 'Unshared native context ' + index }] } })).join(''))
  await f.complete(f.packets[0]!.turnId)
  await f.expectStages('original-query', ['received', 'started', 'completed'])
  expect(f.reactionPosts('original-query').map(call => JSON.parse(call.body).reaction_type.emoji_type)).toEqual(['Get', 'OnIt', 'DONE'])
  await f.receive('original-query')
  expect(f.packets).toHaveLength(1); expect(f.reactionPosts('original-query')).toHaveLength(3)
  const receipts = await f.feedback('original-query')
  expect(receipts).toHaveLength(3)
  for (const receipt of receipts) {
    expect(receipt).toMatchObject({ target: { application: f.config.application, externalConversationId: 'original-room' }, queryFeedback: { ingressId: received.ingressId, messageId: 'original-query' }, mapping: { messageId: 'original-query', reactionId: expect.any(String) } })
    expect(await f.rpc.call('connection.delivery.inspect', { operationId: receipt.operationId })).toEqual({ delivery: receipt })
  }
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.socket, 'connection', 'delivery', 'inspect', '--operation-id', receipts[2]!.operationId], objectCliEnvironment(f.original.root))
  expect(cli.code, cli.stdout + cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual({ delivery: receipts[2] })
  const ambiguous = await f.receive('ambiguous-query'), ambiguousPacket = await f.admitted(ambiguous)
  expect(f.packets).toHaveLength(2)
  await f.adopt(ambiguousPacket, ['ambiguous-original-one', 'ambiguous-original-two'])
  await f.complete(f.packets[1]!.turnId); await f.reply('Ambiguous input remains independently readable')
  await vi.waitFor(() => expect(JSON.stringify(f.remote.calls)).toContain('Ambiguous input remains independently readable'))
  expect((await f.feedback('ambiguous-query')).map(item => item.queryFeedback!.stage)).toEqual(['received'])
  expect((await f.rpc.call('connection.ingress.inspect', { ingressId: ambiguous.ingressId })).inputReceipt?.status).toBe('admitted')
  const database = f.service.publication!.store.database
  const inputPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT record_json FROM connection_ingress_message WHERE json_extract(record_json,'$.input.hostId')=? AND json_extract(record_json,'$.input.agentSessionId')=? AND json_extract(record_json,'$.input.expectedRun.runId')=? AND json_extract(record_json,'$.input.messageId')=?`).all('local', 'original-agent', 'run-original-agent', input.messageId)
  expect(inputPlan.map(row => row.detail).join(' ')).toMatch(/SEARCH.*USING INDEX connection_ingress_query_input/u)
  const turnPlan = database.prepare(`EXPLAIN QUERY PLAN SELECT operation_json FROM connector_publication_operation WHERE binding_id=? AND binding_revision=? AND json_extract(operation_json,'$.payload.kind')='query-feedback' AND json_extract(operation_json,'$.payload.stage')='started' AND json_extract(operation_json,'$.queryTurn.record.source.providerId')=? AND json_extract(operation_json,'$.queryTurn.record.source.nativeSessionId')=? AND json_extract(operation_json,'$.queryTurn.turnId')=?`).all(f.binding.bindingId, 1, f.source.providerId, f.source.nativeSessionId, f.packets[0]!.turnId)
  expect(turnPlan.map(row => row.detail).join(' ')).toMatch(/SEARCH.*USING INDEX connector_publication_query_turn/u)
  await expect(stat(f.desktop)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(JSON.stringify(f.remote.calls)).not.toContain('Unshared native context')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)

it.each(['waiting', 'terminal'] as const)('%s input retains received feedback without inventing native processing or completion', async mode => {
  const f = await fixture(mode), received = await f.receive(mode + '-query')
  await f.expectStages(mode + '-query', ['received'])
  await vi.waitFor(async () => expect((await f.rpc.call('connection.ingress.inspect', { ingressId: received.ingressId })).inputReceipt?.status).toBe(mode === 'waiting' ? 'waiting' : 'terminal-confirmed'))
  await f.complete('unrelated-completed-turn'); await f.reply('Independent final reply for ' + mode)
  await vi.waitFor(() => expect(JSON.stringify(f.remote.calls)).toContain('Independent final reply for ' + mode))
  expect((await f.feedback(mode + '-query')).map(item => item.queryFeedback!.stage)).toEqual(['received'])
  expect(f.reactionPosts(mode + '-query')).toHaveLength(1)
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)

it('unknown reaction reopens under its original effect without a second create and reaction permission failure never blocks original input or reply', async () => {
  const f = await fixture(); f.controls.unknown = 'OnIt'; f.controls.reconcileUnavailable = true
  const original = await f.receive('unknown-query'); await f.admitted(original); expect(f.packets).toHaveLength(1)
  await f.adopt()
  await vi.waitFor(async () => expect((await f.feedback('unknown-query')).some(item => item.queryFeedback!.stage === 'started' && item.state === 'unknown')).toBe(true), { timeout: 15_000 })
  const before = (await f.feedback('unknown-query')).find(item => item.queryFeedback!.stage === 'started')!
  await f.reply('Body continues after uncertain reaction')
  await vi.waitFor(() => expect(JSON.stringify(f.remote.calls)).toContain('Body continues after uncertain reaction'))
  await f.reopen(); delete f.controls.unknown; delete f.controls.reconcileUnavailable
  await f.expectStages('unknown-query', ['received', 'started'])
  expect((await f.feedback('unknown-query')).find(item => item.queryFeedback!.stage === 'started')).toMatchObject({ operationId: before.operationId, mapping: { messageId: 'unknown-query', reactionId: expect.any(String) } })
  expect(f.reactionPosts('unknown-query').filter(call => JSON.parse(call.body).reaction_type.emoji_type === 'OnIt')).toHaveLength(1)
  const lookups = f.remote.calls.filter(call => call.method === 'GET' && call.path === '/open-apis/im/v1/messages/unknown-query/reactions')
  expect(lookups.length).toBeGreaterThan(0)
  expect(lookups.every(call => call.query.page_size === '50')).toBe(true)
  await f.service.ingress!.dispatch(original.ingressId); expect(f.packets).toHaveLength(1)
  f.controls.fail = 'Get'
  const second = await f.receive('missing-scope-query')
  await f.admitted(second); expect(f.packets).toHaveLength(2)
  await vi.waitFor(async () => expect((await f.feedback('missing-scope-query')).some(item => item.queryFeedback!.stage === 'received' && item.state === 'not-applied')).toBe(true))
  await f.reply('Body continues without reaction permission')
  await vi.waitFor(() => expect(JSON.stringify(f.remote.calls)).toContain('Body continues without reaction permission'))
  expect((await f.rpc.call('connection.ingress.inspect', { ingressId: second.ingressId })).inputReceipt?.status).toBe('admitted')
  expect(f.original.inner.kernel.stop).not.toHaveBeenCalled()
}, 45_000)
