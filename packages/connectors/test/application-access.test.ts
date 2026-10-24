import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../../core/dist/public-rpc-server.js'
import { connectAgentMuxRpc } from '../../core/dist/public-rpc-client.js'
import { AgentMuxError } from '../../core/dist/errors.js'
import { parseConnectionResult, parseAgentExternalInteractionAuthor } from '../../core/dist/connections.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { ConnectionHost } from '../src/connection-host.js'
import { config, context, roomBindingFixture } from './fixtures/room-binding.js'
import type { ConnectionActor, ConnectionApplicationAccessConfigure } from '@agentmux/core/connections'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(managed = false) {
  const f = await roomBindingFixture(true, { managedCaller: managed }); cleanup.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'access.sock'), connections: f.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'access.sock') } }); cleanup.push(() => sdk.dispose())
  const cli = async (method: string[], input: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.root, 'access.sock'), 'connection', ...method, '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  const actor: ConnectionActor = { application: config.application, idType: 'open_id', userId: 'member' }
  const intent: ConnectionApplicationAccessConfigure = { operationId: 'app-allow', connectionId: config.connectionId, expectedConnectionRevision: 1, grantId: 'app-member', expectedRevision: null, actor, state: 'active', capabilities: ['input', 'answer', 'permission'] }
  return { ...f, sdk, cli, actor, intent }
}
it('application access public SDK and compiled CLI preserve app identity, original lost ACK, two current/future groups and full local precedence', async () => {
  const f = await fixture()
  expect(await f.sdk.call('connection.application.access.get', { connectionId: config.connectionId, actor: f.actor })).toMatchObject({ application: config.application, grants: [] })
  const configure = f.connections.applicationAccess.configure.bind(f.connections.applicationAccess)
  const dispatch = vi.spyOn(f.connections.applicationAccess, 'configure').mockImplementationOnce(async (input, ctx) => { await configure(input, ctx); throw new AgentMuxError('Controlled lost local ACK', 'CONTROL_UNAVAILABLE') })
  await expect(f.sdk.call('connection.application.access.configure', f.intent)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  const saved = await f.cli(['application', 'access', 'inspect'], { operationId: f.intent.operationId })
  expect(saved.operation).toMatchObject({ state: 'applied', grant: { grantId: 'app-member', revision: 1, actor: f.actor } })
  expect(dispatch).toHaveBeenCalledOnce()
  expect(await f.sdk.call('connection.bind', f.input)).toMatchObject({ state: 'applied' })
  await f.connections.configure({ operationId: 'alias', expectedRevision: null, connection: { ...config, connectionId: 'alias' } })
  expect(await f.sdk.call('connection.bind', { ...f.input, operationId: 'later-bind', bindingId: 'later-binding', connectionId: 'alias', externalConversationId: 'later-room' })).toMatchObject({ state: 'applied' })
  for (const bindingId of [f.input.bindingId, 'later-binding']) {
    const read = await f.sdk.call('connection.binding.inspect', { bindingId })
    expect(read.grants).toEqual([])
    expect(read.access).toEqual([{ actor: f.actor, local: { kind: 'none', previousDecision: false }, effective: { actor: f.actor, state: 'active', capabilities: f.intent.capabilities, source: { kind: 'application', grantId: 'app-member', revision: 1 } } }])
  }
  expect((await f.cli(['application', 'access', 'get'], { connectionId: 'alias' })).grants).toEqual([saved.operation.grant])
  const diagnosis = await f.sdk.call('connection.diagnose', { executionHostId: 'local', agentSessionId: f.input.agentSessionId, bindingId: f.input.bindingId, bindingRevision: 1 })
  expect(diagnosis.groups.value!.items[0]!.binding.value).toMatchObject({ activeInputGrants: 1, activeAnswerGrants: 1, activePermissionGrants: 1 })
  expect(f.connections.database.prepare('EXPLAIN QUERY PLAN SELECT grant_id FROM room_grant_head WHERE binding_id=? AND actor_json=?').all(f.input.bindingId, JSON.stringify(f.actor)).some(row => String(row.detail).includes('SEARCH') && String(row.detail).includes('room_grant_binding_actor'))).toBe(true)
  const local = { operationId: 'local-limit', bindingId: f.input.bindingId, expectedBindingRevision: 1, grantId: 'local-member', expectedRevision: null, actor: f.actor, state: 'active' as const, capabilities: ['answer' as const] }
  const limited = await f.sdk.call('connection.grant', local)
  expect(limited.state).toBe('applied')
  expect((await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })).access![0]!.effective).toMatchObject({ capabilities: ['answer'], source: { kind: 'room', grantId: 'local-member' } })
  const revoked = await f.sdk.call('connection.grant', { ...local, operationId: 'local-revoke', expectedRevision: 1, state: 'revoked' })
  expect(revoked.state).toBe('applied')
  expect((await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })).access![0]!.effective).toMatchObject({ state: 'revoked', source: { kind: 'room', revision: 2 } })
  const inherited = await f.cli(['binding', 'member', 'inherit'], { operationId: 'inherit-original', bindingId: f.input.bindingId, expectedBindingRevision: 1, actor: f.actor, expectedGrant: { grantId: 'local-member', revision: 2 } })
  expect(inherited).toMatchObject({ action: 'inherit', state: 'applied', inherited: { actor: f.actor, grants: [{ grantId: 'local-member', revision: 2 }] } })
  const current = await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })
  expect(current.access![0]!.local).toEqual({ kind: 'none', previousDecision: true })
  expect(current.access![0]!.effective?.source).toEqual({ kind: 'application', grantId: 'app-member', revision: 1 })
  expect((await f.sdk.call('connection.binding.inspect', { operationId: 'local-revoke' })).operation).toEqual(revoked)
  expect((await f.sdk.call('connection.binding.inspect', { operationId: 'inherit-original' })).operation).toEqual(inherited)
  const reopened = new ConnectionHost({ databasePath: join(f.root, 'connections.sqlite'), secrets: { resolve: async () => null } }); cleanup.push(() => reopened.close())
  expect((await reopened.applicationAccess.inspect({ operationId: f.intent.operationId })).operation).toEqual(saved.operation)
  expect((await reopened.applicationAccess.get({ connectionId: 'alias' })).grants).toEqual([saved.operation.grant])
  expect(dispatch).toHaveBeenCalledOnce(); await f.unchanged()
}, 20_000)

