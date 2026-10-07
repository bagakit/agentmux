import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { roomProvisioningFixture, config, core } from './fixtures/room-provisioning.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await roomProvisioningFixture({ managedCaller: true }); cleanup.push(() => f.close())
  const services = await createDesktopConnections({ directory: join(f.root, 'desktop-rooms'), adapters: [f.adapter], bindings: { spatial: f.spatial, checkpoint: f.checkpoint },
    encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() } })
  cleanup.push(() => services.close())
  const secret = await services.secrets.store({ operationId: 'public-room-credential', secret: 'private-fixture-credential' })
  await services.connections.configure({ operationId: 'public-room-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
  const socketPath = join(f.root, 'rooms.sock'), server = new core.AgentMuxControlServer({ socketPath, connections: services.connections, spatialState: f.spatial,
    coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => sdk.dispose())
  const env = objectCliEnvironment(f.root)
  const cli = (args: string[], input?: unknown, overrides: NodeJS.ProcessEnv = {}) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', ...args], { ...env, ...overrides }, input === undefined ? '' : JSON.stringify(input))
  return { ...f, services, sdk, cli, env, socketPath }
}
function result(output: { code: number | null; stdout: string; stderr: string }) { expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result }

it('compiled room CLI and typed public SDK reach the original Desktop Host, credential owner and controlled adapter', async () => {
  const f = await fixture(), saved = result(await f.cli(['room', 'create', '--input', '-'], f.createInput))
  expect(saved).toMatchObject({ input: f.createInput, authorizedBy: { kind: 'user' }, application: config.application, creation: { state: 'created', externalConversationId: 'created-room' }, membership: { state: 'settled' } })
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.addMembers).toHaveBeenCalledTimes(1)
  expect(f.create.mock.calls[0]![1]).toBe('private-fixture-credential')
  expect(await f.sdk.call('connection.room.inspect', { operationId: saved.operationId })).toEqual({ operation: saved })
  expect(result(await f.cli(['room', 'inspect', '--operation-id', saved.operationId]))).toEqual({ operation: saved })
  const refused = result(await f.cli(['bind', '--input', '-'], { ...f.input, operationId: 'binding-after-create', externalConversationId: 'created-room', expectedSource: { ...f.input.expectedSource, nativeSessionId: 'another-original-source' } }))
  expect(refused).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_SOURCE_CHANGED' })
  expect(result(await f.cli(['room', 'create', '--input', '-'], f.createInput))).toEqual(saved)
  const bound = result(await f.cli(['bind', '--input', '-'], { ...f.input, operationId: 'explicit-valid-binding', externalConversationId: 'created-room' }))
  expect(bound).toMatchObject({ state: 'applied', binding: { externalConversationId: 'created-room', authorizedBy: { kind: 'user' } } })
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.addMembers).toHaveBeenCalledTimes(1); await f.unchanged()
  expect(JSON.stringify(saved)).not.toContain('credential'); expect(JSON.stringify(saved)).not.toContain(f.root)
  const directory = '.bagakit/feature-tracker/features/f-2wr8fmvnv/artifacts'
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'T-021-public-consumer.json'), JSON.stringify({ input: f.createInput, saved,
    compiledCli: 'connection room create --input; connection room inspect --operation-id; independent connection bind',
    originalOwners: 'Compiled CLI → public Unix RPC → original Core AgentMuxRpcService → Desktop ConnectionPort.rooms → RoomProvisioningHost → same ConnectionHost database/SecretPort/adapter registry → controlled adapter',
    effects: { creation: f.create.mock.calls.length, membership: f.addMembers.mock.calls.length }, localSessionAndRuntimeUnchanged: true,
    qualification: 'Actual public/Core/Host/compiled consumer; credential encryption and external adapter are controlled leaves. No vendor SDK qualification, real group, message, physical Runtime, Browser, OS or installation claim.' }, null, 2) + '\n')
}, 20_000)

