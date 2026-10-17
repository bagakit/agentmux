import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxError } from '../../core/src/errors.js'
import { AgentMuxControlServer } from '../../core/src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/src/public-rpc-client.js'
import { AgentMuxRpcService } from '../../core/src/public-rpc-service.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { config, roomBindingFixture } from './fixtures/room-binding.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const failures: unknown[] = []
  try {
    for (const close of cleanup.splice(0).reverse()) { try { await close() } catch (error) { failures.push(error) } }
  } finally { try { vi.restoreAllMocks() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'Public room binding test cleanup failed')
})
async function fixture() {
  const f = await roomBindingFixture(); cleanup.push(() => f.close())
  // The original Desktop Host composition shares its one database, spatial owner and exact Core client.
  const services = await createDesktopConnections({ directory: join(f.root, 'desktop-connections'), encryption: { isAsyncEncryptionAvailable: async () => false, encryptStringAsync: async () => { throw new Error('No credential entry in this test') }, decryptStringAsync: async () => { throw new Error('No credential resolution in binding') } }, bindings: { spatial: f.spatial, checkpoint: f.checkpoint } })
  cleanup.push(() => services.close())
  const socketPath = join(f.root, 'public.sock'), server = new AgentMuxControlServer({ socketPath, connections: services.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(f.root)
  const cli = (args: string[], input?: unknown) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], env, input === undefined ? '' : JSON.stringify(input))
  const configured = await cli(['configure', '--input', '-'], { operationId: 'configure-public', expectedRevision: null, connection: config })
  expect(configured.code, configured.stdout + configured.stderr).toBe(0)
  return { ...f, services, server, socketPath, cli, env }
}
function result(output: { code: number; stdout: string; stderr: string }) { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }

