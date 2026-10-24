import { afterAll, afterEach, expect, it, vi } from 'vitest'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import * as core from '../../core/dist/index.js'
import { connectHostedAgentMux } from '../../core/dist/hosted.js'
import { parseConnectionServiceParams, parseConnectionServiceResult } from '@agentmux/core/connections'
import { createHostedIngressCorePort, createPublicationConversationPort } from '../dist/index.js'
import { PublicationStore } from '../dist/publication-store.js'
import type { PublicationReceipt } from '../src/publication-store.js'
import { createConnectionServices } from '../src/connection-services.js'
import { ingressFixture } from './fixtures/ingress.js'
import { signedRoomAdapter } from './fixtures/signed-room-adapter.js'
import { feishuConfig, feishuPayload, feishuSdkTransport } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => void | Promise<void>> = []
const runtimeEvidence: unknown[] = []
const evidence = (scenario: string, facts: unknown) => { runtimeEvidence.push({ scenario, facts }) }
afterAll(async () => { if (process.env.AGENTMUX_CONNECTOR_SERVICE_RECEIPT) await writeFile(process.env.AGENTMUX_CONNECTOR_SERVICE_RECEIPT, JSON.stringify({ schema: 'agentmux.connection-service-consumer.v1', scope: 'Actual SDK, compiled CLI, default ConnectionHost, original execution Host; controlled protocol and Runtime I/O only', scenarios: runtimeEvidence }, null, 2) + '\n') })
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const policy = (operationId: string, expectedRevision: number, enabled: boolean) => ({ operationId, expectedRevision, service: { enabled } })
const row = (id: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Original speech ' + id }] } }) + '\n'
const success = (result: { code: number | null; stdout: string; stderr: string }) => { expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result }
async function child(root: string, mode: string, held = 0) {
  const process = fork(new URL('./fixtures/connection-service-owner.mjs', import.meta.url), [root, mode, String(held)], {
    execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  let stderr = ''; process.stderr!.on('data', text => { stderr += text })
  cleanup.push(async () => { if (process.exitCode === null && process.signalCode === null) { process.kill('SIGKILL'); await once(process, 'exit') } })
  const message = (kind: string) => new Promise<void>((resolve, reject) => {
    const accept = (value: unknown) => { if ((value as { kind: string }).kind === kind) { process.off('message', accept); process.off('exit', fail); resolve() } }
    const fail = () => { process.off('message', accept); reject(new Error(stderr || 'Original test Host exited before ' + kind)) }
    process.on('message', accept); process.once('exit', fail)
  })
  await message('ready')
  return { process, message }
}
async function fixture(options: { feishu?: boolean; publication?: boolean; coreAvailable?: boolean; dual?: boolean } = {}) {
  const original = await ingressFixture(true); cleanup.push(() => original.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const wire = signedRoomAdapter(), starts = vi.spyOn(wire.adapter.transport!, 'start')
  const secondary = options.dual ? signedRoomAdapter('secondary-room') : undefined
  const platform = options.feishu ? await feishuPublicationHttp() : undefined
  if (platform) cleanup.push(() => platform.close())
  const transport = options.feishu ? feishuSdkTransport() : undefined
  if (platform) vi.spyOn(defaultHttpInstance, 'request').mockImplementation(platform.http.request as unknown as typeof defaultHttpInstance.request)
  // Only this pointer changes when the actual execution Host takes over the same durable Store.
  let inputCore = (hostId: string): import('../src/durable-ingress.js').DurableIngressCore | undefined => options.coreAvailable === false || hostId !== 'local' ? undefined : original.client
  const services = await createConnectionServices({ directory: join(original.root, 'service-owner'), ...(options.feishu ? {} : { adapters: [wire.adapter, ...(secondary ? [secondary.adapter] : [])] }),
    bindings: { spatial: original.spatial, checkpoint: async ref => await original.client.conversationCheckpoint(ref) },
    ...(options.publication === false ? {} : { publication: createPublicationConversationPort(original.coreClients) }), ingress: { core: hostId => inputCore(hostId) } })
  cleanup.push(() => services.close())
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'service.sock'), connections: services.connections, spatialState: original.spatial, coreClients: original.coreClients })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => sdk.dispose())
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', ...args], objectCliEnvironment(original.root), input === undefined ? '' : JSON.stringify(input))
  const credential = await services.secrets.store({ operationId: 'service-credential', secret: options.feishu ? 'fixture-credential' : 'fixture-signing-key' })
  const config = options.feishu ? { ...feishuConfig, credentialRef: credential.credentialRef } : { connectionId: original.input.connectionId, adapterId: 'signed-room', application: { domain: 'signed.example', appId: 'signed-app' }, label: 'Original bot', enabled: true, credentialRef: credential.credentialRef }
  await sdk.call('connection.configure', { operationId: 'original-application', expectedRevision: null, connection: config })
  const input = { ...original.input, connectionId: config.connectionId, scope: { ...original.input.scope, input: 'all-messages' as const } }
  const applied = await sdk.call('connection.bind', input)
  expect(applied.state).toBe('applied'); if (applied.state !== 'applied') throw new Error('Original Binding not applied')
  const actor = { application: config.application, idType: options.feishu ? 'open_id' : 'email', userId: 'original-external-user' }
  const grant = { ...original.grant, actor }
  await sdk.call('connection.grant', grant)
  if (transport) await vi.waitFor(() => expect(transport.sockets).toHaveLength(1))
  else await vi.waitFor(() => expect(wire.endpoint).toBeDefined())
  const message = (suffix = 'one') => ({ deliveryKey: 'event/' + suffix, recordKey: 'message/' + suffix, roomKey: input.externalConversationId, person: actor.userId, text: 'External original ' + suffix, addressing: 'broadcast' as const })
  const set = (operationId: string, revision: number, enabled: boolean) => sdk.call('connection.service.configure', policy(operationId, revision, enabled))
  return { ...original, services, server, sdk, cli, wire, secondary, platform, transport, config, input, grant, actor, binding: applied.binding, starts, set, message,
    setInputCore: (read: typeof inputCore) => { inputCore = read } }
}

