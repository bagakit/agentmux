import { afterEach, expect, test, vi } from 'vitest'
import { access, readFile } from 'node:fs/promises'
import { createSpaceSessionsFixture } from './helpers/space-session-fixture.js'
import { createNameControlClient } from '../src/name-control-client.js'
import { parseNameControlParams, parseNameControlResult, memberAgentNameInput } from '../src/name-control.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const fault = vi.hoisted(() => ({ path: undefined as string | undefined }))
vi.mock('../src/durable-write.js', async originalModule => {
  const original = await originalModule<typeof import('../src/durable-write.js')>()
  return { ...original, durableWriteFile: async (...args: Parameters<typeof original.durableWriteFile>) => {
    await original.durableWriteFile(...args)
    if (String(args[0]) === fault.path) { fault.path = undefined; throw new original.DurableWriteError(String(args[0]), 'after-replace', new Error('Private exact name directory ACK failed')) }
  } }
})
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { fault.path = undefined; for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function member() {
  const f = await createSpaceSessionsFixture(cleanup), local = await f.b.put('same-SID'), original = await f.d.put('same-SID')
  const session: AgentMuxStoredAgentSession = { ...original, creation: { createOperationId: 'original-C', createdRun: original.run, initialPrompt: 'unconfirmed' } }
  await (f.d.core as unknown as { registry: { put(session: AgentMuxStoredAgentSession, expectedRun: AgentMuxStoredAgentSession['run']): Promise<void> } }).registry.put(session, original.run)
  const general = vi.spyOn(f.d.core, 'connect').mockRejectedValue(new Error('Optional general Host observation is unavailable'))
  const native = vi.spyOn(f.d.core, 'connectRuntime').mockRejectedValue(new Error('Names must not connect Native'))
  const subject = vi.spyOn(f.d.core, 'runtimeSubject').mockRejectedValue(new Error('The exact Native Run observation is unavailable; names remain metadata'))
  const one = await f.admit('D-in-B', f.d.owner.runtimeId, session.agentSessionId, 'original-C')
  const another = await f.admit('D-in-B', f.d.owner.runtimeId, session.agentSessionId, 'another-C')
  const target = { reference: f.reference, regionId: one.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: session.agentSessionId,
    expectedAdmission: { kind: 'creation' as const, operationId: 'original-C' } }
  return { ...f, session, local, one, another, target, general, native, subject, names: createNameControlClient(f.b.rpc), localNames: createNameControlClient(f.d.rpc) }
}

test('public qualified names write the Source Tab and actual D local Agent, without touching a same-SID B label or any Run reader', async () => {
  const f = await member()
  await expect(access(f.d.spatial.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const inspected = await f.names.inspectMember({ target: f.target, object: 'agent' }).then(value => ({ value }), error => ({ error }))
  expect(inspected).toHaveProperty('value')
  if (!('value' in inspected)) throw inspected.error
  const before = inspected.value
  expect(before.current).toEqual({ override: null, source: null, nameRevision: 0 })
  expect(before.diskAcknowledgement).toBe('not-observed')
  await expect(access(f.d.spatial.path)).rejects.toMatchObject({ code: 'ENOENT' })
  const accepted = await f.names.changeMember({ target: f.target, object: 'agent', change: { kind: 'rename', name: 'Original Agent', expectedNameRevision: 0, source: 'launch', operationId: 'name-Agent-OP' } }).then(value => ({ value }), error => ({ error }))
  expect(accepted).toHaveProperty('value')
  if (!('value' in accepted)) throw accepted.error
  const agent = accepted.value
  const tab = await f.names.changeMember({ target: f.target, object: 'tab', change: { kind: 'rename', name: 'Original Tab', expectedNameRevision: 0, source: 'launch', operationId: 'name-Tab-OP' } })
  expect(agent).toMatchObject({ target: { runtimeId: f.d.owner.runtimeId, kind: 'agent-session', id: f.session.agentSessionId }, current: { override: 'Original Agent', nameRevision: 1 }, applied: true, save: { diskDurability: 'confirmed' } })
  expect(tab).toMatchObject({ target: { runtimeId: f.b.owner.runtimeId, kind: 'tab', id: f.one.address.tabId }, current: { override: 'Original Tab' }, save: { diskDurability: 'confirmed' } })
  expect((await f.b.spatial.readDisplayLabel({ kind: 'agent-session', id: f.local.agentSessionId })).label).toBeNull()
  const state = JSON.parse(await readFile(f.d.spatial.path, 'utf8'))
  expect(state.graph.spaces).toEqual([]); expect(state.graph.tabs).toEqual([])
  expect(state.graph.resources['agentmux:display-labels'].records).toHaveLength(1)
  expect(f.b.inventory).not.toHaveBeenCalled(); expect(f.d.inventory).not.toHaveBeenCalled()
  expect(f.general).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
  expect(f.b.runs).not.toHaveBeenCalled(); expect(f.d.runs).not.toHaveBeenCalled()
  expect(f.b.all).not.toHaveBeenCalled(); expect(f.d.all).not.toHaveBeenCalled()
})

test('same SID and Run cannot replace C, exact Source/owner Runtime or local creation when naming', async () => {
  const f = await member(), change = { kind: 'rename' as const, name: 'Wrong target', expectedNameRevision: 0, source: 'manual' as const, operationId: 'wrong-name-OP' }
  for (const target of [{ ...f.target, expectedAdmission: { kind: 'creation' as const, operationId: f.another.requestId } },
    { ...f.target, reference: { ...f.reference, runtimeId: 'another-source' } }]) {
    for (const object of ['agent', 'tab'] as const) {
      const result = await f.names.changeMember({ target, object, change }).then(value => ({ value }), error => ({ code: error.code }))
      expect(result).not.toHaveProperty('value')
    }
  }
  await expect(f.localNames.changeAgent({ runtimeId: 'wrong-D', agentSessionId: f.session.agentSessionId, createOperationId: 'original-C', change })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  const wrongC = await f.localNames.changeAgent({ runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'another-C', change }).then(value => ({ value }), error => ({ code: error.code }))
  expect(wrongC).toEqual({ code: 'NAME_TARGET_UNCONFIRMED' })
  await expect(access(f.d.spatial.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

test('original CAS, manual-clear priority, operation observation and explicit confirm share the original durable label owner', async () => {
  const f = await member(), target = { runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C' }
  const change = { kind: 'rename' as const, name: 'First', expectedNameRevision: 0, source: 'manual' as const, operationId: 'original-name-OP' }
  await f.localNames.changeAgent({ ...target, change })
  const replay = await f.localNames.changeAgent({ ...target, change })
  expect(replay.changed).toBe(false); expect(replay.save.diskDurability).toBe('unconfirmed')
  const inspected = await f.localNames.inspectAgent({ ...target, operationId: change.operationId })
  expect(inspected).toMatchObject({ current: { override: 'First', nameRevision: 1 }, record: { id: change.operationId, status: 'applied' }, diskAcknowledgement: 'not-observed' })
  const conflict = await f.localNames.changeAgent({ ...target, change: { ...change, operationId: 'stale-OP', name: 'Stale' } })
  expect(conflict.applied).toBe(false); expect(conflict.current.override).toBe('First')
  await f.localNames.changeAgent({ ...target, change: { ...change, operationId: 'clear-OP', name: null, expectedNameRevision: 1 } })
  const late = await f.localNames.changeAgent({ ...target, change: { ...change, operationId: 'late-launch-OP', name: 'Late', expectedNameRevision: 2, source: 'launch' } })
  expect(late.applied).toBe(false); expect(late.current.override).toBeNull()
  const confirmed = await f.localNames.changeAgent({ ...target, change: { kind: 'confirm', operationId: change.operationId } })
  expect(confirmed).toMatchObject({ current: { override: null, nameRevision: 2 }, record: { id: change.operationId, actual: 'First' }, changed: false, applied: true, save: { diskDurability: 'confirmed' } })
  const reopened = new AgentMuxSpatialStateStore(f.d.spatial.path)
  expect(await reopened.readDisplayLabel({ kind: 'agent-session', id: f.session.agentSessionId }, change.operationId)).toMatchObject({ label: { value: null, nameRevision: 2 }, record: { id: change.operationId } })
  expect(f.d.runs).not.toHaveBeenCalled()
})

test('finite names reject a Run/actor argument, missing admission and association L used as an Agent creation C', () => {
  const target = { reference: { runtimeId: 'B', spaceId: 'Space' }, regionId: 'Region', runtimeId: 'D', agentSessionId: 'SID', expectedAdmission: { kind: 'creation' as const, operationId: 'C' } }
  expect(() => parseNameControlParams('space.member.name.inspect', { target, object: 'agent' })).not.toThrow()
  for (const value of [{ target: { ...target, expectedRun: { runId: 'Run' } }, object: 'agent' }, { target: { ...target, expectedAdmission: undefined }, object: 'agent' }, { target, object: 'agent', actor: { kind: 'user', id: 'forged' } }]) expect(() => parseNameControlParams('space.member.name.inspect', value)).toThrow()
  expect(() => memberAgentNameInput({ target: { ...target, expectedAdmission: { kind: 'association', operationId: 'L' } }, object: 'agent' })).toThrowError(expect.objectContaining({ code: 'SPACE_MEMBER_EXTERNAL_COORDINATOR' }))
  const input = { runtimeId: 'D', agentSessionId: 'SID', createOperationId: 'C' }, reply = { target: { runtimeId: 'D', kind: 'agent-session', id: 'SID' }, current: { override: null, source: null, nameRevision: 0 }, record: null, diskAcknowledgement: 'not-observed' }
  expect(() => parseNameControlResult('agent.name.inspect', reply, input)).not.toThrow()
  expect(() => parseNameControlResult('agent.name.inspect', { ...reply, diskAcknowledgement: 'confirmed' }, input)).toThrow()
  expect(() => parseNameControlResult('agent.name.inspect', { ...reply, target: { ...reply.target, runtimeId: 'B' } }, input)).toThrow()
})

test('association L names its Source Tab but never becomes an Agent creation C or a reverse name carrier', async () => {
  const f = await member(), { rpcControlRequest } = await import('../src/rpc-business-codec.js'), { isSpatialAgentAssociation } = await import('../src/spatial-agent-open-contract.js')
  const zone = (await f.b.spatial.read())!.graph.zones[0]!
  const request = rpcControlRequest('agent.open', { operationId: 'original-L', content: { kind: 'agent-session',
    reference: { kind: 'coordinator-agent', runtimeId: f.d.owner.runtimeId, binding: { bindingId: 'original-independent-binding', agentSessionId: f.session.agentSessionId, createOperationId: 'original-C' } },
    expectedResource: { runtimeId: f.b.owner.runtimeId, workspaceId: zone.workspaceId, workspacePath: zone.directoryPath } },
    destination: { spaceId: f.reference.spaceId, zoneId: zone.zoneId, newTab: true }, focus: false })
  if (!isSpatialAgentAssociation(request)) throw Error('The original association request is required')
  const association = await f.b.spatial.associateAgentOpen(request, f.b.owner.runtimeId, async () => {})
  const target = { ...f.target, regionId: association.record.address.regionId, expectedAdmission: { kind: 'association' as const, operationId: 'original-L' } }
  const read = vi.spyOn(f.d.core, 'readAgentSession'), change = { kind: 'rename' as const, name: 'Association Tab', expectedNameRevision: 0, source: 'launch' as const, operationId: 'L-tab-name' }
  const tab = await f.names.changeMember({ target, object: 'tab', change })
  expect(tab).toMatchObject({ target: { id: association.record.address.tabId, runtimeId: f.b.owner.runtimeId }, applied: true })
  await expect(f.names.changeMember({ target, object: 'agent', change: { ...change, operationId: 'not-a-reverse-Agent-name' } })).rejects.toMatchObject({ code: 'SPACE_MEMBER_EXTERNAL_COORDINATOR' })
  expect(read).not.toHaveBeenCalled()
  // The independently authenticated original execution owner may still name its
  // own original C. Neither the L receipt nor B's existing route is used here.
  const agent = await f.localNames.changeAgent({ runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C', change: { ...change, name: 'Independent original Agent', operationId: 'own-C-Agent-name' } })
  expect(agent).toMatchObject({ current: { override: 'Independent original Agent' }, applied: true })
  expect(f.d.runs).not.toHaveBeenCalled()
})

test('a real current-viewer A to Source B to C to D name child preserves original actor and exact digest with independent receiver grants', async () => {
  const f = await member(), { join } = await import('node:path'), { AgentMuxCreationAuthority } = await import('../src/agent-creation-authority.js'),
    { HostRouteGateway } = await import('../src/host-route-gateway.js'), { hostRouteTransport, routedAgentMuxRpc } = await import('../src/host-route-rpc.js'),
    { AgentMuxControlServer } = await import('../src/public-rpc-server.js'), { connectAgentMuxRpc } = await import('../src/public-rpc-client.js')
  const peers = new Map<string, Awaited<ReturnType<typeof connectAgentMuxRpc>>>(), nodes = new Map<string, { gateway: InstanceType<typeof HostRouteGateway>; rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>; identity: Awaited<ReturnType<InstanceType<typeof AgentMuxCreationAuthority>['identity']>> }>()
  for (const [name, runtimeId] of [['A', 'runtime-a'], ['B', f.b.owner.runtimeId], ['C', 'runtime-c'], ['D', f.d.owner.runtimeId]] as const) {
    const authority = new AgentMuxCreationAuthority({ stateDirectory: join(f.b.root, name), runtimeId }), identity = await authority.identity()
    let server: InstanceType<typeof AgentMuxControlServer>
    const gateway = new HostRouteGateway({ stateDirectory: join(f.b.root, name), authority,
      edge: id => { const rpc = peers.get(id); if (!rpc) throw Error('Unconfigured original route edge'); return hostRouteTransport(rpc) },
      call: (method, params, context) => server.callRpc(method, params, context), subscribe: (method, params, emit, context) => server.subscribeRpc(method, params, emit, context) })
    server = new AgentMuxControlServer({ hostRoutes: gateway,
      ...(name === 'B' ? { spatialState: f.b.spatial, coreClients: () => [{ hostId: 'local', client: f.b.core }], hostedRuntime: () => f.b.hosted }
        : name === 'D' ? { spatialState: f.d.spatial, coreClients: () => [{ hostId: 'local', client: f.d.core }], hostedRuntime: () => f.d.hosted } : { coreClients: () => [] }) }, join(f.b.root, name + '-names.sock'))
    await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    cleanup.push(async () => { gateway.dispose(); await rpc.dispose(); await server.stop() }); peers.set(name, rpc); nodes.set(name, { gateway, rpc, identity })
  }
  const a = nodes.get('A')!, b = nodes.get('B')!, c = nodes.get('C')!, d = nodes.get('D')!
  const actor = { source: a.identity, kind: 'user' as const, id: 'local-user:' + (process.getuid?.() ?? 'current') }
  const access = { source: a.identity, hops: [{ edgeId: 'B', target: b.identity }] }, adoptedRoute = { source: b.identity, hops: [{ edgeId: 'C', target: c.identity }, { edgeId: 'D', target: d.identity }] }
  const configure = async (node: typeof a, routes: import('../src/host-route.js').HostRouteDefinition[], grants: import('../src/host-route.js').HostRouteGrant[]) => {
    const previous = await node.rpc.call('route.inspect', {})
    await node.rpc.call('route.configure', { expectedRevision: previous.revision, operationId: 'name-policy-' + Math.random(), configuration: { routes, grants } })
  }
  const grant = (id: string, delegator: typeof a.identity, destination: typeof a.identity, scopes: string[]) => ({ id, delegator, destination, actor, scopes })
  await configure(a, [{ id: 'B', route: access }], [])
  await configure(b, [{ id: 'D', route: adoptedRoute }], [grant('A-source-name', a.identity, b.identity, ['space.member.name.inspect', 'space.member.name.change'])])
  await configure(c, [], [grant('B-name-child', b.identity, d.identity, ['agent.name.inspect', 'agent.name.change'])])
  const dGrant = grant('C-name-child', c.identity, d.identity, ['agent.name.inspect', 'agent.name.change'])
  await configure(d, [], [dGrant])
  const original = await f.d.put('routed-SID'), routedSession: AgentMuxStoredAgentSession = { ...original, creation: { createOperationId: 'routed-C', createdRun: original.run, initialPrompt: 'unconfirmed' } }
  await (f.d.core as unknown as { registry: { put(session: AgentMuxStoredAgentSession, expectedRun: AgentMuxStoredAgentSession['run']): Promise<void> } }).registry.put(routedSession, original.run)
  const admitted = await f.admit('D', f.d.owner.runtimeId, routedSession.agentSessionId, 'routed-C', adoptedRoute)
  const target = { ...f.target, agentSessionId: routedSession.agentSessionId, regionId: admitted.address.regionId, expectedAdmission: { kind: 'creation' as const, operationId: 'routed-C' } }, names = createNameControlClient(routedAgentMuxRpc(a.rpc, 'B', access))
  const sourceTab = await names.changeMember({ target, object: 'tab', change: { kind: 'rename', operationId: 'routed-original-Tab-name', name: 'Actual B Tab', expectedNameRevision: 0, source: 'launch' } })
  expect(sourceTab).toMatchObject({ target: { runtimeId: b.identity.runtimeId, kind: 'tab', id: admitted.address.tabId }, applied: true })
  const result = await names.changeMember({ target, object: 'agent', change: { kind: 'rename', operationId: 'routed-original-name', name: 'Actual D original', expectedNameRevision: 0, source: 'manual' } })
  expect(result).toMatchObject({ current: { override: 'Actual D original' }, record: { context: { actor: { kind: 'user', id: actor.id, verified: true }, location: { sourceRuntimeId: b.identity.runtimeId, actorSourceRuntimeId: a.identity.runtimeId, admissionOperationId: 'routed-C' } } }, save: { diskDurability: 'confirmed' } })
  expect((await f.b.spatial.readDisplayLabel({ kind: 'agent-session', id: routedSession.agentSessionId })).label).toBeNull()
  await configure(d, [], [])
  await expect(names.changeMember({ target, object: 'agent', change: { kind: 'rename', operationId: 'revoked-name', name: 'Not allowed', expectedNameRevision: 1, source: 'manual' } })).rejects.toBeDefined()
  expect((await f.d.spatial.readDisplayLabel({ kind: 'agent-session', id: routedSession.agentSessionId })).value).toBe('Actual D original')
  await configure(d, [], [dGrant])
  const authorize = b.gateway.authorizeMemberName.bind(b.gateway)
  vi.spyOn(b.gateway, 'authorizeMemberName').mockImplementation(async (input, context) => authorize({ ...input,
    input: 'change' in input.input && input.input.change.kind === 'rename' ? { ...input.input, change: { ...input.input.change, name: 'Changed after original A parent' } } : input.input }, context))
  const call = b.gateway.call.bind(b.gateway)
  vi.spyOn(b.gateway, 'call').mockImplementation(async (input, context, receive, derived) => {
    if (derived?.authorization.scope.kind === 'member-name' && input.call.method === 'agent.name.change') {
      const change = input.call.params.change as Record<string, unknown>
      return await call({ ...input, call: { ...input.call, params: { ...input.call.params, change: { ...change, name: 'Changed after original A parent' } } } }, context, receive, derived)
    }
    return await call(input, context, receive, derived)
  })
  const wrongChild = await names.changeMember({ target, object: 'agent', change: { kind: 'rename', operationId: 'digest-name', name: 'Exact original A input', expectedNameRevision: 1, source: 'manual' } }).then(value => ({ value }), error => ({ code: error.code }))
  expect(wrongChild).toEqual({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  vi.mocked(b.gateway.authorizeMemberName).mockRestore()
  // Keep only the changed child call now: the original A parent and B signed
  // scope are intact. The receiver's exact child digest is independently required.
  const wrongDigest = await names.changeMember({ target, object: 'agent', change: { kind: 'rename', operationId: 'child-digest-name', name: 'Exact second A input', expectedNameRevision: 1, source: 'manual' } }).then(value => ({ value }), error => ({ code: error.code }))
  expect(wrongDigest).toEqual({ code: 'HOST_ROUTE_DERIVATION_MISMATCH' })
  expect((await f.d.spatial.readDisplayLabel({ kind: 'agent-session', id: routedSession.agentSessionId })).value).toBe('Actual D original')
  await expect(routedAgentMuxRpc(a.rpc, 'B', access).call('space.member.call', { target: { ...target, expectedRun: routedSession.run }, call: { method: 'runtime.owner.identity', params: { expectedRuntimeId: f.d.owner.runtimeId } } })).rejects.toBeDefined()
  expect(f.d.runs).not.toHaveBeenCalled(); expect(f.d.all).not.toHaveBeenCalled()
})

test('the actual public name CLI changes and inspects the original owner through its declared finite parser and transport', async () => {
  const f = await member(), { runSourceObjectCli } = await import('./helpers/source-object-cli.js'), { objectCliEnvironment } = await import('./helpers/object-cli-rpc.js'), { writeFile } = await import('node:fs/promises'), { join } = await import('node:path')
  const sourceInput = join(f.b.root, 'original-name-input.json'), original = { target: f.target, object: 'tab', change: { kind: 'rename', operationId: 'cli-Tab-name', name: 'CLI original Tab', expectedNameRevision: 0, source: 'launch' } }
  await writeFile(sourceInput, JSON.stringify(original))
  const loader = process.env.NAME_CLI_LOADER ? new URL(process.env.NAME_CLI_LOADER) : undefined
  const raw: { args: string[]; stdout: string; stderr: string; code: number | null }[] = []
  const send = async (owner: typeof f.b, args: string[]) => {
    const result = await runSourceObjectCli(['--endpoint', 'unix:' + owner.server.path, ...args], objectCliEnvironment(owner.root), '', 15000, loader)
    raw.push({ args, ...result })
    if (process.env.NAME_CLI_EVIDENCE) await writeFile(process.env.NAME_CLI_EVIDENCE, JSON.stringify({ original, raw }, null, 2))
    return result
  }
  const named = await send(f.b, ['space', 'member', 'name', 'change', '--input', sourceInput])
  expect(named.code, named.stderr).toBe(0); expect(JSON.parse(named.stdout).result).toMatchObject({ applied: true, current: { override: original.change.name }, save: { diskDurability: 'confirmed' } })
  const localInput = join(f.d.root, 'original-Agent-name.json')
  await writeFile(localInput, JSON.stringify({ runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C', change: { ...original.change, operationId: 'cli-Agent-name', name: 'CLI original Agent' } }))
  const agent = await send(f.d, ['agent', 'name', 'change', '--input', localInput])
  expect(agent.code, agent.stderr).toBe(0); expect(JSON.parse(agent.stdout).result).toMatchObject({ target: { runtimeId: f.d.owner.runtimeId }, current: { override: 'CLI original Agent' }, applied: true })
  await writeFile(localInput, JSON.stringify({ runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C', operationId: 'cli-Agent-name' }))
  const inspected = await send(f.d, ['agent', 'name', 'inspect', '--input', localInput])
  expect(inspected.code, inspected.stderr).toBe(0); expect(JSON.parse(inspected.stdout).result).toMatchObject({ record: { id: 'cli-Agent-name' }, diskAcknowledgement: 'not-observed' })
  for (const module of ['agent', 'space']) {
    const guide = await runSourceObjectCli([module, '--skill'], objectCliEnvironment(f.b.root), '', 15000, loader)
    expect(guide.code, guide.stderr).toBe(0)
    expect(guide.stdout).toContain(module === 'agent' ? 'agent name change' : 'space member name change')
    expect(guide.stdout).toContain(module === 'agent' ? 'diskAcknowledgement' : 'createNameControlClient')
  }
  expect(f.d.runs).not.toHaveBeenCalled(); expect(f.b.runs).not.toHaveBeenCalled()
})

test('a replaced original name with unknown disk ACK stays applied and inspect never turns it into a confirmed write', async () => {
  const f = await member(), target = { runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C' }
  fault.path = f.d.spatial.path
  const changed = await f.localNames.changeAgent({ ...target, change: { kind: 'rename', operationId: 'unknown-name-ACK', name: 'Actual replaced name', expectedNameRevision: 0, source: 'manual' } })
  expect(changed).toMatchObject({ applied: true, changed: true, current: { override: 'Actual replaced name' }, save: { diskDurability: 'unconfirmed' } })
  const observed = await f.localNames.inspectAgent({ ...target, operationId: 'unknown-name-ACK' })
  expect(observed).toMatchObject({ record: { status: 'applied', id: 'unknown-name-ACK' }, diskAcknowledgement: 'not-observed' })
  const confirmed = await f.localNames.changeAgent({ ...target, change: { kind: 'confirm', operationId: 'unknown-name-ACK' } })
  expect(confirmed).toMatchObject({ changed: false, current: { override: 'Actual replaced name' }, save: { diskDurability: 'confirmed' } })
  const document = JSON.parse(await readFile(f.d.spatial.path, 'utf8')).graph.resources['agentmux:display-labels']
  expect(document.records).toHaveLength(1); expect(document.records[0].id).toBe('unknown-name-ACK')
  expect(f.d.runs).not.toHaveBeenCalled()
})

test('unreadable label storage is not treated as absent initialization and keeps the original Agent available', async () => {
  const f = await member(), { writeFile } = await import('node:fs/promises'), original = '{"original-unreadable-name-document":'
  await writeFile(f.d.spatial.path, original)
  const target = { runtimeId: f.d.owner.runtimeId, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C' }
  await expect(f.localNames.inspectAgent(target)).rejects.toBeDefined()
  await expect(f.localNames.changeAgent({ ...target, change: { kind: 'rename', operationId: 'must-not-initialize', name: 'Replacement', expectedNameRevision: 0, source: 'manual' } })).rejects.toBeDefined()
  expect(await readFile(f.d.spatial.path, 'utf8')).toBe(original)
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toMatchObject({ run: f.session.run })
  expect(f.d.runs).not.toHaveBeenCalled()
})
