import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, AgentMuxError } from '@agentmux/core'
import type { ConnectionSetupAction, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupConfigurationEffect, ConnectionSetupView } from '@agentmux/core/connections'
import { ConnectionSecrets } from '../src/connection-secrets.js'
import { createConnectionServices } from '../src/connection-services.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const APP = 'cli_permission_request_original', effect = 'add-application-permissions' as const
const NAMES = ['im:message:send_as_bot', 'im:message:readonly', 'im:message.group_msg', 'im:chat:create', 'im:chat:read', 'im:chat.members:read', 'im:chat.members:write_only', 'application:application:patch', 'application:application:self_manage', 'im:message.reactions:write_only']
const IDS = NAMES.map((_, index) => index % 2 ? String(100 + index) : 100 + index)
const REQUIRED_NAMES = [...NAMES.slice(0, 3), NAMES[9], ...NAMES.slice(3, 7), NAMES[8]]
const REQUIRED_IDS = [...IDS.slice(0, 3), IDS[9], ...IDS.slice(3, 7), IDS[8]]
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of clean.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Permission request consumer cleanup failed')
})
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const offered = [...view.continuation?.actions ?? [], ...view.applicationInspection?.actions ?? [], ...view.applicationConfiguration?.actions ?? []].find(a => a.kind === kind)
  expect(offered, kind).toBeDefined()
  return { operationId: view.operation!.operationId, expectedRevision: offered!.expectedRevision, decision: { actionId: offered!.actionId, value: kind === 'confirm-account' || kind === 'enable-messaging' || kind === 'use-persistent-connection' || kind === effect ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'permission-request-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock')
  const services = await createConnectionServices({ directory })
  const server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Permission request cannot borrow an Agent Runtime') } })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  let closed = false
  const close = async () => { if (closed) return; closed = true; sdk.dispose(); await server.stop(); services.close() }
  clean.push(() => rm(root, { recursive: true, force: true }), close)
  const native: Array<{ path: string; body: unknown }> = []
  let accepted = true
  let catalog: unknown = { scopes: NAMES.map((name, index) => ({ name, id: IDS[index], scopeType: [2] })) }, applied: unknown = { scopes: [] }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)); native.push({ path: target.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'permission-request-private-token' } } }, { headers: { 'x-flow-key': 'permission-request-private-flow', 'set-cookie': 'session=permission-request-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text does not supply an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"permission-request-user","tenantId":"permission-request-enterprise"};window.csrfToken="permission-request-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('permission-request-private-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=permission-request-private-cookie')
    if (target.pathname === '/developers/v1/scope/all/' + APP) return Response.json({ code: 0, data: catalog })
    if (target.pathname === '/developers/v1/scope/applied/' + APP) return Response.json({ code: 0, data: applied })
    if (target.pathname === '/developers/v1/event/' + APP) return Response.json({ code: 0, data: { eventMode: 1 } })
    if (target.pathname === '/developers/v1/scope/update/' + APP) {
      expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).get('X-AppPlatform-RequestFrom')).toBe('develop_panel')
      return accepted ? Response.json({ code: 0, data: { ScopeBaseMap: {}, needConfigurePrivilege: true } }) : new Response('Unconfirmed', { status: 502 })
    }
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: false } })
    if (target.pathname === '/developers/v1/event/switch/' + APP || target.pathname === '/developers/v1/robot/switch/' + APP) return accepted ? Response.json({ code: 0, data: { receipt: 'permission-request-private-result' } }) : new Response('Unconfirmed', { status: 502 })
    throw Error('Unexpected event transport native request')
  }))
  const credential = await services.secrets.store({ operationId: 'permission-request-credential', secret: 'permission-request-private-secret' })
  const saved = await sdk.call('connection.configure', { operationId: 'permission-request-save', expectedRevision: null, connection: { connectionId: 'permission-request-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Permission request bot', enabled: false, credentialRef: credential.credentialRef } })
  const input: ConnectionSetupBegin = { operationId: 'permission-request-management', connectionId: saved.connection.config.connectionId, expectedConnectionRevision: saved.connection.revision, goal: { kind: 'agent-conversation', interaction: 'messages' } } as const
  const confirm = async (original = input) => {
  let view = await sdk.call('connection.setup.begin', original)
  for (let i = 0; i < 8 && view.continuation?.stage !== 'account'; i++) view = await sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  view = await sdk.call('connection.setup.advance', action(view, 'confirm-account'))
  expect(view.continuation?.stage).toBe('confirmed'); return view
  }
  await confirm()
  const inspect = (purpose: 'agent-conversation' | 'mote-profile-sync' = 'agent-conversation', operationId: string = input.operationId) => sdk.call('connection.setup.inspect', { operationId, applicationInspection: {}, applicationConfiguration: { effect, purpose } })
  const read = async (subject: 'permission-catalog' | 'application-permissions' | 'bot-settings' | 'event-settings', operationId: string = input.operationId) => {
    const view = await sdk.call('connection.setup.inspect', { operationId, applicationInspection: {} })
    return sdk.call('connection.setup.advance', action(view, ('read-' + subject) as ConnectionSetupAction['kind']))
  }
  const cli = async (args: string[], input?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { root, directory, services, sdk, native, saved, input, inspect, read, cli, confirm, close, catalog: (value: unknown) => { catalog = value }, applied: (value: unknown) => { applied = value }, accept: (value: boolean) => { accepted = value } }
}

