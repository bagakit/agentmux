import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../core/dist/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { parseRoomBindingResult } from '../../core/src/room-binding-codec.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { config, context, roomBindingFixture } from './fixtures/room-binding.js'

const clean: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function ownerFixture() {
  const f = await roomBindingFixture(true, { managedCaller: true }); clean.push(f.close)
  const original = await f.bindings.bind(f.input, context)
  expect(original.state).toBe('applied')
  return { ...f, original }
}
async function fixture() {
  const f = await ownerFixture()
  const socketPath = join(f.root, 'binding-conflict.sock')
  const server = new AgentMuxControlServer({ socketPath, connections: f.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); clean.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); clean.push(() => sdk.dispose())
  const cli = async (operationId: string, managed = false) => {
    const env = objectCliEnvironment(f.root, managed ? { AGENTMUX_AGENT_SESSION_ID: f.caller!.agentSessionId, AGENTMUX_AGENT_CAPABILITY: f.caller!.capability } : {})
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'binding', 'inspect', '--operation-id', operationId], env)
    expect(output.code, output.stdout + output.stderr).toBe(0)
    return JSON.parse(output.stdout).result
  }
  return { ...f, sdk, cli, socketPath }
}
function recorded(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
  return f.connections.database.prepare('SELECT intent_json,result_json FROM room_binding_operation WHERE operation_id=?').get(operationId)
}

