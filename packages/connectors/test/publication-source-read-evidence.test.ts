import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, afterEach, expect, it, vi } from 'vitest'
import * as core from '../../core/src/index.js'
import { connectionDiagnosisCheckpointKey, parseConnectionResult } from '../../core/src/connections.js'
import type { ConversationChangesInput, ConversationChangesPage } from '../../core/src/conversation.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const closes: Array<() => unknown | Promise<unknown>> = [], facts: unknown[] = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
afterAll(async () => { if (process.env.SOURCE_READ_EVIDENCE_FACTS) await writeFile(process.env.SOURCE_READ_EVIDENCE_FACTS, JSON.stringify(facts, null, 2) + '\n') })
const row = (id: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: id }] } }) + '\n'
const deferred = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve }); closes.push(() => done()); return { promise, done } }

async function fixture() {
  const f = await ingressFixture(false); closes.push(f.close)
  const client = f.client as core.AgentMuxClient
  const original = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(null, { ...original, agentSessionId: 'foreign-agent', run: { runId: 'foreign-run' }, nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'foreign-native' } })
  await f.inner.registry.load('local')
  const port = createPublicationConversationPort(f.coreClients), realChanges = port.changes.bind(port), realObserve = port.observe.bind(port)
  const watches: Awaited<ReturnType<typeof port.observe>>[] = []
  vi.spyOn(port, 'observe').mockImplementation(async (...args) => { const handle = await realObserve(...args); watches.push(handle); return handle })
  let intercept: ((input: ConversationChangesInput, signal: AbortSignal) => Promise<ConversationChangesPage>) | undefined
  const changes = vi.spyOn(port, 'changes').mockImplementation((input, signal) => intercept ? intercept(input, signal) : realChanges(input, signal))
  const sends: string[] = []
  const services = await createConnectionServices({ directory: join(f.root, 'evidence'),
    adapters: [{ adapterId: 'sample', test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }), publication: { adapterId: 'sample', renderVersion: 'evidence-v1', supportedRenderVersions: ['evidence-v1'], fragmentBytes: 8192,
      prepare: operation => ({ adapterId: 'sample', renderVersion: 'evidence-v1', requestKey: operation.operationId, request: { method: 'POST', path: '/messages', body: '{}' } }),
      dispatch: async prepared => { sends.push(prepared.requestKey); return { state: 'unknown', reason: 'effect-unconfirmed' } } } }],
    bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref), session: async ref => ref.hostId === 'local' ? f.client.agentSession(ref.agentSessionId) : null }, publication: port })
  closes.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'evidence-secret', secret: 'private-fixture' })
  await services.connections.configure({ operationId: 'evidence-config', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind(f.input, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Exact fixture Binding required')
  const binding = bound.binding, host = services.publication!, input = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  const idle = async () => vi.waitFor(() => expect((Reflect.get(host, 'lanes') as Map<string, { work?: unknown }>).get(binding.bindingId)?.work).toBeUndefined())
  await vi.waitFor(async () => expect((await host.list(input)).sourceObservation?.state).toBe('ready')); await idle()
  const runtime = new core.AgentMuxHostedRuntimeService(client, null, () => ({ runtimeId: 'evidence-runtime', ownerInstanceId: 'evidence-owner', protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null })); closes.push(() => runtime.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'evidence.sock'), connections: services.connections, coreClients: f.coreClients, hostedRuntime: () => runtime }); await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: f.credentials }); closes.push(() => rpc.dispose())
  const user = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => user.dispose())
  const foreign = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: { ...f.credentials, agentSessionId: 'foreign-agent' } }); closes.push(() => foreign.dispose())
  const hosted = await core.connectHostedAgentMux({ rpc: user, waitForReady: false, forwardRpc: (method, params, call = {}) => user.call(method, params, { ...(call.runtimeFence ? { runtimeFence: call.runtimeFence } : {}), ...(call.signal ? { signal: call.signal } : {}) }) }); closes.push(() => hosted.dispose())
  const cli = async (args: string[], data?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.credentials.capability }), data === undefined ? '' : JSON.stringify(data))
    expect(result.code, result.stdout + result.stderr).toBe(0); return args.includes('--help') || args.includes('--skill') ? { help: result.stdout } : JSON.parse(result.stdout).result
  }
  const listArgs = ['connection', 'delivery', 'ls', '--connection', input.connectionId, '--binding', input.bindingId, '--binding-revision', String(input.bindingRevision)]
  return { ...f, client, bindInput: f.input, services, binding, host, input, idle, watches, changes, realChanges, sends, rpc, user, foreign, hosted, cli, listArgs,
    intercept(value: typeof intercept) { intercept = value } }
}