it('application access confines scope, actor, revision, original operation authority and unchanged room codec', async () => {
  const f = await fixture(); const first = await f.sdk.call('connection.application.access.configure', f.intent)
  expect(first.state).toBe('applied')
  expect(await f.sdk.call('connection.application.access.configure', { ...f.intent, operationId: 'stale-app', expectedRevision: 8 })).toMatchObject({ state: 'refused', code: 'APPLICATION_ACCESS_REVISION_CONFLICT' })
  expect(await f.sdk.call('connection.application.access.configure', { ...f.intent, operationId: 'stale-config', expectedConnectionRevision: 2, expectedRevision: 1 })).toMatchObject({ state: 'refused', code: 'APPLICATION_ACCESS_CONNECTION_REVISED' })
  await expect(f.sdk.call('connection.application.access.configure', { ...f.intent, capabilities: [] })).rejects.toMatchObject({ code: 'APPLICATION_ACCESS_OPERATION_CONFLICT' })
  await expect(f.connections.applicationAccess.configure({ ...f.intent, operationId: 'agent-forged' }, { actor: { kind: 'agent', id: 'agent' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.connections.applicationAccess.configure({ ...f.intent, operationId: 'lost-user' }, { ...context, assertCurrent: () => { throw new AgentMuxError('Revoked', 'CONTROL_PERMISSION_DENIED') } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.connections.applicationAccess.inspect({ operationId: 'lost-user' })).operation).toBeNull()
  await f.connections.configure({ operationId: 'other', expectedRevision: null, connection: { ...config, connectionId: 'other', application: { ...config.application, appId: 'other-app' } } })
  expect((await f.sdk.call('connection.application.access.get', { connectionId: 'other' })).grants).toEqual([])
  expect((await f.sdk.call('connection.application.access.get', { connectionId: config.connectionId, actor: { ...f.actor, idType: 'union_id' } })).grants).toEqual([])
  const separate = new ConnectionHost({ databasePath: ':memory:', secrets: { resolve: async () => null } }); cleanup.push(() => separate.close())
  await separate.configure({ operationId: 'same-alias-other-host', expectedRevision: null, connection: config })
  expect((await separate.applicationAccess.get({ connectionId: config.connectionId })).grants).toEqual([])
  const raw = { kind: 'external-action', connectionId: config.connectionId, actor: f.actor, externalConversationId: 'room', sourceMessageId: 'message', actionRef: 'action', bindingId: 'binding', bindingRevision: 1, grantId: 'g', grantRevision: 1 }
  expect(parseAgentExternalInteractionAuthor(raw)).toEqual(raw)
  expect(parseAgentExternalInteractionAuthor({ ...raw, grantSource: 'application' })).toMatchObject({ grantSource: 'application' })
  expect(() => parseAgentExternalInteractionAuthor({ ...raw, grantSource: 'anything' })).toThrow()
  expect(() => parseConnectionResult('connection.application.access.get', { connectionId: config.connectionId, connectionRevision: 1, adapterId: 'foreign', application: config.application, grants: first.state === 'applied' ? [first.grant] : [] }, { connectionId: config.connectionId })).toThrow()
  await f.unchanged()
})

it.each(['active', 'revoked'] as const)('application access preserves stale same-subject %s heads until explicit inheritance without reviving history', async state => {
  const f = await fixture(); await f.sdk.call('connection.application.access.configure', f.intent); await f.sdk.call('connection.bind', f.input)
  const local = await f.sdk.call('connection.grant', { operationId: 'old-local', bindingId: f.input.bindingId, expectedBindingRevision: 1, grantId: 'old-member', expectedRevision: null, actor: f.actor, capabilities: ['input'], state })
  // Restore a real old-format head whose Binding revision changed before continuity was fixed.
  const legacy = { ...f.bindings.readCurrent(f.input.bindingId)!, revision: 2, scope: { input: 'all-messages', publication: f.input.scope.publication } }
  f.connections.database.prepare('INSERT INTO room_binding_revision VALUES (?,?,?)').run(legacy.bindingId, 2, JSON.stringify(legacy))
  f.connections.database.prepare('UPDATE room_binding_head SET revision=2 WHERE binding_id=?').run(legacy.bindingId)
  const read = await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })
  expect(read.grants).toEqual([])
  expect(read.access![0]!.local).toMatchObject({ kind: 'review-required', grant: { state, bindingRevision: 1 } })
  expect(state === 'active' ? read.access![0]!.effective : read.access![0]!.effective?.state).toBe(state === 'active' ? null : 'revoked')
  expect((await f.sdk.call('connection.binding.member.inherit', { operationId: 'old-inherit', bindingId: f.input.bindingId, expectedBindingRevision: 1, actor: f.actor, expectedGrant: { grantId: 'old-member', revision: 1 } })).state).toBe('refused')
  expect((await f.sdk.call('connection.binding.member.inherit', { operationId: 'now-inherit', bindingId: f.input.bindingId, expectedBindingRevision: 2, actor: f.actor, expectedGrant: { grantId: 'old-member', revision: 1 } })).state).toBe('applied')
  const inherited = await f.sdk.call('connection.binding.inspect', { bindingId: f.input.bindingId })
  expect(inherited.access![0]!.local).toEqual({ kind: 'none', previousDecision: true })
  expect(inherited.access![0]!.effective?.source.kind).toBe('application')
  expect((await f.sdk.call('connection.binding.inspect', { operationId: 'old-local' })).operation).toEqual(local)
})

it('application access public managed caller cannot acquire application administration', async () => {
  const f = await fixture(true), managed = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'access.sock') }, credentials: f.caller! }); cleanup.push(() => managed.dispose())
  await expect(managed.call('connection.application.access.configure', f.intent)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(managed.call('connection.application.access.get', { connectionId: config.connectionId })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(managed.call('connection.application.access.inspect', { operationId: 'app-allow' })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.sdk.call('connection.application.access.inspect', { operationId: 'app-allow' })).operation).toBeNull()
})

