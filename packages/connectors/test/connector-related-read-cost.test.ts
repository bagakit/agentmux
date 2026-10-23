import { afterEach, expect, it, vi } from 'vitest'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import * as core from '../../core/dist/index.js'
import { connectHostedAgentMux } from '../../core/dist/hosted.js'
import { AgentMuxHostedRuntimeService } from '../../core/dist/hosted-runtime-service.js'
import { hostedTestOwner } from '../../core/test/helpers/hosted-runtime-port.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import type { AgentMuxAgentSessionRegistry } from '../../core/src/agent-session-registry.js'
import type { AgentMuxStoredAgentSession } from '../../core/src/types.js'
import { createRpcExternalInputAuthority } from './helpers/rpc-external-input-authority.js'
import { DurableIngressHost } from '../dist/index.js'
import { PublicationStore } from '../dist/publication-store.js'
import { createHostedIngressCorePort } from '../src/core-ingress-port.js'
import { ingressFixture } from './fixtures/ingress.js'
import { config, context } from './fixtures/room-binding.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  try {
    for (const close of cleanup.splice(0).reverse()) {
      try { await close() } catch (error) { errors.push(error) }
    }
  } finally {
    try { vi.restoreAllMocks() } catch (error) { errors.push(error) }
    try { vi.unstubAllEnvs() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Related-read fixture cleanup failed.')
})

async function fixture() {
  const f = await ingressFixture(true); cleanup.push(() => f.close())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const businessPath = join(f.root, 'business.sock'), semanticPath = join(f.root, 'semantic.sock')
  const service = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => hostedTestOwner(f.client), undefined,
    createRpcExternalInputAuthority({ socketPath: businessPath, executionHostId: 'local' }))
  cleanup.push(() => service.dispose())
  const business = new core.AgentMuxControlServer({ socketPath: businessPath, connections: f.connections, coreClients: f.coreClients })
  await business.start(); cleanup.push(() => business.stop())
  const semantic = new core.AgentMuxControlServer({ socketPath: semanticPath, hostedRuntime: () => service, coreClients: f.coreClients })
  await semantic.start(); cleanup.push(() => semantic.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: semanticPath } }); cleanup.push(() => rpc.dispose())
  const hosted = await connectHostedAgentMux({ rpc }); cleanup.push(() => hosted.dispose())
  await hosted.connect()
  const ingress = new DurableIngressHost({ ...f.options, core: createHostedIngressCorePort(() => [{ hostId: 'local', client: hosted }]) })
  f.connections.ingress = ingress
  const publicRpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: businessPath } }); cleanup.push(() => publicRpc.dispose())
  const registry = f.inner.registry as unknown as AgentMuxAgentSessionRegistry
  const unrelatedSeed = (await f.store.readMetadata(f.input.agentSessionId))!
  const metrics = {
    inventory: vi.spyOn(f.store, 'loadMetadata'), metadata: vi.spyOn(f.store, 'readMetadata'),
    resume: vi.spyOn(registry, 'readStartedResume'),
    projection: vi.spyOn(f.client as unknown as { projectSession(value: AgentMuxStoredAgentSession): unknown }, 'projectSession')
  }
  const clear = () => { for (const spy of Object.values(metrics)) spy.mockClear() }
  async function growSessions(first: number, count: number) {
    const { nativeHandle: _native, continuity: _continuity, ...seed } = unrelatedSeed
    for (let index = first; index < first + count; index++) await f.store.compareAndSwap(null, {
      ...seed, agentSessionId: `unrelated-session-${index}`, run: { runId: `unrelated-run-${index}` }, retiredRuns: []
    })
  }
  async function readCost() {
    clear()
    const session = await hosted.readAgentSession(f.input.agentSessionId)
    const cost = { inventory: metrics.inventory.mock.calls.length,
      metadata: metrics.metadata.mock.calls.map(args => args[0]),
      resumed: metrics.resume.mock.calls.map(args => args[0].agentSessionId), projections: metrics.projection.mock.calls.length }
    expect(session).toMatchObject({ agentSessionId: f.input.agentSessionId, hostId: 'local', run: f.session.run })
    expect(cost).toEqual({ inventory: 0, metadata: [f.input.agentSessionId], resumed: [f.input.agentSessionId], projections: 1 })
    return cost
  }
  const receive = (suffix: string) => ingress.receive({ connectionId: config.connectionId,
    raw: JSON.stringify({ proof: 'adapter-private-witness', event: f.event({ eventId: `related-event-${suffix}`, messageId: `related-message-${suffix}` }) }) }, vi.fn())
  const cli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + businessPath, ...args], objectCliEnvironment(f.root))
  return { ...f, hosted, rpc, publicRpc, ingress, registry, metrics, clear, growSessions, readCost, receive, cli }
}