it('public SDK Hosted and compiled CLI preserve the observed source cut while the durable frontier advances', async () => {
  const f = await fixture(), input = { ...f.input, includeSourceReadEvidence: true }
  await appendFile(f.transcript, row('original-unknown-effect')); f.host.refresh()
  await vi.waitFor(() => expect(f.sends.length).toBe(1)); await f.idle()
  const originalEffects = structuredClone(f.host.store.list(f.binding))
  f.intercept(async () => { throw new core.AgentMuxError('Controlled whole-read failure', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED') }); f.host.refresh()
  await vi.waitFor(async () => expect((await f.host.list(f.input)).sourceObservation?.code).toBe('AGENT_SESSION_HISTORY_SOURCE_CHANGED')); await f.idle()
  const a = (await f.rpc.call('connection.delivery.ls', input)).sourceReadEvidence!
  expect(a.checkpoint, 'Original source failure must expose its exact observed checkpoint').not.toBeNull()
  expect(connectionDiagnosisCheckpointKey(a.checkpoint!)).toBe(a.observation!.checkpointKey)
  const gate = deferred(), entered = deferred(); let first = true
  f.intercept(async (request, signal) => {
    if (first) { first = false; return f.realChanges({ ...request, limit: 1 }, signal) }
    entered.done(); await gate.promise; throw new core.AgentMuxError('Controlled observer release', 'AGENT_SESSION_HISTORY_CANCELLED')
  })
  await appendFile(f.transcript, row('new-first') + row('new-second')); f.host.refresh(); await entered.promise
  const b = f.host.store.retainedCheckpoint(f.binding)!
  expect(connectionDiagnosisCheckpointKey(b), 'The real owner must have committed B while its next read is pending').not.toBe(a.observation!.checkpointKey)
  const reads = f.changes.mock.calls.length, effects = f.sends.length
  const sdk = await f.rpc.call('connection.delivery.ls', input)
  expect(sdk.sourceReadEvidence, 'Evidence must retain observation A with its original cut, never the newer Store frontier B').toEqual(a)
  expect((await f.hosted.forwardRpc!('connection.delivery.ls', input)).sourceReadEvidence).toEqual(a)
  const compiled = await f.cli([...f.listArgs, '--source-read-evidence'])
  expect(compiled.sourceReadEvidence, 'The actual compiled list command must request and preserve the original paired source evidence').toEqual(a)
  expect((await f.rpc.call('connection.delivery.ls', f.input)).sourceReadEvidence).toBeUndefined()
  expect((await f.rpc.call('connection.delivery.ls', { ...f.input, includeSourceReadEvidence: false })).sourceReadEvidence).toBeUndefined()
  expect(f.changes.mock.calls).toHaveLength(reads); expect(f.sends).toHaveLength(effects)
  await expect(f.foreign.call('connection.delivery.ls', input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const diagnosis = await f.foreign.call('connection.diagnose', { executionHostId: 'local', agentSessionId: f.session.agentSessionId })
  expect(JSON.stringify(diagnosis)).not.toContain('sourceReadEvidence'); expect(JSON.stringify(diagnosis)).not.toContain('frontier')
  const wrongRoute = structuredClone(sdk), wrongCheckpoint = wrongRoute.sourceReadEvidence!.checkpoint!
  wrongCheckpoint.sourceHostId = 'foreign-source-namespace'; wrongCheckpoint.frontier.hostId = 'foreign-source-namespace'
  const wrongObservation = { ...wrongRoute.sourceReadEvidence!.observation!, checkpointKey: connectionDiagnosisCheckpointKey(wrongCheckpoint) }
  wrongRoute.sourceObservation = wrongObservation; wrongRoute.sourceReadEvidence!.observation = wrongObservation
  expect(parseConnectionResult('connection.delivery.ls', wrongRoute, input).sourceReadEvidence).toEqual(wrongRoute.sourceReadEvidence)
  const list = vi.spyOn(f.services.connections.delivery!, 'list').mockResolvedValueOnce(wrongRoute)
  await expect(f.rpc.call('connection.delivery.ls', input)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  list.mockRestore()
  expect((await f.rpc.call('connection.delivery.ls', input)).sourceReadEvidence).toEqual(a)
  const mutated = structuredClone(sdk); mutated.sourceReadEvidence!.checkpoint = b
  expect(() => parseConnectionResult('connection.delivery.ls', mutated, input)).toThrow()
  expect(() => parseConnectionResult('connection.delivery.ls', sdk, f.input)).toThrow()
  sdk.sourceReadEvidence!.checkpoint!.frontier = { ...sdk.sourceReadEvidence!.checkpoint!.frontier, cuts: [] }
  expect((await f.host.list(input)).sourceReadEvidence).toEqual(a)
  const query = { hostId: 'local', agentSessionId: f.session.agentSessionId, checkpoint: a.checkpoint!, limit: 1 }
  const native = await f.cli(['agent', 'conversation', 'changes', '--input', '-'], query)
  expect(native.coverage.find((value: { source: { kind: string } }) => value.source.kind === 'native').current).not.toBe('unavailable')
  expect(f.host.store.list(f.binding).filter(value => originalEffects.some(original => original.operationId === value.operationId))).toEqual(originalEffects)
  const revised = await f.services.connections.bindings!.relink({ ...f.bindInput, operationId: 'evidence-trigger-only', expectedRevision: f.binding.revision,
    scope: { ...f.bindInput.scope, input: 'all-messages' } }, context)
  expect(revised.state).toBe('applied'); if (revised.state !== 'applied') throw Error('Original trigger revision required')
  expect(revised.binding.publicationBoundary).toMatchObject({ revision: f.binding.revision })
  expect((await f.rpc.call('connection.delivery.ls', { ...input, bindingRevision: revised.binding.revision })).sourceReadEvidence).toEqual({ observation: null, checkpoint: null })
  expect((await f.rpc.call('connection.delivery.ls', input)).sourceReadEvidence).toEqual(a)
  expect((await f.cli(['connection', 'delivery', 'ls', '--help'])).help).toContain('--source-read-evidence')
  expect((await f.cli(['connection', '--skill'])).help).toContain('opaque checkpoint')
  facts.push({ case: 'original pair through SDK Hosted compiled CLI', observationA: a, frontierB: b, compiled, nativeCoverage: native.coverage, sourceReadsDuringEvidenceQueries: f.changes.mock.calls.length - reads, originalEffects })
  gate.done()
})

it('page-native failure and unrecorded observations keep the original paired cut or explicit null', async () => {
  const f = await fixture(), input = { ...f.input, includeSourceReadEvidence: true }
  const reader = f.client as unknown as { nativeHistoryChangesPage(...args: unknown[]): Promise<unknown> }
  const unavailable = vi.spyOn(reader, 'nativeHistoryChangesPage').mockRejectedValue(new core.AgentMuxError('Controlled native primitive failure', 'AGENT_SESSION_HISTORY_BUSY'))
  f.host.refresh()
  await vi.waitFor(async () => expect((await f.host.list(f.input)).sourceObservation?.code).toBe('AGENT_SESSION_HISTORY_BUSY')); await f.idle()
  const pageFailure = await f.rpc.call('connection.delivery.ls', input)
  expect(pageFailure.sourceReadEvidence!.observation).toEqual(pageFailure.sourceObservation)
  expect(pageFailure.sourceReadEvidence!.checkpoint, 'A page-native failure still has the accepted original composite cut').toEqual(f.host.store.retainedCheckpoint(f.binding))
  expect(connectionDiagnosisCheckpointKey(pageFailure.sourceReadEvidence!.checkpoint!)).toBe(pageFailure.sourceObservation!.checkpointKey)
  unavailable.mockRestore()
  f.watches.at(-1)!.dispose()
  await vi.waitFor(async () => expect((await f.host.list(input)).sourceReadEvidence?.checkpoint).toBeNull())
  const unpaired = await f.rpc.call('connection.delivery.ls', input)
  expect(unpaired.sourceReadEvidence!.observation).not.toBeNull()
  expect(unpaired.sourceReadEvidence!.checkpoint).toBeNull()
  f.host.close()
  const missing = await f.rpc.call('connection.delivery.ls', input)
  expect(missing.sourceReadEvidence).toEqual({ observation: null, checkpoint: null })
  facts.push({ case: 'native coverage failure and no live observation', pageFailure, unpaired, missing })
})