it('SDK and compiled CLI review exact App rows then request only missing original native IDs with one precise additive body', async () => {
  const f = await fixture()
  f.applied({ scopes: [{ id: IDS[0], scopeIdentityType: 2, status: 'not-a-grant' }, { id: IDS[1], scopeIdentityType: 1 }, { id: 101, scopeIdentityType: 2 }] })
  const catalog = (await f.read('permission-catalog')).applicationInspection!.selected!
  const beforeApplied = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {} })
  const applied = (await f.cli(['advance', '--input', '-'], action(beforeApplied, 'read-application-permissions'))).applicationInspection!.selected!
  const before = [...f.native]
  const offered = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--permission-purpose', 'agent-conversation'])
  const configuration = offered.applicationConfiguration!
  expect(configuration.effect).toBe(effect)
  if (configuration.effect !== effect) throw Error('Wrong permission result')
  expect(configuration.sources).toEqual({ catalog, applied })
  expect(configuration.review!.permissions).toEqual(REQUIRED_NAMES.map((name, index) => ({ name, group: index < 4 ? 'messages' : index < 8 ? 'groups' : 'identity', state: index === 0 ? 'requested' : 'missing' })))
  expect(f.native).toEqual(before)
  const input = action(offered, effect), accepted = await f.cli(['advance', '--input', '-'], input)
  expect(accepted.applicationConfiguration!.selected).toMatchObject({ effect, purpose: 'agent-conversation', sourceStepIds: { catalog: catalog.stepId, applied: applied.stepId }, scopeNames: REQUIRED_NAMES.slice(1), input, request: 'confirmed', secureStorage: 'stored', requiresDataRangeConfiguration: true })
  expect(f.native.slice(before.length)).toEqual([{ path: '/developers/v1/scope/update/' + APP, body: { clientId: APP, appScopeIDs: REQUIRED_IDS.slice(1), userScopeIDs: [], scopeIds: [], operation: 'add', isDeveloperPanel: true } }])
  expect(accepted.applicationConfiguration!.capability).toBe('unknown')
  expect(await f.sdk.call('connection.setup.advance', input)).toEqual(accepted)
  expect(f.native.slice(before.length)).toHaveLength(1)
  f.applied({ scopes: REQUIRED_IDS.map(id => ({ id, scopeIdentityType: 2 })) })
  await f.read('application-permissions')
  const current = await f.inspect()
  expect(current.applicationConfiguration!.capability).toBe('enabled')
  expect(current.applicationConfiguration!.actions).toEqual([])
  expect(current.applicationConfiguration).not.toHaveProperty('granted')
  expect((await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection).toEqual(f.saved.connection)
}, 30_000)

it('offers only conversation permissions and keeps retired Mote permission selection read-only', async () => {
  const f = await fixture(); await f.read('permission-catalog'); await f.read('application-permissions')
  const base = await f.inspect(), before = [...f.native], retired = await f.inspect('mote-profile-sync')
  expect('review' in base.applicationConfiguration! && base.applicationConfiguration.review!.permissions.map(p => p.name)).toEqual(REQUIRED_NAMES)
  expect(retired.applicationConfiguration).toMatchObject({capability:'unknown',review:null,actions:[]})
  expect(f.native).toEqual(before)
  await f.sdk.call('connection.setup.advance',action(base,effect))
  expect(f.native.at(-1)).toEqual({path:'/developers/v1/scope/update/'+APP,body:{clientId:APP,appScopeIDs:REQUIRED_IDS,userScopeIDs:[],scopeIds:[],operation:'add',isDeveloperPanel:true}})
},30000)