it('reads one exact durable Session through Hosted with constant related work as unrelated Sessions grow', async () => {
  const f = await fixture(), costs = [await f.readCost()]
  await f.growSessions(0, 12); costs.push(await f.readCost())
  await f.growSessions(12, 36); costs.push(await f.readCost())
  expect(costs[1]).toEqual(costs[0]); expect(costs[2]).toEqual(costs[0])
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  const directory = resolve('.bagakit/evidence/connector-related-read-cost'); await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'metadata-cost.json'), JSON.stringify({ unrelatedSessions: [0, 12, 48], costs,
    boundary: 'Actual FileStore/Core/Hosted Unix transport. Runtime I/O is controlled; no live Native producer or tenant.' }, null, 2) + '\n')
}, 20_000)

it('reads newer durable facts without adopting them or substituting the older Hosted cache, and keeps absence distinct from failed reading', async () => {
  const f = await fixture(), original = (await f.store.readMetadata(f.input.agentSessionId))!
  const retained = f.hosted.agentSessions(), events: unknown[] = []
  const release = f.hosted.onEvent(event => { if (event.type === 'agent-session') events.push(event) })
  cleanup.push(async () => { release() })
  const next = { ...original, run: { runId: 'newer-durable-run' }, retiredRuns: [...original.retiredRuns, original.run], updatedAt: original.updatedAt + 1 }
  await f.store.compareAndSwap(original, next)
  expect(f.hosted.agentSession(f.input.agentSessionId).run).toEqual(original.run)
  expect((await f.hosted.readAgentSession(f.input.agentSessionId))?.run).toEqual(next.run)
  const remote = createHostedIngressCorePort(() => [{ hostId: 'original-host-route', client: f.hosted }])('original-host-route')!
  expect(await remote.readAgentSession(f.input.agentSessionId)).toMatchObject({ hostId: 'original-host-route', agentSessionId: f.input.agentSessionId, run: next.run })
  expect(f.client.agentSession(f.input.agentSessionId).run).toEqual(original.run)
  expect(await f.hosted.readAgentSession('unknown-exact-session')).toBeNull()
  f.metrics.metadata.mockRejectedValueOnce(new core.AgentMuxError('Original metadata observation is unavailable.', 'AGENT_SESSION_STORE_READ_UNCONFIRMED'))
  await expect(f.hosted.readAgentSession(f.input.agentSessionId)).rejects.toMatchObject({ code: 'AGENT_SESSION_STORE_READ_UNCONFIRMED' })
  expect((await f.hosted.readAgentSession(f.input.agentSessionId))?.run).toEqual(next.run)
  expect(f.hosted.agentSession(f.input.agentSessionId).run).toEqual(original.run)
  expect(f.hosted.agentSessions()).toEqual(retained)
  expect(events).toHaveLength(0)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('keeps only an actual unconfirmed started creation when its durable metadata is absent', async () => {
  const f = await fixture(), original = (await f.store.readMetadata(f.input.agentSessionId))!
  const { nativeHandle: _native, ...seed } = original
  const started = { ...seed, agentSessionId: 'started-unconfirmed-session', run: { runId: 'started-unconfirmed-run' },
    creation: { createOperationId: 'original-creation', intentDigest: 'c'.repeat(64), executorRevision: 'e'.repeat(64),
      initialPrompt: 'unknown' as const, agentMuxContext: 'unknown' as const, persistence: 'unconfirmed' as const } }
  f.registry.rememberStartedCreation(started)
  expect(await f.hosted.readAgentSession(started.agentSessionId)).toMatchObject({ agentSessionId: started.agentSessionId, run: started.run, creation: started.creation })
  const { persistence: _unconfirmed, ...creation } = started.creation
  const committed = { ...started, run: { runId: 'confirmed-durable-run' }, creation }
  await f.store.compareAndSwap(null, committed)
  expect((await f.hosted.readAgentSession(started.agentSessionId))?.run).toEqual(committed.run)
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the original Hosted ingress freezes the same input and public receipt without inventory as unrelated Sessions grow', async () => {
  const f = await fixture(), exact = vi.spyOn(f.client, 'readAgentSession'), inventory = vi.spyOn(f.client, 'readAgentSessions')
  const evidence: unknown[] = []
  for (const suffix of ['before', 'after']) {
    if (suffix === 'after') await f.growSessions(0, 24)
    exact.mockClear(); inventory.mockClear()
    const accepted = await f.receive(suffix), dispatched = await f.ingress.dispatch(accepted.ingress.ingressId), input = dispatched.ingress!.input!
    expect(exact).toHaveBeenCalledWith(f.input.agentSessionId); expect(inventory).not.toHaveBeenCalled()
    expect(input).toMatchObject({ hostId: 'local', agentSessionId: f.input.agentSessionId, expectedRun: f.session.run,
      author: { actor: f.actor, bindingId: f.input.bindingId, bindingRevision: 1 } })
    const sdk = await f.publicRpc.call('connection.ingress.inspect', { ingressId: accepted.ingress.ingressId })
    expect(sdk.ingress!.input).toEqual(input)
    const cli = await f.cli(['connection', 'ingress', 'inspect', '--ingress', accepted.ingress.ingressId])
    expect(cli.code, cli.stdout + cli.stderr).toBe(0)
    const observed = JSON.parse(cli.stdout).result
    expect(observed.ingress.input).toEqual(input); expect(observed.inputReceipt.originalControlOperationId).toBe(input.operationId)
    await f.ingress.dispatch(accepted.ingress.ingressId)
    expect((await f.ingress.inspect({ ingressId: accepted.ingress.ingressId })).ingress!.input).toEqual(input)
    evidence.push({ suffix, input, originalControlOperationId: observed.inputReceipt.originalControlOperationId })
  }
  await vi.waitFor(() => expect(f.inner.kernel.input).toHaveBeenCalledTimes(2))
  expect(f.inner.kernel.attach).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  const directory = resolve('.bagakit/evidence/connector-related-read-cost'); await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'public-ingress.json'), JSON.stringify(evidence, null, 2) + '\n')
}, 20_000)