describe('room binding real public consumers', () => {
  it('binds through compiled CLI and original Desktop Host ports, then SDK inspects and CLI pauses and explicitly relinks', async () => {
    const f = await fixture(); f.input.externalConversationId = 'room/project-alpha'
    const saved = result(await f.cli(['bind', '--input', '-'], f.input))
    expect(saved).toMatchObject({ state: 'applied', binding: { revision: 1, executionHostId: 'local', agentSessionId: f.input.agentSessionId, externalConversationId: 'room/project-alpha', authorizedBy: { kind: 'user' } } })
    expect(saved.binding.sourceCheckpoints).toEqual([await f.client.sessionHistoryCheckpoint(f.input.agentSessionId)])
    const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); cleanup.push(() => sdk.dispose())
    expect((await sdk.call('connection.binding.inspect', { operationId: f.input.operationId })).operation).toEqual(saved)
    const found = result(await f.cli(['binding', 'ls', '--host', 'local', '--session', f.input.agentSessionId]))
    expect(found.bindings).toEqual([saved.binding])
    const paused = result(await f.cli(['binding', 'pause', '--input', '-'], { operationId: 'public-pause', bindingId: f.input.bindingId, expectedRevision: 1 }))
    expect(paused).toMatchObject({ state: 'applied', binding: { revision: 2, state: 'paused' } })
    const relinked = result(await f.cli(['binding', 'relink', '--input', '-'], { ...f.input, operationId: 'public-relink', expectedRevision: 2, externalConversationId: 'new-group' }))
    expect(relinked).toMatchObject({ state: 'applied', binding: { revision: 3, externalConversationId: 'new-group' } })
    expect(result(await f.cli(['binding', 'inspect', '--operation-id', f.input.operationId])).operation).toEqual(saved)
    expect(result(await f.cli(['binding', 'inspect', '--binding', f.input.bindingId, '--revision', '1'])).binding).toEqual(saved.binding)
    expect(f.services.bindings?.publicationAuthority(f.input.bindingId, 1)).toMatchObject({ authorized: false, binding: saved.binding })
    expect(f.services.bindings?.publicationAuthority(f.input.bindingId, 3).authorized).toBe(true)
    await f.unchanged()
  }, 20_000)
  it('uses the same original operation after a lost delivery response and requires exact actor grants', async () => {
    const f = await fixture(), bindings = f.services.connections.bindings!
    const original = bindings.bind.bind(bindings)
    vi.spyOn(bindings, 'bind').mockImplementationOnce(async (input, context) => { await original(input, context); throw new AgentMuxError('The response could not confirm the original operation.', 'CONTROL_UNAVAILABLE') })
    const unknown = await f.cli(['bind', '--input', '-'], f.input)
    expect(unknown.code).not.toBe(0)
    const inspected = result(await f.cli(['binding', 'inspect', '--operation-id', f.input.operationId]))
    expect(inspected.operation).toMatchObject({ operationId: f.input.operationId, state: 'applied', binding: { revision: 1 } })
    expect(result(await f.cli(['bind', '--input', '-'], f.input))).toEqual(inspected.operation)
    const granted = result(await f.cli(['grant', '--input', '-'], { operationId: 'public-grant', bindingId: f.input.bindingId, expectedBindingRevision: 1, grantId: 'input-actor', expectedRevision: null, actor: { application: config.application, idType: 'open_id', userId: 'acct@example.test/成员' }, capabilities: ['input', 'answer'], state: 'active' }))
    expect(granted.grant).toMatchObject({ bindingRevision: 1, externalConversationId: f.input.externalConversationId, capabilities: ['input', 'answer'] })
    expect(granted.grant.capabilities).not.toContain('permission')
    const forged = await f.cli(['bind', '--input', '-'], { ...f.input, operationId: 'forged', authorizedBy: { kind: 'user', id: 'forged-human' } })
    expect(forged.code).not.toBe(0)
    expect(result(await f.cli(['binding', 'inspect', '--operation-id', 'forged'])).operation).toBeNull()
    await f.unchanged()
  }, 20_000)
  it('keeps exact public bind and relink usable across unrelated commits, while a changed Host or native source preserves the old binding and grant', async () => {
    const f = await fixture(), nativeCheckpoint = f.client.conversationCheckpoint.bind(f.client)
    const checkpoints = vi.spyOn(f.client, 'conversationCheckpoint')
    const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath } }); cleanup.push(() => sdk.dispose())
    async function interleave<T>(call: () => Promise<T>, change: Parameters<typeof f.change>[0]): Promise<T> {
      let reached = false, release!: () => void
      const held = new Promise<void>(resolve => { release = resolve })
      checkpoints.mockImplementationOnce(async ref => {
        expect(ref).toEqual({ hostId: f.input.executionHostId, agentSessionId: f.input.agentSessionId })
        const cut = await nativeCheckpoint(ref)
        reached = true; await held; return cut
      })
      const work = call()
      try { await vi.waitFor(() => expect(reached).toBe(true)); await f.change(change) }
      finally { release(); await work.catch(() => {}) }
      return await work
    }
    const saved = result(await interleave(() => f.cli(['bind', '--input', '-'], f.input), graph => { graph.regions[1]!.agentSessionId = 'unrelated-agent' }))
    expect(saved).toMatchObject({ state: 'applied', binding: { revision: 1, executionHostId: f.input.executionHostId, agentSessionId: f.input.agentSessionId } })
    expect(saved.binding.sourceCheckpoints).toEqual([await f.client.sessionHistoryCheckpoint(f.input.agentSessionId)])
    const relink = { ...f.input, operationId: 'interleaved-public-relink', expectedRevision: 1, externalConversationId: 'new-group' }
    const linked = await interleave(() => sdk.call('connection.binding.relink', relink), graph => { graph.tabLayouts.tab!.activeRegionId = 'other-region' })
    expect(linked).toMatchObject({ state: 'applied', binding: { revision: 2, externalConversationId: 'new-group' } })
    if (linked.state !== 'applied') throw new Error('Original public relink was not completed')
    const grant = await sdk.call('connection.grant', { operationId: 'interleaved-grant', bindingId: f.input.bindingId, expectedBindingRevision: 2, grantId: 'original-actor-grant', expectedRevision: null,
      actor: { application: config.application, idType: 'open_id', userId: 'original-actor' }, capabilities: ['input'], state: 'active' })
    expect(grant).toMatchObject({ state: 'applied', grant: { bindingRevision: 2 } })
    const before = await sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })
    const wrongHost = result(await interleave(() => f.cli(['binding', 'relink', '--input', '-'], { ...relink, operationId: 'late-wrong-host', expectedRevision: 2 }), graph => {
      graph.regions.find(region => region.regionId === f.input.regionAnchor.regionId)!.execution!.hostId = 'other-host'
    }))
    expect(wrongHost).toEqual({ operationId: 'late-wrong-host', action: 'relink', state: 'refused', code: 'ROOM_BINDING_TARGET_CHANGED' })
    expect(await sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })).toEqual(before)
    await f.change(graph => { graph.regions.find(region => region.regionId === f.input.regionAnchor.regionId)!.execution!.hostId = f.input.executionHostId })
    const wrongSource = await sdk.call('connection.binding.relink', { ...relink, operationId: 'wrong-public-source', expectedRevision: 2, expectedSource: { ...f.input.expectedSource, nativeSessionId: 'another-native-source' } })
    expect(wrongSource).toEqual({ operationId: 'wrong-public-source', action: 'relink', state: 'refused', code: 'ROOM_BINDING_SOURCE_CHANGED' })
    expect(await sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })).toEqual(before)
    expect(result(await f.cli(['binding', 'inspect', '--operation-id', f.input.operationId])).operation).toEqual(saved)
    await f.unchanged()
  }, 20_000)
  it('keeps absent binding owners local and publishes usable generated help', async () => {
    const f = await fixture(), service = new AgentMuxRpcService({ connections: f.connections, spatialState: f.spatial }), principal = { principal: { kind: 'user' as const, id: 'fixture-user' } }
    cleanup.push(() => service.dispose())
    const bindHelp = await runCompiledObjectCli(['connection', 'bind', '--help'], f.env)
    expect(bindHelp.code).toBe(0); expect(bindHelp.stdout).toContain('expectedSource'); expect(bindHelp.stdout).toContain('Existing history is excluded')
    const skill = await runCompiledObjectCli(['connection', '--skill'], f.env)
    expect(skill.code).toBe(0); expect(skill.stdout).toContain('# connection module'); expect(skill.stdout).toContain('The connection owner holds configured adapters, bindings, grants, ingress and delivery')
    const inspectHelp = await runCompiledObjectCli(['connection', 'binding', 'inspect', '--help'], f.env)
    expect(inspectHelp.code).toBe(0); expect(inspectHelp.stdout).toContain('connection binding inspect')
    const grantHelp = await runCompiledObjectCli(['connection', 'grant', '--help'], f.env)
    expect(grantHelp.code).toBe(0); expect(grantHelp.stdout).toContain('connection grant')
    await expect(service.call('connection.bind', f.input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    delete f.connections.bindings
    await expect(service.call('connection.bind', f.input, principal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await service.call('connection.ls', {}, principal)).toHaveProperty('connections')
    expect(await service.call('space.state', {}, principal)).toHaveProperty('state.graph')
    await f.unchanged()
  }, 20_000)
})