it('an applied App row without a supported original id keeps the exact missing set unknown and offers no addition', async () => {
  const f = await fixture(); f.applied({ scopes: [{ scopeIdentityType: 2 }] })
  await f.read('permission-catalog'); await f.read('application-permissions')
  const view = await f.inspect()
  expect(view.applicationConfiguration).toMatchObject({ capability: 'unknown', review: { reason: 'applied-unconfirmed' }, actions: [] })
  expect(f.native.filter(call => call.path.includes('/scope/update/'))).toEqual([])
}, 30_000)

it('unsupported or ambiguous native catalog mappings remain named unknown without guessing another bucket or ID', async () => {
  const f = await fixture()
  for (const [id, reason] of [[null, 'unsupported-scope-id'], [true, 'unsupported-scope-id'], [{ value: 100 }, 'unsupported-scope-id'], [Number.MAX_SAFE_INTEGER + 1, 'unsupported-scope-id']] as const) {
    f.catalog({ scopes: NAMES.map((name, index) => ({ name, id: index === 0 ? id : IDS[index], scopeType: [2] })) })
    await f.read('permission-catalog'); await f.read('application-permissions')
    expect((await f.inspect()).applicationConfiguration).toMatchObject({ capability: 'unknown', review: { reason }, actions: [] })
  }
  f.catalog({ scopes: [...NAMES.map((name, index) => ({ name, id: IDS[index], scopeType: [2] })), { name: NAMES[0], id: 'other-id', scopeType: [2] }] })
  await f.read('permission-catalog')
  expect((await f.inspect()).applicationConfiguration).toMatchObject({ capability: 'unknown', review: { reason: 'scope-ambiguous' }, actions: [] })
  f.catalog({ scopes: NAMES.map((name, index) => ({ name, id: IDS[index], scopeType: index === 0 ? [1] : [2] })) })
  await f.read('permission-catalog')
  expect((await f.inspect()).applicationConfiguration).toMatchObject({ capability: 'unknown', review: { reason: 'scope-unavailable' }, actions: [] })
  expect(f.native.filter(call => call.path.includes('/scope/update/'))).toEqual([])
}, 30_000)