it('a lost CLI response is recovered by original inspect, with no creation or membership replay after credential rotation', async () => {
  const f = await fixture(), rooms = f.services.connections.rooms!, create = rooms.create.bind(rooms)
  vi.spyOn(rooms, 'create').mockImplementationOnce(async (input, context) => { await create(input, context); throw new core.AgentMuxError('Original response is unconfirmed; inspect the same operation.', 'CONTROL_UNAVAILABLE') })
  expect((await f.cli(['room', 'create', '--input', '-'], f.createInput)).code).not.toBe(0)
  const inspected = result(await f.cli(['room', 'inspect', '--operation-id', f.createInput.operationId]))
  expect(inspected.operation.creation).toMatchObject({ state: 'created', externalConversationId: 'created-room' })
  const current = (await f.services.connections.inspect({ connectionId: config.connectionId })).connection!
  await f.services.connections.configure({ operationId: 'room-credential-revision', expectedRevision: 1, connection: { ...current.config, label: 'Rotated original configuration' } })
  expect(result(await f.cli(['room', 'create', '--input', '-'], f.createInput))).toEqual(inspected.operation)
  const another = result(await f.cli(['room', 'create', '--input', '-'], { ...f.createInput, operationId: 'new-key-after-lost-receipt', expectedConnectionRevision: 2 }))
  expect(another.creation).toEqual({ state: 'not-applied', reason: 'existing-operation', originalOperationId: f.createInput.operationId })
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.addMembers).toHaveBeenCalledTimes(1); await f.unchanged()
}, 20_000)

it('uses transport-approved human administration and refuses a managed Agent or payload-authored authority', async () => {
  const f = await fixture(), managed = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath }, credentials: f.caller! })
  cleanup.push(() => managed.dispose())
  await expect(managed.call('connection.room.create', f.createInput)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const denied = await f.cli(['room', 'create', '--input', '-'], f.createInput, { AGENTMUX_AGENT_SESSION_ID: f.caller!.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.caller!.capability })
  expect(denied.code).not.toBe(0)
  expect((await f.cli(['room', 'create', '--input', '-'], { ...f.createInput, authorizedBy: { kind: 'user', id: 'claimed-human' } })).code).not.toBe(0)
  expect(await f.sdk.call('connection.room.inspect', { operationId: f.createInput.operationId })).toEqual({ operation: null })
  expect(f.create).not.toHaveBeenCalled(); expect(f.addMembers).not.toHaveBeenCalled(); await f.unchanged()
}, 20_000)

it('keeps optional room failure local and exposes the exact generated CLI recovery and authority contract', async () => {
  const f = await fixture()
  delete f.services.connections.rooms
  await expect(f.sdk.call('connection.room.create', f.createInput)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect((await f.sdk.call('connection.ls', {})).connections).toHaveLength(1)
  expect(await f.sdk.call('space.state', {})).toHaveProperty('state.graph')
  const createHelp = await runCompiledObjectCli(['connection', 'room', 'create', '--help'], f.env)
  expect(createHelp.code).toBe(0); expect(createHelp.stdout).toContain('expectedConnectionRevision'); expect(createHelp.stdout).toContain('members [{idType,userId}]'); expect(createHelp.stdout).toContain('transport-approved'); expect(createHelp.stdout).toContain('never name-match')
  const inspectHelp = await runCompiledObjectCli(['connection', 'room', 'inspect', '--help'], f.env)
  expect(inspectHelp.code).toBe(0); expect(inspectHelp.stdout).toContain('--operation-id'); expect(inspectHelp.stdout).toContain('without external effects')
  const skill = await runCompiledObjectCli(['connection', '--skill'], f.env)
  expect(skill.code).toBe(0); expect(skill.stdout).toContain('amux connection --help')
  const moduleHelp = await runCompiledObjectCli(['connection', '--help'], f.env)
  expect(moduleHelp.code).toBe(0); expect(moduleHelp.stdout).toContain('connection room create'); expect(moduleHelp.stdout).toContain('connection room inspect')
  expect(f.create).not.toHaveBeenCalled(); await f.unchanged()
}, 20_000)
