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
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const f = await roomBindingFixture(); cleanup.push(() => f.close())
  // The original Desktop Host composition shares its one database, spatial owner and exact Core client.
  const services = await createDesktopConnections({ directory: join(f.root, 'desktop-connections'), encryption: { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('No credential entry in this test') }, decryptString: () => { throw new Error('No credential resolution in binding') } }, bindings: { spatial: f.spatial, checkpoint: f.checkpoint } })
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
    expect(saved.binding.sourceCheckpoints).toEqual([await f.client.conversationCheckpoint(f.input.agentSessionId)])
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
  it('keeps absent binding owners local and publishes usable generated help', async () => {
    const f = await fixture(), service = new AgentMuxRpcService({ connections: f.connections, spatialState: f.spatial }), principal = { principal: { kind: 'user' as const, id: 'fixture-user' } }
    cleanup.push(() => service.dispose())
    const bindHelp = await runCompiledObjectCli(['connection', 'bind', '--help'], f.env)
    expect(bindHelp.code).toBe(0); expect(bindHelp.stdout).toContain('expectedSource'); expect(bindHelp.stdout).toContain('Existing history is excluded')
    const skill = await runCompiledObjectCli(['--skill'], f.env)
    expect(skill.code).toBe(0); expect(skill.stdout).toContain('connection binding inspect'); expect(skill.stdout).toContain('connection grant')
    await expect(service.call('connection.bind', f.input, {})).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
    delete f.connections.bindings
    await expect(service.call('connection.bind', f.input, principal)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
    expect(await service.call('connection.ls', {}, principal)).toHaveProperty('connections')
    expect(await service.call('space.state', {}, principal)).toHaveProperty('state.graph')
    await f.unchanged()
  }, 20_000)
})