it('rejects another SID, Host or private metadata reply and extra arguments without claiming or writing input', async () => {
  const f = await fixture()
  const transport = f.rpc as unknown as { call(method: string, params: unknown, options?: unknown): Promise<unknown> }
  const invoke = transport.call.bind(transport)
  const original = (await f.hosted.readAgentSession(f.input.agentSessionId))!
  for (const patch of [{ agentSessionId: 'another-session' }, { hostId: 'another-host' }, { hookToken: 'private-original-token' }]) {
    const intercepted = vi.spyOn(transport, 'call').mockImplementation(async (...args) => {
      const value = await invoke(...args)
      const packet = args[1] as { invocation?: { method: string } }
      if (args[0] === 'runtime.invoke' && packet.invocation?.method === 'readAgentSession') return { value: { ...original, ...patch } }
      return value
    })
    const accepted = await f.receive(Object.keys(patch)[0]!)
    const rejected = await f.ingress.dispatch(accepted.ingress.ingressId).then(() => null, error => error)
    expect(rejected).toMatchObject({ code: patch.hostId ? 'INGRESS_TARGET_UNCONFIRMED' : 'CONTROL_PROTOCOL_ERROR' })
    expect((await f.ingress.inspect({ ingressId: accepted.ingress.ingressId })).ingress).toMatchObject({ state: 'received' })
    intercepted.mockRestore()
  }
  const owner = f.hosted.runtimeOwnerIdentity()!
  await expect(f.rpc.call('runtime.invoke', { consumerId: 'exact-reader-scope', fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId },
    invocation: { method: 'readAgentSession', args: [f.input.agentSessionId, { adopt: true }] } } as never)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it('the original grant and permission projection queries use related audience keys while preserving revisions and revocation', async () => {
  const f = await fixture(), database = f.connections.database, prepare = database.prepare.bind(database)
  const granted = await f.bindings.grant({ ...f.grant, operationId: 'grant-permission', expectedRevision: 1, capabilities: ['input', 'permission'] }, context)
  expect(granted.state).toBe('applied')
  const plans: Array<{ sql: string; parameters: unknown[]; details: string[] }> = []
  vi.spyOn(database, 'prepare').mockImplementation(sql => {
    const statement = prepare(sql)
    if (/^SELECT grant_id FROM room_grant_head WHERE /u.test(sql)) {
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
        plans.push({ sql, parameters, details: prepare('EXPLAIN QUERY PLAN ' + sql).all(...parameters).map(row => String(row.detail)) })
        return all(...parameters)
      })
    }
    return statement
  })
  async function projection() {
    plans.length = 0
    const binding = f.bindings.readCurrent(f.input.bindingId)!
    const grants = f.bindings.grants(binding.bindingId, binding.revision)
    f.ingress.permissions.project(binding, new PublicationStore(database))
    expect(grants).toHaveLength(1); expect(grants[0]!.revision).toBe(2)
    expect(plans.length).toBeGreaterThanOrEqual(2)
    for (const plan of plans) {
      expect(plan.details.join(' ')).toMatch(/SEARCH room_grant_head .*connection_id=\? AND room_id=\?/u)
      expect(plan.details.join(' ')).not.toMatch(/SCAN room_grant_head/u)
    }
    return { grants, plans: structuredClone(plans) }
  }
  const before = await projection()
  for (let index = 0; index < 24; index++) {
    const connectionId = `unrelated-connection-${index}`, bindingId = `unrelated-binding-${index}`, externalConversationId = `unrelated-room-${index}`
    await f.connections.configure({ operationId: `configure-${index}`, expectedRevision: null, connection: { ...config, connectionId } })
    expect(await f.bindings.bind({ ...f.input, operationId: `bind-${index}`, bindingId, connectionId, externalConversationId }, context)).toMatchObject({ state: 'applied' })
    expect(await f.bindings.grant({ ...f.grant, operationId: `grant-${index}`, bindingId, grantId: `unrelated-grant-${index}` }, context)).toMatchObject({ state: 'applied' })
  }
  const after = await projection(); expect(after.grants).toEqual(before.grants)
  expect(after.plans).toEqual(before.plans)
  const revoked = await f.bindings.grant({ ...f.grant, operationId: 'revoke-related', expectedRevision: 2, state: 'revoked' }, context)
  expect(revoked).toMatchObject({ state: 'applied', grant: { revision: 3, state: 'revoked' } })
  expect((await f.bindings.inspect({ bindingId: f.input.bindingId, revision: 1 })).grants).toMatchObject([{ revision: 3, state: 'revoked' }])
  expect(f.bindings.readGrant(f.grant.grantId, 2)).toEqual(before.grants[0])
  expect((await f.bindings.inspect({ operationId: 'grant-permission' })).operation).toEqual(granted)
  const directory = resolve('.bagakit/evidence/connector-related-read-cost'); await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'grant-query-plans.json'), JSON.stringify({ unrelatedGrants: [0, 24], before, after }, null, 2) + '\n')
})