it('application access reaches original durable message admission and rejects a new local revoke before the Core effect', async () => {
  const { ingressFixture } = await import('./fixtures/ingress.js')
  const f = await ingressFixture(false); cleanup.push(f.close)
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'acl.sock'), connections: f.connections, spatialState: f.spatial, coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'acl.sock') } }); cleanup.push(() => sdk.dispose())
  const app = await sdk.call('connection.application.access.configure', { operationId: 'message-app', connectionId: config.connectionId, expectedConnectionRevision: 1, grantId: 'message-rule', expectedRevision: null, actor: f.actor, state: 'active', capabilities: ['input'] })
  expect(app.state).toBe('applied')
  expect((await sdk.call('connection.binding.member.inherit', { operationId: 'message-inherit', bindingId: f.input.bindingId, expectedBindingRevision: 1, actor: f.actor, expectedGrant: { grantId: f.grant.grantId, revision: 1 } })).state).toBe('applied')
  const first = await f.receive()
  const admitted = await f.ingress.dispatch(first.ingress.ingressId)
  expect(admitted.ingress!.input!.author).toMatchObject({ grantSource: 'application', grantId: 'message-rule', grantRevision: 1 })
  expect(admitted.inputReceipt).toMatchObject({ originalControlOperationId: admitted.ingress!.input!.operationId, status: 'waiting' })
  const original = f.client.submitAgentMessage.bind(f.client)
  let captured: Parameters<typeof original>[0] | undefined, release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const submit = vi.spyOn(f.client, 'submitAgentMessage').mockImplementation(async (input, ctx) => { captured = input; await hold; return await original(input, ctx) })
  const later = await f.receive({ eventId: 'later-revoked-event', messageId: 'later-revoked-message' })
  const work = f.ingress.dispatch(later.ingress.ingressId)
  try {
    await vi.waitFor(() => expect(captured).toBeDefined())
    expect((await sdk.call('connection.grant', { ...f.grant, operationId: 'interleaved-local-revoke', expectedRevision: 1, state: 'revoked', capabilities: [] })).state).toBe('applied')
  } finally { release() }
  const refused = await work
  expect(refused.inputReceipt?.status).not.toBe('waiting')
  expect((await sdk.call('connection.application.access.inspect', { operationId: 'message-app' })).operation).toEqual(app)
  expect((await f.ingress.authority({ operationId: refused.ingress!.input!.operationId })).authority).toBe('refused')
  const frozen = refused.ingress!.input
  await f.ingress.dispatch(later.ingress.ingressId)
  expect((await f.ingress.inspect({ ingressId: later.ingress.ingressId })).ingress!.input).toEqual(frozen)
  expect(submit).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 20_000)