it('unknown permission additions cannot replay across purposes, renewal, new Setup or saved-app aliases and leave both scalar effects usable', async () => {
  const f = await fixture(); await f.read('permission-catalog'); await f.read('application-permissions')
  const input = action(await f.inspect(), effect); f.accept(false)
  const original = (await f.sdk.call('connection.setup.advance', input)).applicationConfiguration!.selected!
  expect(original.request).toBe('unknown'); f.accept(true)
  await f.read('application-permissions')
  expect((await f.inspect('mote-profile-sync')).applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', actions: [], unresolved: { stepId: original.stepId } })
  for (const [subject, scalar] of [['bot-settings', 'enable-messaging'], ['event-settings', 'use-persistent-connection']] as const) {
    await f.read(subject)
    const offered = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: scalar } })
    expect((await f.sdk.call('connection.setup.advance', action(offered, scalar))).applicationConfiguration!.selected).toMatchObject({ effect: scalar, request: 'confirmed', secureStorage: 'stored' })
  }
  await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
  await f.confirm(); await f.read('permission-catalog'); await f.read('application-permissions')
  expect((await f.inspect('mote-profile-sync')).applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', actions: [], unresolved: { stepId: original.stepId } })
  const another = { ...f.input, operationId: 'permission-request-another' }; await f.confirm(another)
  await f.read('permission-catalog', another.operationId); await f.read('application-permissions', another.operationId)
  expect((await f.inspect('mote-profile-sync', another.operationId)).applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', actions: [], unresolved: { stepId: original.stepId } })
  const alias = await f.sdk.call('connection.configure', { operationId: 'permission-request-alias-save', expectedRevision: null, connection: { ...f.saved.connection.config, connectionId: 'permission-request-alias' } })
  const aliasInput = { ...f.input, operationId: 'permission-request-alias-setup', connectionId: alias.connection.config.connectionId }; await f.confirm(aliasInput)
  await f.read('permission-catalog', aliasInput.operationId); await f.read('application-permissions', aliasInput.operationId)
  expect((await f.inspect('mote-profile-sync', aliasInput.operationId)).applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', actions: [], unresolved: { stepId: original.stepId, connectionId: f.input.connectionId } })
  expect((await f.sdk.call('connection.setup.advance', input)).applicationConfiguration!.selected).toEqual(original)
  expect(f.native.filter(call => call.path.includes('/scope/update/'))).toHaveLength(1)
}, 30_000)

it.each(['catalog', 'applied', 'actor', 'target'] as const)('a deferred private %s boundary cannot admit an obsolete permission addition', async change => {
  const f = await fixture(); await f.read('permission-catalog'); await f.read('application-permissions')
  const offered = await f.inspect(), input = action(offered, effect), configuration = offered.applicationConfiguration!
  if (configuration.effect !== effect) throw Error('Wrong permission result')
  const source = change === 'catalog' ? configuration.sources.catalog! : configuration.sources.applied!, db = f.services.database!
  const row = db.prepare('SELECT private_ref FROM connection_setup_inspection WHERE step_id=?').get(source.stepId)!
  const actor = JSON.parse(String(db.prepare('SELECT actor_json FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!.actor_json))
  let entered!: () => void, release!: () => void, held = false, authorized = true
  const waiting = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done }), resolve = ConnectionSecrets.prototype.resolve
  vi.spyOn(ConnectionSecrets.prototype, 'resolve').mockImplementation(async function (ref) {
    const value = await resolve.call(this, ref)
    if (!held && ref === row.private_ref) { held = true; entered(); await gate }
    return value
  })
  const pending = f.services.connections.setup!.advance(input, { actor, assertCurrent: () => { if (!authorized) throw new AgentMuxError('Current actor authority was revoked', 'CONTROL_PERMISSION_DENIED') } }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  try {
    await waiting
    if (change === 'catalog' || change === 'applied') await f.read(change === 'catalog' ? 'permission-catalog' : 'application-permissions')
    else if (change === 'target') await f.sdk.call('connection.configure', { operationId: 'permission-target-revised', expectedRevision: f.saved.connection.revision, connection: { ...f.saved.connection.config, label: 'Revised permission target' } })
    else authorized = false
  } finally { release() }
  const late = await pending
  expect(late.error?.code).toBe(change === 'actor' ? 'CONTROL_PERMISSION_DENIED' : 'CONNECTION_SETUP_ACTION_STALE')
  expect(f.native.filter(call => call.path.includes('/scope/update/'))).toEqual([])
  expect(db.prepare("SELECT count(*) AS count FROM connection_setup_inspection WHERE json_extract(record_json,'$.effect')=?").get(effect)!.count).toBe(0)
}, 30_000)

it('an explicitly User-only catalog row sharing an App id cannot close a qualified application permission review', async () => {
  const f = await fixture()
  f.catalog({ scopes: [...NAMES.map((name, index) => ({ name, id: IDS[index], scopeType: [2] })), { name: 'user-only-unrelated', id: IDS[0], scopeType: [1] }] })
  await f.read('permission-catalog'); await f.read('application-permissions')
  const view = await f.inspect()
  expect(view.applicationConfiguration).toMatchObject({ capability: 'disabled', review: { permissions: REQUIRED_NAMES.map((name, index) => ({ name, group: index < 3 ? 'messages' : index < 7 ? 'groups' : 'identity', state: 'missing' })) } })
  expect(view.applicationConfiguration!.actions.map(a => a.kind)).toEqual([effect])
}, 30_000)

it('never reopens retired SDK identity grants after fresh catalog or applied observations', async () => {
  const f = await fixture(); await f.read('permission-catalog'); await f.read('application-permissions')
  await f.sdk.call('connection.setup.advance',action(await f.inspect(),effect))
  f.applied({scopes:REQUIRED_IDS.map(id=>({id,scopeIdentityType:2}))})
  for(const subject of ['permission-catalog','application-permissions'] as const){await f.read(subject);expect((await f.inspect('mote-profile-sync')).applicationConfiguration).toMatchObject({capability:'unknown',review:null,actions:[]})}
  expect(f.native.filter(call=>call.path.includes('/scope/update/'))).toHaveLength(1)
},30000)

function childMessage(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => { if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) { child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>) } }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Permission request owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each(['native-inflight', 'stored-ack'] as const)('a true %s writer exit preserves the same permission child and independent reader recovery without current adapter or replay', async mode => {
  const f = await fixture(); await f.read('permission-catalog'); await f.read('application-permissions')
  const offered = await f.inspect(), input = action(offered, effect)
  await f.close()
  const start = async (mode: string) => {
    const child = fork(new URL('./fixtures/connection-setup-permission-request-owner.mjs', import.meta.url), [f.directory, mode], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', data => { errors += data })
    await childMessage(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return child
  }
  const writer = await start(mode), reached = childMessage(writer, mode === 'stored-ack' ? 'stored-ack' : 'native-dispatched')
  const cli = async (args: string[], input?: unknown) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + join(f.directory, 'owner.sock'), 'connection', 'setup', ...args], objectCliEnvironment(f.root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result as ConnectionSetupView
  }
  const pending = runCompiledObjectCli(['--endpoint', 'unix:' + join(f.directory, 'owner.sock'), 'connection', 'setup', 'advance', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(input))
  await reached
  const original = (await cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--permission-purpose', 'agent-conversation'])).applicationConfiguration!.selected!
  expect(original).toMatchObject({ effect, input, purpose: 'agent-conversation', scopeNames: REQUIRED_NAMES })
  writer.kill('SIGKILL'); await once(writer, 'exit'); expect((await pending).code).not.toBe(0)
  const native = await readFile(join(f.directory, 'permission-writes.ndjson'), 'utf8')
  await start('recover')
  const local = await cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--permission-purpose', 'agent-conversation', '--configuration-step', original.stepId])
  expect(local.applicationConfiguration!.capability).toBe('unknown')
  const resumed = await cli(['advance', '--input', '-'], mode === 'stored-ack' ? action(local, 'recover-configuration-effect') : input)
  expect(resumed.applicationConfiguration!.selected).toEqual({ ...original, request: mode === 'stored-ack' ? 'confirmed' : 'unknown', secureStorage: mode === 'stored-ack' ? 'stored' : 'not-started' })
  expect((await cli(['advance', '--input', '-'], input)).applicationConfiguration!.selected).toEqual(resumed.applicationConfiguration!.selected)
  expect(await readFile(join(f.directory, 'permission-writes.ndjson'), 'utf8')).toBe(native)
  expect(native.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ path: '/developers/v1/scope/update/' + APP, body: { clientId: APP, appScopeIDs: REQUIRED_IDS, userScopeIDs: [], scopeIds: [], operation: 'add', isDeveloperPanel: true } }])
}, 30_000)


it('SDK and compiled CLI reject wrong purpose, dual-source subject or mixed-purpose offered-action wire relations', async () => {
  const f = await fixture(); await f.read('permission-catalog'); await f.read('application-permissions')
  const offered = (await f.inspect()).applicationConfiguration!.actions.find(a => a.kind === effect)!
  const extension = {...offered,actionId:offered.actionId.replace('setup-permissions:agent-conversation:', 'setup-permissions:mote-profile-sync:')}
  const original = await f.inspect(), path = join(f.root, 'wire.sock'), sockets = new Set<Socket>()
  let corrupt = (value: ConnectionSetupView): unknown => value
  const wire = createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); let pending = ''
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      pending += chunk
      while (pending.includes('\n')) {
        const boundary = pending.indexOf('\n'), line = pending.slice(0, boundary); pending = pending.slice(boundary + 1)
        if (!line) continue
        const request = JSON.parse(line)
        void f.sdk.call(request.method, request.params).then(value => socket.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: corrupt(value as ConnectionSetupView) }) + '\n'))
      }
    })
  })
  await new Promise<void>((resolve, reject) => { wire.once('error', reject); wire.listen(path, resolve) })
  clean.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve())) })
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path } }); clean.push(() => sdk.dispose())
  const input = { operationId: f.input.operationId, applicationConfiguration: { effect, purpose: 'agent-conversation' as const } }
  const valid = await sdk.call('connection.setup.inspect', input)
  const faults: Array<(value: ConnectionSetupView) => unknown> = [
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, purpose: 'mote-profile-sync' } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, sources: { ...(value.applicationConfiguration!.effect === effect ? value.applicationConfiguration.sources : {}), catalog: { ...(value.applicationConfiguration!.effect === effect ? value.applicationConfiguration.sources.catalog : {}), subject: 'application-permissions' } } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, actions: [extension] } })
  ]
  for (const fault of faults) {
    corrupt = fault
    await expect(sdk.call('connection.setup.inspect', input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + path, 'connection', 'setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--permission-purpose', 'agent-conversation'], objectCliEnvironment(f.root))
    expect(cli.code).not.toBe(0); expect(cli.stdout + cli.stderr).toContain('CONTROL_PROTOCOL_ERROR')
  }
  corrupt = value => value
  expect(await sdk.call('connection.setup.inspect', input)).toEqual(valid)
  expect(valid.applicationConfiguration).toEqual(original.applicationConfiguration)
  expect(f.native.filter(call => call.path.includes('/scope/update/'))).toEqual([])
}, 30_000)
