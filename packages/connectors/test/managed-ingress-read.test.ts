import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { savedQuestionEvent, savedQuestionJsonl, savedQuestionId } from '../../core/test/helpers/codex-saved-question.js'
import { permissionActionsFixture } from './fixtures/permission-actions.js'
import { ingressFixture } from './fixtures/ingress.js'
import * as core from '../../core/dist/index.js'
import { createHostConnectionOwner } from '../../../apps/host/src/connections.js'
import { context } from './fixtures/room-binding.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function proof(name: string, value: unknown) {
  if (!process.env.INGRESS_READ_PROOF) return
  await mkdir(process.env.INGRESS_READ_PROOF, { recursive: true })
  await writeFile(join(process.env.INGRESS_READ_PROOF, name + '.json'), JSON.stringify(value, null, 2) + '\n')
}
function result(output: { code: number | null; stdout: string; stderr: string }) {
  expect(output.code, output.stdout + output.stderr).toBe(0)
  return JSON.parse(output.stdout).result
}
async function managed(root: string, socket: string, capability: string, agentSessionId = 'original-agent') {
  const credentials = { agentSessionId, capability }
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket }, credentials }); closes.push(() => rpc.dispose())
  const env = objectCliEnvironment(root, { AGENTMUX_AGENT_SESSION_ID: agentSessionId, AGENTMUX_AGENT_CAPABILITY: capability })
  const cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + socket, 'connection', ...args], env)
  return { rpc, cli }
}

it('managed native intake follows public diagnosis to exact action and original Question receipt without enrollment ownership', async () => {
  const f = await permissionActionsFixture(); closes.push(f.close)
  const caller = await managed(f.original.root, join(f.original.root, 'desktop.sock'), f.original.capability)
  expect(await f.services.connections.ownsEnrollmentConnection?.(f.binding.connectionId, 'original-agent')).toBe(false)
  expect(f.binding.authorizedBy.kind).toBe('user')
  const action = f.action('unmapped-reference', 'unassigned-question-action', { action: { tag: 'button', name: 'submit_original_answer',
    value: { actionRef: 'unmapped-reference', questionFields: [{ questionId: 'unmapped-question', textField: 'original_text' }] }, form_value: { original_text: 'Received original text' } } })
  await f.sdk.receive(action)
  const diagnosed = result(await caller.cli(['diagnose', '--host', 'local', '--session', 'original-agent']))
  const id = diagnosed.groups.value.items[0].incoming.value.rows.find((r: { kind: string }) => r.kind === 'action').ingressId
  const inspect = () => caller.rpc.call('connection.ingress.inspect', { ingressId: id })
  await expect(inspect()).resolves.toMatchObject({ observation: 'not-started' })
  const before = await inspect()
  expect(before).toMatchObject({ ingress: { kind: 'action', eventId: action.header.event_id, actionRef: 'unmapped-reference',
    answers: [{ questionId: 'unmapped-question', text: 'Received original text' }], state: 'refused' }, inputReceipt: null, observation: 'not-started' })
  expect(before.ingress!.input).toBeUndefined()
  expect(result(await caller.cli(['ingress', 'inspect', '--ingress', id]))).toEqual(before)
  await expect(caller.rpc.call('connection.ingress.ls', { connectionId: f.binding.connectionId })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(caller.rpc.call('connection.ingress.authority', { operationId: 'unassigned' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })

  const list = f.services.bindings!.list.bind(f.services.bindings!), active = await list({ executionHostId: 'local', agentSessionId: 'original-agent' })
  let observations = 0
  const changingAudience = vi.spyOn(f.services.bindings!, 'list').mockImplementation(async input => {
    if (++observations === 1) return list(input)
    return { bindings: active.bindings.map(binding => ({ ...binding, state: 'detached' as const })) }
  })
  await expect(inspect()).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(observations).toBe(2); changingAudience.mockRestore()
  expect((await f.services.ingress!.inspect({ ingressId: id })).ingress!.input).toBeUndefined()

  await f.grant(['answer']); const original = (await f.original.store.readMetadata('original-agent'))!
  const actor = { protocolId: 'codex-app-server-v2-0.163', actorId: 'read-original-actor', lifecycleOperationId: 'read-original-lifecycle', token: 'a'.repeat(64), launch: { command: 'codex', args: [] } }
  await f.original.store.compareAndSwap(original, { ...original, nativeActor: actor }); await f.original.inner.registry.load('local')
  const send = vi.fn(async () => ({ outcome: 'admitted' as const, turnId: 'original-answer-turn' }))
  f.original.client.providers.get('codex').prepareNativeInput = async (_context, source) => ({
    plan: { kind: 'native-rpc', protocolId: actor.protocolId, sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), actorId: actor.actorId, threadId: source.nativeSessionId, operation: 'start-or-steer' },
    assertCurrent: async () => {}, send, dispose() {}
  })
  const native = savedQuestionEvent(); native.payload.thread_id = 'original-native'
  await appendFile(join(f.original.root, 'native.jsonl'), savedQuestionJsonl([native])); f.services.publication!.refresh()
  const originalQuestion = () => f.services.publication!.store.list(f.binding).find(p => p.payload.kind === 'question' && p.payload.actionRef && p.state === 'confirmed')
  await vi.waitFor(() => expect(originalQuestion()).toBeDefined(), { timeout: 8000 })
  const publication = originalQuestion()!
  if (publication.payload.kind !== 'question') throw Error('Expected typed original Question publication')
  // Controlled final SDK event uses original semantic metadata; card layout is outside this read test.
  const value = { actionRef: publication.payload.actionRef!, questionFields: publication.payload.questions.map((q, index) => ({
    questionId: q.id, optionField: `answer_${index}`, optionIds: q.options.map(option => option.id) })) }
  const answer = f.action(value.actionRef, 'original-question-submitted', { context: { open_chat_id: 'original-room', open_message_id: publication.mapping!.messageId },
    action: { tag: 'button', name: 'controlled_read_fixture_submit', value, form_value: { answer_0: '0' } } })
  await f.sdk.receive(answer)
  const answeredRecord = async () => (await f.services.ingress!.list({ connectionId: f.binding.connectionId })).ingresses.find(r => r.eventId === answer.header.event_id)!
  await vi.waitFor(async () => expect(await answeredRecord()).toMatchObject({ state: 'claimed' }), { timeout: 8000 })
  const answered = await answeredRecord()
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 8000 })
  const accepted = await caller.rpc.call('connection.ingress.inspect', { ingressId: answered.ingressId })
  expect(accepted).toMatchObject({ questionReceipt: { agentSessionId: 'original-agent', outcome: 'submitted', questionIds: [savedQuestionId] } })
  expect(result(await caller.cli(['ingress', 'inspect', '--ingress', answered.ingressId]))).toEqual(accepted)
  const pause = await f.rpc.call('connection.binding.pause', { operationId: 'pause-original-reading', bindingId: f.binding.bindingId, expectedRevision: 1 })
  expect(pause.state).toBe('applied'); expect(await inspect()).toEqual(before)
  await f.rpc.call('connection.binding.detach', { operationId: 'detach-original-reading', bindingId: f.binding.bindingId, expectedRevision: 2 })
  await expect(inspect()).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(await caller.rpc.call('connection.ingress.inspect', { ingressId: answered.ingressId })).toEqual(accepted)
  expect(send).toHaveBeenCalledOnce(); expect(f.original.rawInput).not.toHaveBeenCalled()
  await proof('native-consumer', { boundary: 'Official SDK action fields are controlled here. This test proves managed read qualification, not the remote native form mapping.', diagnosed, before, accepted, actualCli: true, nativeSends: send.mock.calls.length })
}, 45000)