it('shares strict policy CAS and original receipts through the actual public SDK, compiled CLI and default Host, independently of bot configuration', async () => {
  const f = await fixture(), before = await f.sdk.call('connection.inspect', { operationId: 'original-application' })
  expect(success(await f.cli(['service', 'get']))).toEqual({ enabled: true, revision: 0 })
  const help = await f.cli(['service', '--help']), leaf = await f.cli(['service', 'configure', '--help'])
  expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('amux connection service get'); expect(help.stdout).toContain('amux connection service inspect --operation-id ID')
  expect(leaf.code, leaf.stderr).toBe(0); expect(leaf.stdout).toContain('amux connection service configure --input FILE|-'); expect(leaf.stdout).toContain('transport-approved user/device')
  const skill = await runCompiledObjectCli(['connection', '--skill'], objectCliEnvironment(f.root))
  expect(skill.code, skill.stderr).toBe(0); expect(skill.stdout).toContain('connection service get'); expect(skill.stdout).toContain('service inspect reads that receipt')
  expect(f.services.database!.prepare('SELECT * FROM connection_service_policy').all()).toEqual([])
  const off = success(await f.cli(['service', 'configure', '--input', '-'], policy('original-off', 0, false)))
  expect(off).toEqual({ operationId: 'original-off', expectedRevision: 0, status: 'configured', service: { enabled: false, revision: 1 } })
  expect(await f.set('original-off', 0, false)).toEqual(off)
  await expect(f.set('original-off', 0, true)).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(f.set('stale-policy', 0, true)).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  await expect(f.set('original-application', 1, true)).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(f.sdk.call('connection.configure', { operationId: 'original-off', expectedRevision: 1, connection: f.config })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  expect(await f.sdk.call('connection.inspect', { operationId: 'original-off' })).toEqual({ operation: null, connection: null })
  expect(await f.sdk.call('connection.service.inspect', { operationId: 'original-application' })).toEqual({ operation: null })
  const current = (await f.sdk.call('connection.ls', {})).connections
  expect(current).toHaveLength(1); expect(current[0]).toMatchObject({ config: { enabled: true }, revision: 1, observation: { transport: { state: 'disabled' }, intake: { state: 'disabled' }, delivery: { state: 'disabled' } } })
  await f.set('original-on', 1, true)
  expect(success(await f.cli(['service', 'inspect', '--operation-id', 'original-off']))).toEqual({ operation: off })
  expect((await f.sdk.call('connection.inspect', { operationId: 'original-application' })).operation).toEqual(before.operation)
  const service = new core.AgentMuxRpcService({ connections: f.services.connections }); cleanup.push(() => service.dispose())
  await expect(service.call('connection.service.configure', policy('untrusted', 2, false), {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.cli(['service', 'configure', '--input', '-'], { ...policy('forged', 2, false), authenticated: true })).code).not.toBe(0)
  for (const value of [{ ...off, operationId: 'foreign' }, { ...off, expectedRevision: 1 }, { ...off, service: { enabled: true, revision: 1 } }, { ...off, service: { enabled: false, revision: 4 } }]) expect(() => parseConnectionServiceResult('connection.service.configure', value, policy('original-off', 0, false))).toThrow()
  expect(() => parseConnectionServiceParams('connection.service.get', { enabled: true })).toThrow()
  expect(() => parseConnectionServiceResult('connection.service.get', { enabled: false, revision: 0 }, {})).toThrow()
  const absent = new core.AgentMuxRpcService({ connections: { list: async () => ({ connections: [] }), inspect: async () => ({ connection: null, operation: null }), configure: f.services.connections.configure, test: f.services.connections.test } }); cleanup.push(() => absent.dispose())
  await expect(absent.call('connection.service.get', {}, { principal: { kind: 'user', id: 'local' } })).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect(await absent.call('connection.ls', {}, { principal: { kind: 'user', id: 'local' } })).toEqual({ connections: [] })
  evidence('public-policy', { off, currentAfterEnable: await f.sdk.call('connection.service.get', {}), originalReceiptAfterEnable: await f.sdk.call('connection.service.inspect', { operationId: 'original-off' }), preservedApplication: (await f.sdk.call('connection.inspect', { operationId: 'original-application' })).operation })
}, 30_000)

it('scoped adapter policy preserves global receipts while only its original automatic traffic pauses through SDK and compiled CLI', async () => {
  const f = await fixture({ dual: true }), secondary = f.secondary!, late = f.wire.receive!
  const secondConfig = { ...f.config, connectionId: 'second-channel-bot', adapterId: secondary.adapter.adapterId, application: { domain: 'second.example', appId: 'second-app' } }
  await f.sdk.call('connection.configure', { operationId: 'save-second-channel', expectedRevision: null, connection: secondConfig })
  const bound = await f.sdk.call('connection.bind', { ...f.input, operationId: 'bind-second-channel', bindingId: 'second-channel-binding', connectionId: secondConfig.connectionId, externalConversationId: 'second-room' })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('Original second Binding not applied')
  const secondActor = { ...f.actor, application: secondConfig.application }
  await f.sdk.call('connection.grant', { ...f.grant, operationId: 'grant-second-channel', grantId: 'second-channel-grant', bindingId: bound.binding.bindingId, expectedBindingRevision: bound.binding.revision, actor: secondActor })
  await vi.waitFor(() => expect(secondary.endpoint).toBeDefined())
  const global = await f.set('keep-global-enabled', 0, true)
  const originalGlobal = f.services.database!.prepare('SELECT input_json,result_json FROM connection_configuration_operation WHERE operation_id=?').get(global.operationId)
  const input = { ...policy('pause-only-original-adapter', 0, false), adapterId: f.config.adapterId }
  expect(success(await f.cli(['service', 'get', '--adapter', f.config.adapterId]))).toEqual({ enabled: true, revision: 0, adapterId: f.config.adapterId })
  const paused = success(await f.cli(['service', 'configure', '--input', '-'], input))
  expect(paused).toEqual({ operationId: input.operationId, expectedRevision: 0, status: 'configured', service: { adapterId: f.config.adapterId, enabled: false, revision: 1 } })
  expect(await f.sdk.call('connection.service.get', { adapterId: f.config.adapterId })).toEqual(paused.service)
  expect(await f.sdk.call('connection.service.get', {})).toEqual(global.service)
  expect(await f.sdk.call('connection.service.get', { adapterId: secondConfig.adapterId })).toEqual({ adapterId: secondConfig.adapterId, enabled: true, revision: 0 })
  await expect(f.sdk.call('connection.service.configure', { ...input, adapterId: secondConfig.adapterId })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(f.sdk.call('connection.service.configure', { ...input, operationId: 'stale-scoped-choice' })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  const acknowledgement = vi.fn()
  const admission = await late(f.wire.encode(f.message('after-adapter-pause')), acknowledgement).then(() => ({ code: null }), error => ({ code: error.code }))
  evidence('scoped-adapter-new-admission', { input, paused, admission, acknowledgementCalls: acknowledgement.mock.calls.length, retained: (await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses })
  expect(admission, 'paused adapter rejects new original traffic before durable ACK').toEqual({ code: 'CONNECTION_SERVICE_DISABLED' })
  expect(acknowledgement).not.toHaveBeenCalled()
  expect((await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses).toEqual([])
  await appendFile(f.transcript, row('other-adapter-continues'))
  await vi.waitFor(() => expect(secondary.effects).toHaveLength(1))
  expect(f.wire.effects, 'paused adapter cannot dispatch new automatic output').toEqual([])
  expect(await secondary.post({ ...f.message('second-adapter-input'), roomKey: 'second-room' })).toBe(202)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  expect((await f.services.ingress!.list({ connectionId: secondConfig.connectionId })).ingresses).toHaveLength(1)
  const diagnosis = await f.sdk.call('connection.diagnose', { executionHostId: f.input.executionHostId, agentSessionId: f.input.agentSessionId, bindingId: f.binding.bindingId })
  expect(diagnosis.service.value).toEqual(global.service)
  expect(diagnosis.groups.value?.items[0]?.adapterService).toEqual({ value: paused.service, issue: null })
  const configured = (await f.sdk.call('connection.ls', {})).connections
  expect(configured.map(record => [record.config.connectionId, record.config.enabled, record.revision])).toEqual([[f.config.connectionId, true, 1], [secondConfig.connectionId, true, 1]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.services.database!.prepare('SELECT input_json,result_json FROM connection_configuration_operation WHERE operation_id=?').get(global.operationId)).toEqual(originalGlobal)
  expect(success(await f.cli(['service', 'inspect', '--operation-id', input.operationId]))).toEqual({ operation: paused })
  await f.sdk.call('connection.service.configure', { ...policy('resume-original-adapter', 1, true), adapterId: f.config.adapterId })
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect(success(await f.cli(['service', 'inspect', '--operation-id', input.operationId]))).toEqual({ operation: paused })
  evidence('scoped-adapter-public-and-automatic-owners', { input, paused, global, diagnosis, configured: configured.map(record => ({ config: record.config, revision: record.revision })), originalGlobal, preservedGlobal: f.services.database!.prepare('SELECT input_json,result_json FROM connection_configuration_operation WHERE operation_id=?').get(global.operationId), primaryEffects: f.wire.effects, secondaryEffects: secondary.effects, inputCalls: (f.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls.length, originalReceipt: await f.sdk.call('connection.service.inspect', { operationId: input.operationId }) })
}, 30_000)

it.each([{ scope: 'global', adapterId: null }, { scope: 'adapter', adapterId: 'signed-room' }])('recovers a committed $scope policy whose CLI reply is lost through real child death, using the same SQLite receipt and original operation', async selection => {
  const root = await mkdtemp(join(tmpdir(), 'service-restart-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const owner = await child(root, 'drop-policy-reply'), committed = owner.message('policy-committed')
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + join(root, 'service.sock'), 'connection', 'service', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
  const scope = selection.adapterId === null ? {} : { adapterId: selection.adapterId }
  const input = { ...policy('lost-reply', 0, false), ...scope }
  const pending = cli(['configure', '--input', '-'], input)
  await committed; owner.process.kill('SIGKILL'); await once(owner.process, 'exit'); expect((await pending).code).not.toBe(0)
  await child(root, 'observe')
  const saved = success(await cli(['inspect', '--operation-id', 'lost-reply'])).operation
  expect(saved.service).toEqual({ enabled: false, revision: 1, ...scope })
  expect(saved).toMatchObject({ operationId: 'lost-reply', expectedRevision: 0 })
  expect(success(await cli(['configure', '--input', '-'], input))).toEqual(saved)
  success(await cli(['configure', '--input', '-'], { ...policy('reopened', 1, true), ...scope }))
  expect(success(await cli(['inspect', '--operation-id', 'lost-reply']))).toEqual({ operation: saved })
  const current = success(await cli(['get', ...(selection.adapterId === null ? [] : ['--adapter', selection.adapterId])]))
  expect(current).toEqual({ enabled: true, revision: 2, ...scope })
  if (selection.adapterId !== null) expect(success(await cli(['get']))).toEqual({ enabled: true, revision: 0 })
  evidence('process-restart-after-lost-reply-' + selection.scope, { input, originalReceipt: saved, current, retained: success(await cli(['inspect', '--operation-id', 'lost-reply'])) })
}, 30_000)

it('keeps received intake nonterminal while off and resumes its same ingress identity on enable; late callbacks cannot admit another message', async () => {
  const f = await fixture(), acknowledge = vi.fn(), late = f.wire.receive!
  const retained = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message()) }, acknowledge)
  expect(acknowledge).toHaveBeenCalledOnce()
  await f.set('pause-retained', 0, false)
  const waiting = await f.services.ingress!.dispatch(retained.ingress.ingressId)
  expect(waiting).toEqual({ ingress: retained.ingress, inputReceipt: null, observation: 'not-started' })
  expect(waiting.ingress?.state).toBe('received')
  const rejectedAck = vi.fn()
  await expect(late(f.wire.encode(f.message('late')), rejectedAck)).rejects.toMatchObject({ code: 'CONNECTION_SERVICE_DISABLED' })
  expect(rejectedAck).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await f.set('resume-retained', 1, true)
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const after = await f.services.ingress!.inspect({ ingressId: retained.ingress.ingressId })
  expect(after.ingress).toMatchObject({ ingressId: retained.ingress.ingressId, eventId: retained.ingress.eventId, state: 'claimed' })
  expect((await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses).toHaveLength(1)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  evidence('received-off-on', { retained: retained.ingress, whileOff: waiting, afterEnable: after })
}, 20_000)

it.each([{ scope: 'global', adapterId: null }, { scope: 'adapter', adapterId: 'signed-room' }])('rechecks $scope service policy after asynchronous authentication before durable receive and ACK', async selection => {
  const f = await fixture(), verify = f.wire.adapter.ingress!.verify.bind(f.wire.adapter.ingress), entered = deferred<void>(), release = deferred<void>()
  f.wire.adapter.ingress!.verify = async (...args) => { const event = await verify(...args); entered.resolve(); await release.promise; return event }
  const ack = vi.fn(), receive = f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message()) }, ack)
  await entered.promise
  await f.sdk.call('connection.service.configure', { ...policy('auth-race-off', 0, false), ...(selection.adapterId === null ? {} : { adapterId: selection.adapterId }) })
  release.resolve()
  const result = await receive.then(() => ({ code: null }), error => ({ code: error.code }))
  const retained = (await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses
  evidence('post-authentication-policy-' + selection.scope, { result, acknowledgementCalls: ack.mock.calls.length, retained })
  expect(result).toEqual({ code: 'INGRESS_SERVICE_DISABLED' })
  expect(ack).not.toHaveBeenCalled(); expect(retained).toEqual([])
}, 15_000)

it('default SDK transport and publication stop both automatic directions and reopen only the originally enabled application', async () => {
  const f = await fixture({ feishu: true }), originalSocket = f.transport!.sockets[0]!
  await f.sdk.call('connection.configure', { operationId: 'paused-bot', expectedRevision: null, connection: { ...f.config, connectionId: 'paused-bot', application: { ...f.config.application, appId: 'cli_abcdef0123456789' }, enabled: false } })
  await f.transport!.receive(feishuPayload()); await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledOnce())
  const speech = () => f.services.publication!.store.list(f.binding).filter(operation => operation.payload.kind === 'speech')
  const posts = () => { const bodies = new Set(speech().map(operation => operation.prepared?.request.body)); return f.platform!.messageCalls().filter(call => call.method === 'POST' && bodies.has(call.body)) }
  await appendFile(f.transcript, row('before-off')); await vi.waitFor(() => expect(posts()).toHaveLength(1))
  const before = speech(), frontier = f.services.publication!.store.checkpoint(f.binding, f.binding.sourceFrontier?.sourceHostId ?? f.binding.executionHostId)
  await f.set('sdk-off', 0, false)
  await f.transport!.receive(feishuPayload({ message_id: 'late-sdk-message' }), originalSocket)
  await appendFile(f.transcript, row('during-off')); f.services.publication!.refresh()
  expect(posts()).toHaveLength(1)
  expect(speech()).toEqual(before)
  expect(f.services.publication!.store.checkpoint(f.binding, f.binding.sourceFrontier?.sourceHostId ?? f.binding.executionHostId)).toEqual(frontier)
  await f.set('sdk-on', 1, true)
  await vi.waitFor(() => expect(f.transport!.sockets).toHaveLength(2))
  await vi.waitFor(() => expect(posts()).toHaveLength(2))
  const next = feishuPayload({ message_id: 'after-sdk-message' }); next.header.event_id = 'after-sdk-event'
  await f.transport!.receive(next); await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  const records = (await f.sdk.call('connection.ls', {})).connections
  expect(records.map(record => [record.config.connectionId, record.config.enabled, record.revision])).toEqual([['feishu-connection', true, 1], ['paused-bot', false, 1]])
  expect(f.services.publication!.store.inspect(before[0]!.operationId)).toEqual(before[0])
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
  evidence('official-sdk-bidirectional-off-on', { configEnabled: records.map(record => [record.config.connectionId, record.config.enabled, record.revision]), outgoingHttp: f.platform!.messageCalls(), socketGenerations: f.transport!.sockets.length, before, frontier, after: f.services.publication!.store.list(f.binding) })
}, 30_000)

it('isolates service DDL and read faults inside the original default Host, preserves existing lanes and recovers the same policy without seeding', async () => {
  const execute = DatabaseSync.prototype.exec, faults: string[] = []
  const ddl = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql) { if (sql.includes('CREATE TABLE IF NOT EXISTS connection_service_policy')) { faults.push('ddl'); throw new Error('Private service schema failure') }; return execute.call(this, sql) })
  const root = await mkdtemp(join(tmpdir(), 'service-ddl-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const isolated = await createConnectionServices({ directory: root, adapters: [] }); cleanup.push(() => isolated.close())
  expect(isolated.database, 'Service DDL must not withdraw the original ConnectionHost').not.toBeNull()
  await expect(isolated.connections.service!.get()).rejects.toMatchObject({ code: 'CONNECTION_SERVICE_UNCONFIRMED' })
  expect(faults).toEqual(['ddl'])
  const config = { connectionId: 'schema-bot', adapterId: 'sample', application: { domain: 'chat.example', appId: 'schema-app' }, label: 'Retained bot', enabled: true, credentialRef: 'retained-ref' }
  const saved = await isolated.connections.configure({ operationId: 'schema-application', expectedRevision: null, connection: config })
  expect((await isolated.connections.inspect({ operationId: saved.operationId })).operation).toEqual(saved)
  ddl.mockRestore(); expect(await isolated.connections.service!.get()).toEqual({ enabled: true, revision: 0 })
  expect(isolated.database!.prepare('SELECT * FROM connection_service_policy').all()).toEqual([])
  const f = await fixture(), endpoint = f.wire.endpoint
  const retained = await f.services.ingress!.receive({ connectionId: f.config.connectionId, ...f.wire.encode(f.message('schema-read')) }, () => {})
  const claimed = await f.services.ingress!.dispatch(retained.ingress.ingressId)
  expect(claimed.ingress?.state).toBe('claimed')
  await f.set('known-policy', 0, true)
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1).state).toBe('ready'))
  const prepare = f.services.database!.prepare.bind(f.services.database!), readFault = vi.spyOn(f.services.database!, 'prepare').mockImplementation(sql => { if (sql.startsWith('SELECT enabled,revision FROM connection_service_policy')) throw new Error('Private service read failure'); return prepare(sql) })
  await expect(f.sdk.call('connection.service.get', {})).rejects.toMatchObject({ code: 'CONNECTION_SERVICE_UNCONFIRMED' })
  expect(await f.sdk.call('connection.ingress.authority', { operationId: claimed.ingress!.input!.operationId })).toEqual({ ingress: claimed.ingress, authority: 'unavailable', code: 'INGRESS_SERVICE_UNCONFIRMED' })
  expect((await f.sdk.call('connection.inspect', { operationId: 'original-application' })).operation?.operationId).toBe('original-application')
  const originalLane = (f.services.publication as unknown as { lanes: Map<string, unknown> }).lanes.get(f.binding.bindingId)
  f.services.publication!.refresh()
  expect((f.services.publication as unknown as { lanes: Map<string, unknown> }).lanes.get(f.binding.bindingId)).toBe(originalLane)
  expect(f.services.publication!.observation(f.binding.bindingId, 1)).toEqual({ state: 'unavailable', reason: 'storage-unconfirmed' })
  expect(f.wire.endpoint).toBe(endpoint)
  await appendFile(f.transcript, row('fault-retained'))
  readFault.mockRestore(); f.services.publication!.refresh()
  expect(await f.sdk.call('connection.service.get', {})).toEqual({ enabled: true, revision: 1 })
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  evidence('service-schema-read-isolation', { ddlFaults: faults.length, defaultNoRows: isolated.database!.prepare('SELECT * FROM connection_service_policy').all(), recoveredPolicy: await f.sdk.call('connection.service.get', {}), retainedIngress: claimed.ingress, receiverEndpointRetained: endpoint === f.wire.endpoint, publicationLaneRetained: (f.services.publication as unknown as { lanes: Map<string, unknown> }).lanes.get(f.binding.bindingId) === originalLane })
}, 30_000)

it('releases a newly opened receiver when its post-open service read is unknown, without leaking a second network owner on recovery', async () => {
  const f = await fixture(), start = f.wire.adapter.transport!.start.bind(f.wire.adapter.transport), prepare = f.services.database!.prepare.bind(f.services.database!)
  let opened = 0, released = 0, readFault: { mockRestore(): void } | undefined
  vi.spyOn(f.wire.adapter.transport!, 'start').mockImplementation(async input => {
    const receiver = await start(input)
    if (++opened === 1) readFault = vi.spyOn(f.services.database!, 'prepare').mockImplementation(sql => {
      if (sql.startsWith('SELECT enabled,revision FROM connection_service_policy')) throw new Error('Post-open policy observation failed')
      return prepare(sql)
    })
    return { close: () => { released++; receiver.close() }, observation: () => receiver.observation() }
  })
  await f.set('receiver-close', 0, false); await f.set('receiver-open', 1, true)
  await vi.waitFor(() => expect(released).toBe(1))
  expect(opened).toBe(1); expect(f.wire.endpoint).toBeUndefined()
  await expect(f.sdk.call('connection.service.get', {})).rejects.toMatchObject({ code: 'CONNECTION_SERVICE_UNCONFIRMED' })
  readFault!.mockRestore()
  await f.set('receiver-observation-restored', 2, true)
  await vi.waitFor(() => expect(f.wire.endpoint).toBeDefined())
  expect(opened).toBe(2); expect(released).toBe(1)
  f.services.close()
  expect(released).toBe(2)
  evidence('post-open-policy-unknown-resource-ownership', { opened, released })
}, 15_000)

it.each(['prepare', 'claim'] as const)('rechecks persisted policy after %s before the first publication effect, preserving the original operation', async phase => {
  const f = await fixture(), turnOff = () => f.services.database!.prepare('INSERT INTO connection_service_policy (singleton,enabled,revision) VALUES (1,0,1) ON CONFLICT(singleton) DO UPDATE SET enabled=0,revision=1').run()
  // Controlled same-transaction/inter-call scheduling injection; owner authority still reads the real persisted policy.
  if (phase === 'prepare') { const prepare = f.wire.adapter.publication!.prepare; f.wire.adapter.publication!.prepare = value => { const result = prepare(value); turnOff(); return result } }
  else { const claim = PublicationStore.prototype.claimNext; vi.spyOn(PublicationStore.prototype, 'claimNext').mockImplementation(function (this: PublicationStore, ...args) { const result = claim.apply(this, args); if (result) turnOff(); return result }) }
  await appendFile(f.transcript, row('publication-race'))
  await vi.waitFor(async () => expect(await f.sdk.call('connection.service.get', {})).toEqual({ enabled: false, revision: 1 }))
  expect(f.wire.effects).toEqual([])
  const original = f.services.publication!.store.list(f.binding)[0]!
  expect(original).toMatchObject({ state: phase === 'prepare' ? 'pending' : 'not-applied' })
  if (phase === 'claim') expect(original.attempt).toBe(1)
  vi.restoreAllMocks()
  if (phase === 'prepare') { const prepare = signedRoomAdapter().adapter.publication!.prepare; f.wire.adapter.publication!.prepare = prepare }
  await f.set('publication-race-on', 1, true)
  if (phase === 'claim') { expect(f.wire.effects).toEqual([]); await f.sdk.call('connection.delivery.retry', { operationId: original.operationId }) }
  await vi.waitFor(() => expect(f.wire.effects).toHaveLength(1))
  expect(f.services.publication!.store.list(f.binding)[0]).toMatchObject({ operationId: original.operationId, state: 'confirmed' })
  evidence('publication-' + phase + '-off', { original, afterExplicitRecovery: f.services.publication!.store.list(f.binding)[0], effects: f.wire.effects })
}, 20_000)

it.each([{ scope: 'global', adapterId: null }, { scope: 'adapter', adapterId: 'signed-room' }])('settles a late authoritative publication ACK while $scope is off and never replays unknown original effects on enable', async selection => {
  const f = await fixture(), complete = deferred<PublicationReceipt>(), dispatch = f.wire.adapter.publication!.dispatch
  const speech = () => f.services.publication!.store.list(f.binding).filter(operation => operation.payload.kind === 'speech')
  const set = (id: string, revision: number, enabled: boolean) => f.sdk.call('connection.service.configure', { ...policy(id, revision, enabled), ...(selection.adapterId === null ? {} : { adapterId: selection.adapterId }) })
  f.wire.adapter.publication!.dispatch = async () => await complete.promise
  await appendFile(f.transcript, row('late-ack'))
  await vi.waitFor(() => expect(speech()[0]?.state).toBe('dispatching'))
  const original = speech()[0]!
  await set('late-ack-off', 0, false)
  complete.resolve({ state: 'confirmed', mapping: { messageId: 'late-original-message' } })
  await vi.waitFor(() => expect(f.services.publication!.store.inspect(original.operationId)).toMatchObject({ state: 'confirmed', attempt: 1, mapping: { messageId: 'late-original-message' } }))
  f.wire.adapter.publication!.inspect = async () => null
  f.wire.adapter.publication!.dispatch = async (...args) => { await dispatch(...args); throw new Error('Unconfirmed original platform ACK') }
  await set('late-ack-on', 1, true); await appendFile(f.transcript, row('unknown-effect'))
  await vi.waitFor(() => expect(speech()[1]?.state).toBe('unknown'))
  const unknown = speech()[1]!
  await set('unknown-off', 2, false); await set('unknown-on', 3, true)
  await vi.waitFor(() => expect(f.services.publication!.observation(f.binding.bindingId, 1)).toEqual({ state: 'unknown', reason: 'effect-unconfirmed' }))
  expect(f.wire.effects).toHaveLength(1); expect(f.services.publication!.store.inspect(unknown.operationId)?.attempt).toBe(1)
  await expect(f.sdk.call('connection.delivery.retry', { operationId: unknown.operationId })).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  evidence('publication-late-ack-and-unknown-' + selection.scope, { originalClaim: original, settledWhileOff: f.services.publication!.store.inspect(original.operationId), originalUnknown: unknown, retainedUnknown: f.services.publication!.store.inspect(unknown.operationId), effects: f.wire.effects })
}, 20_000)

it.each([1, 3, 5])('actual execution Host rechecks current cross-process authority at gate %i, retains the original input and distinguishes wait rejoin from unknown or not-applied receipts', async held => {
  const f = await fixture({ publication: false })
  await f.client.dispose()
  const execution = await child(f.root, 'execution', held), authorityHeld = execution.message('authority-held')
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'semantic.sock') } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); cleanup.push(() => hosted.dispose())
  f.setInputCore(createHostedIngressCorePort(() => [{ hostId: 'local', client: hosted }]))
  expect(await f.wire.post(f.message())).toBe(202)
  await authorityHeld
  const original = (await f.services.ingress!.list({ connectionId: f.config.connectionId })).ingresses[0]!, input = original.input!
  const before = await f.services.ingress!.inspect({ ingressId: original.ingressId })
  expect(before.inputReceipt?.control.state ?? null).toBe(held === 1 ? null : held === 5 ? 'dispatch-authorized' : 'enabled')
  await f.set('execution-off', 0, false); execution.process.send({ kind: 'release-authority' })
  if (held === 3) {
    await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: original.ingressId })).inputReceipt?.control.waiting).toMatchObject({ phase: 'authorization', wake: 'explicit-rejoin', failure: { code: 'INGRESS_SERVICE_DISABLED' } }))
  } else if (held === 5) {
    await vi.waitFor(async () => expect((await f.services.ingress!.inspect({ ingressId: original.ingressId })).inputReceipt?.status).toBe('not-applied'))
  } else await f.services.ingress!.dispatch(original.ingressId)
  await expect(readFile(join(f.root, 'execution-effects'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.sdk.call('connection.ingress.authority', { operationId: input.operationId })).toEqual({ ingress: original, authority: 'refused', code: 'INGRESS_SERVICE_DISABLED' })
  const wait = (await f.services.ingress!.inspect({ ingressId: original.ingressId })).inputReceipt
  if (held === 3) await expect(f.services.ingress!.rejoin(original.ingressId)).rejects.toMatchObject({ code: 'INGRESS_SERVICE_DISABLED' })
  else expect((await f.services.ingress!.rejoin(original.ingressId)).inputReceipt).toEqual(wait)
  expect((await f.services.ingress!.inspect({ ingressId: original.ingressId })).inputReceipt?.ref).toEqual(wait?.ref)
  await f.set('execution-on', 1, true)
  expect((await f.services.ingress!.inspect({ ingressId: original.ingressId })).inputReceipt?.ref).toEqual(wait?.ref)
  await f.services.ingress!.rejoin(original.ingressId)
  if (held === 3) {
    await vi.waitFor(async () => expect((await readFile(join(f.root, 'execution-effects'), 'utf8')).trim().split('\n')).toHaveLength(1))
  } else {
    // No Core receipt or a positively not-applied dispatch is retained read-only, never resubmitted on enable.
    await f.services.ingress!.dispatch(original.ingressId)
    await expect(readFile(join(f.root, 'execution-effects'))).rejects.toMatchObject({ code: 'ENOENT' })
  }
  const after = await f.services.ingress!.inspect({ ingressId: original.ingressId })
  expect(after.ingress?.input).toEqual(input)
  expect(after.inputReceipt?.key).toEqual(wait?.key)
  await f.set('local-input-off', 2, false)
  await hosted.submitAgentPrompt({ agentSessionId: 'original-agent', expectedRun: { runId: 'run-original-agent' }, operationId: 'healthy-local-input', prompt: 'Healthy original local input', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
  await vi.waitFor(async () => expect((await readFile(join(f.root, 'execution-effects'), 'utf8')).trim().split('\n')).toHaveLength(held === 3 ? 2 : 1))
  const effects = (await readFile(join(f.root, 'execution-effects'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(effects.at(-1).data).toContain('Healthy original local input')
  const runs = (await hosted.readAgentSessions()).map(session => [session.agentSessionId, session.run.runId])
  expect(runs).toEqual([['original-agent', 'run-original-agent']])
  evidence('cross-process-core-gate-' + held, { originalIngress: original, before: before.inputReceipt, retainedWhileOff: wait, afterExplicitRecovery: after.inputReceipt, effects, runs })
  execution.process.kill('SIGKILL'); await once(execution.process, 'exit')
}, 30_000)
