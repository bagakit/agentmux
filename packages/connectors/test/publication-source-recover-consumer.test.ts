import { appendFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '../../core/src/index.js'
import { parseConnectionParams, parseConnectionResult } from '../../core/src/connections.js'
import { createConnectionServices } from '../src/connection-services.js'
import { createPublicationConversationPort } from '../src/core-conversation-port.js'
import type { PublicationAdapter } from '../src/publication-adapter.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const native = (id: string, text: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
const deferred = () => { let done!: () => void; const promise = new Promise<void>(resolve => { done = resolve }); cleanup.push(() => done()); return { promise, done } }

async function fixture() {
  const f = await ingressFixture(false, config, undefined, { publication: 'future-shared-conversation' }); cleanup.push(f.close)
  const dispatched: Array<{ key: string; room: string; text: string }> = []
  const adapter: PublicationAdapter = { adapterId: 'sample', renderVersion: 'source-recover-v1', supportedRenderVersions: ['source-recover-v1'], fragmentBytes: 8192,
    prepare: operation => ({ adapterId: 'sample', renderVersion: 'source-recover-v1', requestKey: operation.operationId,
      request: { method: 'POST', path: '/messages', body: JSON.stringify({ text: operation.payload.kind === 'speech' ? operation.payload.text : null }) } }),
    dispatch: async (prepared, target) => {
      const text = JSON.parse(prepared.request.body!).text
      if (text !== null) dispatched.push({ key: prepared.requestKey, room: target.externalConversationId, text })
      return text === 'Original unknown effect' ? { state: 'unknown', reason: 'effect-unconfirmed' }
        : { state: 'confirmed', mapping: { messageId: 'message-' + prepared.requestKey } }
    } }
  const port = createPublicationConversationPort(f.coreClients), changes = port.changes.bind(port), observe = port.observe.bind(port)
  const reads: Array<{ session: string; checkpoint: unknown }> = [], watches: Array<{ session: string; close(): void; closed: AbortSignal }> = []
  let busy = false, hold: ReturnType<typeof deferred> | undefined
  port.changes = async (input, signal) => {
    reads.push({ session: input.agentSessionId, checkpoint: structuredClone(input.checkpoint) })
    if (busy && input.agentSessionId === f.session.agentSessionId) throw new core.AgentMuxError('Controlled transient source capacity', 'AGENT_SESSION_HISTORY_BUSY')
    if (hold && input.agentSessionId === f.session.agentSessionId) await hold.promise
    return await changes(input, signal)
  }
  port.observe = async (...args) => {
    const handle = await observe(...args), closed = new AbortController()
    handle.closed.addEventListener('abort', () => closed.abort(), { once: true })
    const close = () => { closed.abort(); handle.dispose() }
    watches.push({ session: args[0].agentSessionId, close, closed: closed.signal })
    return { ...handle, closed: closed.signal, dispose: close }
  }
  const services = await createConnectionServices({ directory: join(f.root, 'source-recovery'),
    adapters: [{ adapterId: 'sample', publication: adapter, test: async () => ({ authentication: { state: 'ready' }, transport: { state: 'ready' }, intake: { state: 'unknown', reason: 'not-started' }, delivery: { state: 'unknown', reason: 'not-started' } }) }],
    bindings: { spatial: f.spatial, checkpoint: ref => f.client.conversationCheckpoint(ref), session: async ref => ref.hostId === 'local' ? f.client.agentSession(ref.agentSessionId) : null }, publication: port })
  cleanup.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'source-credential', secret: 'private-source-credential' })
  await services.connections.configure({ operationId: 'source-configure', expectedRevision: null, connection: { ...config, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind(f.input, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Original publication Binding required')
  const binding = bound.binding, host = services.publication!, input = { connectionId: binding.connectionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  const otherTranscript = join(f.root, 'unrelated-native.jsonl')
  await writeFile(otherTranscript, JSON.stringify({ sessionId: 'unrelated-native', uuid: 'other-before-binding', type: 'user', message: { role: 'user', content: 'Independent source beginning' } }) + '\n')
  const originalRecord = (await f.store.load()).find(record => record.agentSessionId === f.session.agentSessionId)!
  await f.store.compareAndSwap(null, { ...originalRecord, agentSessionId: 'unrelated-agent', run: { runId: 'run-unrelated-agent' },
    capabilityHash: core.hashAgentCapability(core.issueAgentCapability()), nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'unrelated-native', transcriptPath: otherTranscript } })
  await f.inner.registry.load('local')
  await services.connections.configure({ operationId: 'other-configuration', expectedRevision: null, connection: { ...config, connectionId: 'unrelated-connection', credentialRef: credential.credentialRef } })
  const { regionAnchor: _anchor, ...withoutAnchor } = f.input
  const other = await services.connections.bindings!.bind({ ...withoutAnchor, operationId: 'other-bind', bindingId: 'unrelated-binding', connectionId: 'unrelated-connection', agentSessionId: 'unrelated-agent',
    externalConversationId: 'unrelated-room', expectedSource: { providerId: 'claude', nativeSessionId: 'unrelated-native' } }, context)
  expect(other.state, JSON.stringify(other)).toBe('applied'); if (other.state !== 'applied') throw Error('Independent source Binding required')
  const otherInput = { connectionId: other.binding.connectionId, bindingId: other.binding.bindingId, bindingRevision: other.binding.revision }
  await vi.waitFor(async () => expect((await host.list(otherInput)).sourceObservation?.state).toBe('ready'), { timeout: 8000 })

  await vi.waitFor(async () => expect((await host.list(input)).sourceObservation?.state).toBe('ready'), { timeout: 8000 })
  await vi.waitFor(() => expect((Reflect.get(host, 'lanes') as Map<string, { work?: unknown }>).get(binding.bindingId)?.work).toBeUndefined())
  let ownerInstanceId = 'source-owner'
  const runtime = new core.AgentMuxHostedRuntimeService(f.client, null, () => ({ runtimeId: 'source-runtime', ownerInstanceId, protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null })); cleanup.push(() => runtime.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(f.root, 'source.sock'), connections: services.connections, coreClients: f.coreClients, hostedRuntime: () => runtime }); await server.start(); cleanup.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: f.credentials }); cleanup.push(() => rpc.dispose())
  const user = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => user.dispose())
  const hosted = await core.connectHostedAgentMux({ rpc: user, waitForReady: false,
    forwardRpc: (method, params, call = {}) => user.call(method, params, { ...(call.runtimeFence ? { runtimeFence: call.runtimeFence } : {}), ...(call.signal ? { signal: call.signal } : {}) }) }); cleanup.push(() => hosted.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve('packages/core/bin/amux'))
  const cli = async (request = input) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'source', 'recover', '--connection', request.connectionId, '--binding', request.bindingId, '--binding-revision', String(request.bindingRevision)],
      objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: f.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.credentials.capability }))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  const operations = () => host.store.list(binding).filter(op => op.payload.kind === 'speech')
  return { ...f, bindInput: f.input, services, host, binding, input, otherInput, rpc, user, hosted, cli, dispatched, reads, watches, operations,
    setBusy(value: boolean) { busy = value }, hold() { hold = deferred(); return hold }, release() { hold?.done(); hold = undefined },
    closeWatch() { watches.filter(watch => watch.session === f.session.agentSessionId).at(-1)!.close() },
    replaceRuntime() { ownerInstanceId = 'replaced-source-owner' } }
}