async function groupFixture(reader = 'original-agent') {
  const f = await ingressFixture(); closes.push(f.close)
  if (reader !== 'original-agent') {
    const original = (await f.store.load())[0]!
    const { nativeHandle: _handle, nativeBinding: _binding, ...retained } = original
    await f.store.compareAndSwap(null, { ...retained, agentSessionId: reader, run: { runId: 'run-' + reader } }); await f.inner.registry.load('local')
  }
  // Reopen the same fixture intake with the production Host composition. The public call
  // must cross servicePort and createConnectionServices' lazy forwarding wrapper.
  f.connections.close(); await f.client.dispose()
  const owner = createHostConnectionOwner({ directory: f.root, spatial: f.spatial,
    adapters: [{ adapterId: 'sample', test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }),
      ingress: { adapterId: 'sample', verify: f.verifier } }] })
  const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
    const inner = this as unknown as typeof f.inner
    await inner.registry.load('local'); inner.connected = true
    for (const name of ['isConnected', 'status', 'identity', 'input', 'openInput', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[name] = f.inner.kernel[name]
  })
  const socket = join(f.root, 'managed-ingress.sock')
  const runtime = await core.startHeadlessAgentMux({ store: f.store, stateDirectory: f.root, socketPath: socket,
    externalInputAuthority: owner.authority, service: { connections: owner.connections } })
  closes.push(async () => { await owner.close(); await runtime.stop() })
  await vi.waitFor(() => expect((runtime.client as unknown as typeof f.inner).connected).toBe(true)); connect.mockRestore()
  await owner.start(runtime)
  const services = await owner.services()
  await owner.connections.inspect({ connectionId: f.input.connectionId })
  const ingress = services.ingress!, bindings = services.bindings!
  const caller = await managed(f.root, socket, f.capability, reader)
  const receive = (override: Parameters<typeof f.event>[0] = {}) => ingress.receive({ connectionId: f.input.connectionId,
    raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event(override) }) }, () => {})
  return { ...f, caller, connections: owner.connections, bindings, ingress, receive, client: runtime.client, runtime }

}