it('original CLI inspects current group conflict without replacing or replaying the old refusal', async () => {
  const f = await fixture(), input = { ...f.input, operationId: 'request-other-group', bindingId: 'requested-binding', externalConversationId: 'requested-group' }
  const refused = await f.bindings.bind(input, context), before = recorded(f, input.operationId)
  expect(refused).toEqual({ operationId: input.operationId, action: 'bind', state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
  const read = await f.cli(input.operationId)
  expect(read).toMatchObject({ binding: null, current: null, grants: [], operation: refused, mappingConflict: { status: 'checked', current: [{ binding: { bindingId: f.input.bindingId, revision: 1, state: 'active', connectionId: config.connectionId, application: config.application, externalConversationId: f.input.externalConversationId, executionHostId: 'local', agentSessionId: f.input.agentSessionId }, differences: ['audience'] }] } })
  expect(read.mappingConflict.current).toHaveLength(1)
  expect(recorded(f, input.operationId)).toEqual(before)
  expect(f.bindings.readOperation(input.operationId)).toEqual(refused)
  expect(f.bindings.readCurrent(f.input.bindingId)).toEqual(f.original.state === 'applied' ? f.original.binding : null)
  await f.unchanged()
}, 20_000)

it.each(['scope', 'source', 'input-target'] as const)('identifies same-mapping %s differences and deduplicates its three exact lookups', async difference => {
  const f = await ownerFixture(), input = { ...f.input, operationId: 'request-difference',
    ...(difference === 'scope' ? { scope: { ...f.input.scope, input: 'all-messages' as const } } : {}),
    ...(difference === 'source' ? { expectedSource: { ...f.input.expectedSource, nativeSessionId: 'other-native' } } : {}),
    ...(difference === 'input-target' ? { inputTarget: { kind: 'native-conversation' as const, source: f.input.expectedSource } } : {}) }
  const refused = await f.bindings.bind(input, context)
  expect(refused).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
  const lookup = vi.spyOn(f.bindings, 'readCurrent'), list = vi.spyOn(f.bindings, 'listActive')
  const read = await f.bindings.inspect({ operationId: input.operationId })
  expect(read.mappingConflict?.current.map(item => item.differences)).toEqual([[difference]])
  expect(lookup).toHaveBeenCalledTimes(3); expect(list).not.toHaveBeenCalled()
  expect(parseRoomBindingResult('connection.binding.inspect', read, { operationId: input.operationId })).toEqual(read)
  await f.unchanged()
}, 20_000)

it('finds the exact application audience across Connection aliases and separates a foreign target', async () => {
  const f = await fixture(), alias = { ...config, connectionId: 'same-app-alias' }
  await f.connections.configure({ operationId: 'configure-alias', expectedRevision: null, connection: alias })
  const input = { ...f.input, operationId: 'alias-conflict', bindingId: 'alias-binding', connectionId: alias.connectionId }
  expect(await f.bindings.bind(input, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
  expect((await f.sdk.call('connection.binding.inspect', { operationId: input.operationId })).mappingConflict?.current).toMatchObject([{ binding: { connectionId: config.connectionId, application: alias.application }, differences: ['connection'] }])

  await f.change(graph => { graph.regions[0]!.agentSessionId = f.caller!.agentSessionId })
  const foreign = { ...f.input, operationId: 'foreign-target-conflict', agentSessionId: f.caller!.agentSessionId }
  expect(await f.bindings.bind(foreign, context)).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
  expect((await f.sdk.call('connection.binding.inspect', { operationId: foreign.operationId })).mappingConflict?.current).toMatchObject([{ binding: { agentSessionId: f.input.agentSessionId }, differences: ['target'] }])
  await f.unchanged()
}, 20_000)

it('relink inspection excludes its own old mapping and reports no current conflict after an explicit detach', async () => {
  const f = await fixture(), alias = { ...config, connectionId: 'other-receiver' }
  await f.connections.configure({ operationId: 'configure-other', expectedRevision: null, connection: alias })
  const occupied = { ...f.input, operationId: 'bind-occupied', bindingId: 'occupied-binding', connectionId: alias.connectionId, externalConversationId: 'occupied-group' }
  expect(await f.bindings.bind(occupied, context)).toMatchObject({ state: 'applied' })
  const input = { ...f.input, operationId: 'relink-conflict', expectedRevision: 1, externalConversationId: occupied.externalConversationId }
  const refused = await f.bindings.relink(input, context), before = recorded(f, input.operationId)
  expect(refused).toMatchObject({ state: 'refused', code: 'ROOM_BINDING_MAPPING_CONFLICT' })
  const read = await f.sdk.call('connection.binding.inspect', { operationId: input.operationId })
  expect(read.mappingConflict?.current.map(item => item.binding.bindingId)).toEqual([occupied.bindingId])
  expect(read.mappingConflict?.current[0]?.differences).toEqual(['connection'])
  expect(await f.bindings.detach({ operationId: 'detach-occupied', bindingId: occupied.bindingId, expectedRevision: 1 }, context)).toMatchObject({ state: 'applied' })
  expect(await f.cli(input.operationId)).toMatchObject({ operation: refused, mappingConflict: { status: 'checked', current: [] } })
  expect(recorded(f, input.operationId)).toEqual(before)
  await f.unchanged()
}, 20_000)

it('managed RPC and CLI retain the original refusal without discovering foreign conflict references', async () => {
  const f = await fixture(), input = { ...f.input, operationId: 'private-conflict', externalConversationId: 'requested-group' }
  const refused = await f.bindings.bind(input, context)
  const managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socketPath }, credentials: f.caller! }); clean.push(() => managed.dispose())
  expect((await f.sdk.call('connection.binding.inspect', { operationId: input.operationId })).mappingConflict?.current).toHaveLength(1)
  const read = await managed.call('connection.binding.inspect', { operationId: input.operationId })
  expect(read).toEqual({ binding: null, current: null, operation: refused, grants: [] })
  expect(await f.cli(input.operationId, true)).toEqual(read)
  await f.unchanged()
}, 20_000)

it('keeps the recorded refusal readable when an optional current conflict lookup is unavailable', async () => {
  const f = await ownerFixture(), input = { ...f.input, operationId: 'lookup-gap', externalConversationId: 'requested-group' }
  const refused = await f.bindings.bind(input, context)
  vi.spyOn(f.bindings, 'readCurrent').mockImplementation(() => { throw Error('Current observation unavailable') })
  expect(await f.bindings.inspect({ operationId: input.operationId })).toEqual({ binding: null, current: null, operation: refused, grants: [] })
  expect(await f.bindings.inspect({ operationId: 'missing-operation' })).toEqual({ binding: null, current: null, operation: null, grants: [] })
  await f.unchanged()
}, 20_000)

it('rejects forged conflict summaries without broadening the inspection protocol', async () => {
  const f = await ownerFixture(), input = { ...f.input, operationId: 'codec-conflict', externalConversationId: 'requested-group' }
  await f.bindings.bind(input, context)
  const read = await f.bindings.inspect({ operationId: input.operationId }), item = read.mappingConflict!.current[0]!
  for (const current of [[item, item], Array(4).fill(item), [{ ...item, differences: ['not-an-owner-difference'] }], [{ ...item, binding: { ...item.binding, authorizedBy: context.actor } }]]) {
    expect(() => parseRoomBindingResult('connection.binding.inspect', { ...read, mappingConflict: { status: 'checked', current } }, { operationId: input.operationId })).toThrow()
  }
  expect(() => parseRoomBindingResult('connection.binding.inspect', { ...read, operation: { operationId: input.operationId, action: 'bind', state: 'preparing' } }, { operationId: input.operationId })).toThrow()
  await f.unchanged()
}, 20_000)