it('existing automatic source recovery retries transient BUSY from the original cut without replaying an unknown effect', async () => {
  const f = await fixture()
  await appendFile(f.transcript, native('source-unknown', 'Original unknown effect')); f.host.refresh()
  await vi.waitFor(() => expect(f.operations()[0]?.state).toBe('unknown'))
  await vi.waitFor(() => expect((Reflect.get(f.host, 'lanes') as Map<string, { work?: unknown }>).get(f.binding.bindingId)?.work).toBeUndefined())
  const old = structuredClone(f.operations()[0]!), cut = f.host.store.retainedCheckpoint(f.binding)
  f.setBusy(true)
  await appendFile(f.transcript, native('source-after-busy', 'Reply after source capacity recovers')); f.host.refresh()
  await vi.waitFor(async () => expect((await f.host.list(f.input)).sourceObservation).toMatchObject({ state: 'unavailable', code: 'AGENT_SESSION_HISTORY_BUSY' }))
  expect((await f.services.connections.bindings!.inspect({ bindingId: f.binding.bindingId, revision: f.binding.revision })).binding?.sourceFrontier).toEqual(f.binding.sourceFrontier)
  expect(f.reads.filter(read => read.session === f.session.agentSessionId).at(-1)!.checkpoint).toEqual(cut)
  f.setBusy(false) // No explicit wake, source append or refresh after the fault clears.
  await vi.waitFor(() => expect(f.operations().some(op => op.payload.kind === 'speech' && op.payload.text === 'Reply after source capacity recovers' && op.state === 'confirmed')).toBe(true), { timeout: 8000 })
  expect((await f.host.list(f.input)).sourceObservation?.state).toBe('ready')
  expect(f.host.store.inspect(old.operationId)).toEqual(old)
  expect(f.dispatched.filter(value => value.key === old.operationId)).toHaveLength(1)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)

it('public SDK Hosted and compiled CLI wake or join only the original publication scope across trigger revisions and lost replies', async () => {
  const f = await fixture(); clearInterval(Reflect.get(f.host, 'timer')) // Automatic retry is proved independently above.
  await appendFile(f.transcript, native('original-unknown', 'Original unknown effect')); f.host.refresh()
  await vi.waitFor(() => expect(f.operations()[0]?.state).toBe('unknown'))
  await vi.waitFor(() => expect((Reflect.get(f.host, 'lanes') as Map<string, { work?: unknown }>).get(f.binding.bindingId)?.work).toBeUndefined())
  await vi.waitFor(() => expect((Reflect.get(f.host, 'lanes') as Map<string, { work?: unknown }>).get(f.binding.bindingId)?.work).toBeUndefined())
  const old = structuredClone(f.operations()[0]!), cut = f.host.store.retainedCheckpoint(f.binding)
  f.closeWatch(); const held = f.hold(), before = f.reads.length, otherReads = f.reads.filter(read => read.session === 'unrelated-agent').length
  const broadRefresh = vi.spyOn(f.host, 'refresh')
  await appendFile(f.transcript, native('closed-watch-reply', 'Reply recovered by explicit original wake'))
  const recover = f.host.recoverSource.bind(f.host); let accepted: Awaited<ReturnType<typeof recover>> | undefined
  vi.spyOn(f.host, 'recoverSource').mockImplementationOnce(async (...args) => { accepted = await recover(...args); throw new core.AgentMuxError('Controlled reply lost after accepted wake', 'CONTROL_DISCONNECTED') })
  await expect(f.rpc.call('connection.delivery.source.recover', f.input)).rejects.toMatchObject({ code: 'CONTROL_DISCONNECTED' })
  expect(accepted?.disposition).toBe('requested')
  await vi.waitFor(() => expect(f.reads.length, 'accepted public source recovery must actually read the original source').toBe(before + 1))
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(cut)
  const lane = (Reflect.get(f.host, 'lanes') as Map<string, { work?: unknown; dirty: boolean; abort: AbortController; binding: { revision: number } }>).get(f.binding.bindingId)!
  expect(lane.dirty).toBe(false)
  const joined = await Promise.all([f.rpc.call('connection.delivery.source.recover', f.input), f.hosted.forwardRpc!('connection.delivery.source.recover', f.input), f.cli()])
  expect(joined.map(value => value.disposition)).toEqual(['joined', 'joined', 'joined'])
  expect(lane.dirty, 'joining original work must not queue another cycle').toBe(false)
  expect(f.reads).toHaveLength(before + 1)
  expect(f.reads.filter(read => read.session === 'unrelated-agent')).toHaveLength(otherReads)
  expect(broadRefresh).not.toHaveBeenCalled()
  await expect(f.rpc.call('connection.delivery.source.recover', f.otherInput)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  held.done(); f.release()
  await vi.waitFor(() => expect(f.operations().some(op => op.payload.kind === 'speech' && op.payload.text === 'Reply recovered by explicit original wake' && op.state === 'confirmed')).toBe(true))
  await vi.waitFor(() => expect(lane.work).toBeUndefined())
  expect(f.reads.filter(read => read.session === 'unrelated-agent')).toHaveLength(otherReads)
  expect(f.reads.slice(before).every(read => read.session === f.session.agentSessionId)).toBe(true)
  expect(f.watches.length).toBeGreaterThanOrEqual(2)
  expect(f.host.store.inspect(old.operationId)).toEqual(old); expect(f.dispatched.filter(value => value.key === old.operationId)).toHaveLength(1)

  const aliasCut = f.host.store.retainedCheckpoint(f.binding)
  f.closeWatch(); const heldAlias = f.hold()
  const relinked = await f.services.connections.bindings!.relink({ ...f.bindInput, operationId: 'source-trigger-only', bindingId: f.binding.bindingId, expectedRevision: f.binding.revision,
    scope: { ...f.bindInput.scope, input: 'all-messages' } }, context)
  expect(relinked.state).toBe('applied'); if (relinked.state !== 'applied') throw Error('Current trigger revision required')
  expect(relinked.binding.publicationBoundary).toEqual({ revision: f.binding.revision })
  const currentInput = { ...f.input, bindingRevision: relinked.binding.revision }, originalLane = (Reflect.get(f.host, 'lanes') as Map<string, typeof lane>).get(f.binding.bindingId)!
  await vi.waitFor(() => expect(originalLane.work).toBeDefined())
  const alias = await f.rpc.call('connection.delivery.source.recover', currentInput)
  expect(alias.disposition, 'current trigger revision must join its original publicationBoundary').toBe('joined')
  expect((Reflect.get(f.host, 'lanes') as Map<string, typeof lane>).get(f.binding.bindingId)).toBe(originalLane)
  expect(originalLane.binding.revision).toBe(f.binding.revision); expect(originalLane.abort.signal.aborted).toBe(false)
  expect(f.host.store.retainedCheckpoint(f.binding)).toEqual(aliasCut)
  heldAlias.done(); f.release(); await vi.waitFor(() => expect(originalLane.work).toBeUndefined())

  const options = Reflect.get(f.host, 'options'), authority = options.bindings.publicationAuthority.bind(options.bindings)
  vi.spyOn(options.bindings, 'publicationAuthority').mockImplementationOnce(() => { throw Error('PRIVATE storage unavailable') })
  await expect(f.rpc.call('connection.delivery.source.recover', currentInput)).rejects.toMatchObject({ code: 'PUBLICATION_STORAGE_UNCONFIRMED' })
  expect(originalLane.abort.signal.aborted).toBe(false)
  await expect(f.rpc.call('connection.delivery.source.recover', { ...currentInput, connectionId: 'foreign-connection' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(authority(f.binding.bindingId, f.binding.revision).authorized).toBe(true)
  await expect(f.user.call('connection.delivery.source.recover', currentInput, { runtimeFence: { runtimeId: 'foreign-runtime', ownerInstanceId: 'source-owner' } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  expect(originalLane.abort.signal.aborted).toBe(false)
  const paused = await f.services.connections.bindings!.pause({ operationId: 'source-pause', bindingId: f.binding.bindingId, expectedRevision: relinked.binding.revision }, context)
  expect(paused.state).toBe('applied')
  expect(await f.rpc.call('connection.delivery.source.recover', currentInput)).toEqual({ disposition: 'disabled', observation: { state: 'disabled' } })
  if (paused.state !== 'applied') throw Error('Known paused original required')
  const successor = await f.services.connections.bindings!.relink({ ...f.bindInput, operationId: 'different-source-scope', expectedRevision: paused.binding.revision,
    externalConversationId: 'successor-room', scope: { ...f.bindInput.scope, input: 'all-messages' } }, context)
  expect(successor.state).toBe('applied'); if (successor.state !== 'applied') throw Error('Different successor scope required')
  const successorLane = (Reflect.get(f.host, 'lanes') as Map<string, typeof lane>).get(f.binding.bindingId)!
  expect(successorLane.binding.revision).toBe(successor.binding.revision)
  broadRefresh.mockClear()
  expect(await f.rpc.call('connection.delivery.source.recover', currentInput)).toEqual({ disposition: 'disabled', observation: { state: 'disabled' } })
  expect((Reflect.get(f.host, 'lanes') as Map<string, typeof lane>).get(f.binding.bindingId)).toBe(successorLane)
  expect(successorLane.abort.signal.aborted).toBe(false); expect(broadRefresh).not.toHaveBeenCalled()

  expect(f.host.store.inspect(old.operationId)).toEqual(old)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30_000)


it('source recovery strict codec preserves finite observations and rejects coerced dispositions or extra authority', () => {
  const method = 'connection.delivery.source.recover' as const, input = { connectionId: 'connection', bindingId: 'binding', bindingRevision: 2 }
  expect(parseConnectionParams(method, input)).toEqual(input)
  const result = { disposition: 'joined' as const, observation: { state: 'unavailable' as const, reason: 'source-gap' as const },
    sourceObservation: { state: 'unavailable' as const, reason: 'source-gap' as const, code: 'AGENT_SESSION_HISTORY_BUSY' as const, codeRecorded: true, checkpointKey: null } }
  expect(parseConnectionResult(method, result, input)).toEqual(result)
  for (const disposition of [['joined'], {}, 'ready', undefined]) expect(() => parseConnectionResult(method, { ...result, disposition }, input)).toThrow()
  for (const extra of [{ cursor: 'not-authority' }, { sourceKey: 'not-authority' }, { operationId: 'not-required' }]) expect(() => parseConnectionParams(method, { ...input, ...extra })).toThrow()
  expect(() => parseConnectionResult(method, { ...result, private: 'discard me' }, input)).toThrow()
})