it('managed group reads authorize the original frozen snapshot before Core and preserve aliases and historical receipts', async () => {
  const f = await groupFixture(), config = (await f.connections.inspect({ connectionId: f.input.connectionId })).connection!.config
  await f.connections.configure({ operationId: 'alias-configuration', expectedRevision: null, connection: { ...config, connectionId: 'receiver-alias' } })
  const received = await f.ingress.receive({ connectionId: 'receiver-alias', raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ conversationKind: 'group' }) }) }, () => {})
  await f.ingress.dispatch(received.ingress.ingressId)
  const order: string[] = [], inspectBinding = f.bindings.inspect.bind(f.bindings), inspectCore = f.client.inspectAgentInput.bind(f.client)
  vi.spyOn(f.bindings, 'inspect').mockImplementation(async input => { order.push('binding'); return inspectBinding(input) })
  const core = vi.spyOn(f.client, 'inspectAgentInput').mockImplementation(async input => { order.push('core'); return inspectCore(input) })
  const request = { ingressId: received.ingress.ingressId }
  const result = await f.caller.rpc.call('connection.ingress.inspect', request)
  expect(result.ingress).toMatchObject({ connectionId: 'receiver-alias', group: { target: { agentSessionId: 'original-agent', connectionId: f.input.connectionId } } })
  expect(result.ingress!.input).toBeDefined(); expect(core).toHaveBeenCalled()
  expect(order.indexOf('binding')).toBeGreaterThanOrEqual(0)
  expect(order.indexOf('core')).toBeGreaterThan(order.indexOf('binding'))
  await f.bindings.detach({ operationId: 'detach-group-reading', bindingId: f.input.bindingId, expectedRevision: 1 }, context)
  expect(await f.caller.rpc.call('connection.ingress.inspect', request)).toEqual(result)
  const unavailable = vi.spyOn(f.bindings, 'inspect').mockRejectedValue(Error('Controlled original binding observation gap'))
  const coreCalls = core.mock.calls.length
  await expect(f.caller.rpc.call('connection.ingress.inspect', request)).rejects.toBeDefined()
  expect(core).toHaveBeenCalledTimes(coreCalls); unavailable.mockRestore()
  expect(await f.caller.rpc.call('connection.ingress.inspect', { ingressId: 'missing-ingress' })).toEqual({ ingress: null, inputReceipt: null, observation: 'not-started' })
  const unassigned = await f.receive({ eventId: 'unassigned-direct', messageId: 'unassigned-direct-message', conversationKind: 'direct' })
  expect(unassigned.ingress.input).toBeUndefined()
  const priorCoreReads = core.mock.calls.length
  await expect(f.caller.rpc.call('connection.ingress.inspect', { ingressId: unassigned.ingress.ingressId })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(core).toHaveBeenCalledTimes(priorCoreReads)
  const bindingRead = f.bindings.inspect.bind(f.bindings)
  const revoke = vi.spyOn(f.bindings, 'inspect').mockImplementationOnce(async input => {
    const value = await bindingRead(input), original = (await f.store.readMetadata('original-agent'))!
    await f.store.compareAndSwapMetadata(original, { ...original, capabilityHash: '0'.repeat(64) })
    await (f.client as unknown as typeof f.inner).registry.load('local')
    return value
  })
  await expect(f.caller.rpc.call('connection.ingress.inspect', request)).rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
  expect(core).toHaveBeenCalledTimes(priorCoreReads); revoke.mockRestore()
  await proof('group-consumer', { result, order, exactAliasRetained: true, historicalRead: true, noCoreOnAuthorizationGap: true })
}, 30000)

it('a frozen foreign group target cannot borrow current audience access or read foreign Core before refusal', async () => {
  const f = await groupFixture('different-reader')
  const received = await f.receive({ conversationKind: 'group' }); await f.ingress.dispatch(received.ingress.ingressId)
  const originalBinding = (await f.bindings.inspect({ bindingId: f.input.bindingId })).binding!
  // Controlled current-audience observation makes the precedence counterexample reachable.
  // The authenticated caller, original intake snapshot and Core read owner remain real.
  const audience = vi.spyOn(f.bindings, 'list').mockResolvedValue({ bindings: [{ ...originalBinding, agentSessionId: 'different-reader' }] })
  const core = vi.spyOn(f.client, 'inspectAgentInput')
  const request = { ingressId: received.ingress.ingressId }
  await expect(f.caller.rpc.call('connection.ingress.inspect', request)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(core).not.toHaveBeenCalled(); expect(audience).not.toHaveBeenCalled()
  const user = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'managed-ingress.sock') } }); closes.push(() => user.dispose())
  expect((await user.call('connection.ingress.inspect', request)).ingress?.ingressId).toBe(request.ingressId)
  expect(core).toHaveBeenCalledOnce()
  await proof('foreign-precedence', { managed: 'CONTROL_PERMISSION_DENIED before current-audience lookup or Core read', trustedUser: 'original record remains readable', controlledPort: 'current Binding list only, to establish conflicting same-audience counterexample' })
}, 30000)
