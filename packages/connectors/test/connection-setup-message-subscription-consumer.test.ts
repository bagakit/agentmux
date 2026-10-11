import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, AgentMuxError } from '@agentmux/core'
import type { ConnectionSetupAction, ConnectionSetupAdvance, ConnectionSetupBegin, ConnectionSetupConfigurationEffect, ConnectionSetupView } from '@agentmux/core/connections'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'

const APP = 'cli_message_reception_original', effect = 'add-message-reception' as const
const EVENT = 'im.message.receive_v1'
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of clean.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Message reception consumer cleanup failed')
})
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const offered = [...view.continuation?.actions ?? [], ...view.applicationInspection?.actions ?? [], ...view.applicationConfiguration?.actions ?? []].find(a => a.kind === kind)
  expect(offered, kind).toBeDefined()
  return { operationId: view.operation!.operationId, expectedRevision: offered!.expectedRevision, decision: { actionId: offered!.actionId, value: kind === 'confirm-account' || kind === 'enable-messaging' || kind === 'use-persistent-connection' || kind === effect ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'message-reception-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock')
  const services = await createDesktopConnections({ directory, encryption: enrollmentEncryption() })
  const server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Message reception cannot borrow an Agent Runtime') } })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  let closed = false
  const close = async () => { if (closed) return; closed = true; sdk.dispose(); await server.stop(); services.close() }
  clean.push(() => rm(root, { recursive: true, force: true }), close)
  const native: Array<{ path: string; body: unknown }> = []
  let accepted = true
  let catalog: unknown = { events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }] }] }, settings: unknown = { eventMode: 4, appEventDetails: [], userEventDetails: [{ items: [{ id: EVENT }] }], eventDetails: [{ items: [{ id: EVENT }] }] }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)); native.push({ path: target.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'message-reception-private-token' } } }, { headers: { 'x-flow-key': 'message-reception-private-flow', 'set-cookie': 'session=message-reception-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text does not supply an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"message-reception-user","tenantId":"message-reception-enterprise"};window.csrfToken="message-reception-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('message-reception-private-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=message-reception-private-cookie')
    if (target.pathname === '/developers/v1/event/all/' + APP) return Response.json({ code: 0, data: catalog })
    if (target.pathname === '/developers/v1/event/' + APP) return Response.json({ code: 0, data: settings })
    if (target.pathname === '/developers/v1/event/update/' + APP) {
      expect(init?.method).toBe('POST'); expect(new Headers(init?.headers).get('X-AppPlatform-RequestFrom')).toBeNull()
      return accepted ? Response.json({ code: 0, data: { receipt: 'message-reception-private-result' } }) : new Response('Unconfirmed', { status: 502 })
    }
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: false } })
    if (target.pathname === '/developers/v1/event/switch/' + APP || target.pathname === '/developers/v1/robot/switch/' + APP) return accepted ? Response.json({ code: 0, data: { receipt: 'message-reception-private-result' } }) : new Response('Unconfirmed', { status: 502 })
    throw Error('Unexpected event transport native request')
  }))
  const credential = await services.secrets.store({ operationId: 'message-reception-credential', secret: 'message-reception-private-secret' })
  const saved = await sdk.call('connection.configure', { operationId: 'message-reception-save', expectedRevision: null, connection: { connectionId: 'message-reception-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Message reception bot', enabled: false, credentialRef: credential.credentialRef } })
  const input: ConnectionSetupBegin = { operationId: 'message-reception-management', connectionId: saved.connection.config.connectionId, expectedConnectionRevision: saved.connection.revision, goal: { kind: 'agent-conversation', interaction: 'messages' } } as const
  const confirm = async (original = input) => {
  let view = await sdk.call('connection.setup.begin', original)
  for (let i = 0; i < 8 && view.continuation?.stage !== 'account'; i++) view = await sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  view = await sdk.call('connection.setup.advance', action(view, 'confirm-account'))
  expect(view.continuation?.stage).toBe('confirmed'); return view
  }
  await confirm()
  const inspect = (selectedEffect: Exclude<ConnectionSetupConfigurationEffect, 'add-application-permissions'> = effect, operationId: string = input.operationId) => sdk.call('connection.setup.inspect', { operationId, applicationInspection: {}, applicationConfiguration: { effect: selectedEffect } })
  const read = async (subject: 'event-catalog' | 'bot-settings' | 'event-settings', operationId: string = input.operationId) => {
    const view = await sdk.call('connection.setup.inspect', { operationId, applicationInspection: {} })
    return sdk.call('connection.setup.advance', action(view, ('read-' + subject) as ConnectionSetupAction['kind']))
  }
  const cli = async (args: string[], input?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { root, directory, services, sdk, native, saved, input, inspect, read, cli, confirm, close, catalog: (value: unknown) => { catalog = value }, settings: (value: unknown) => { settings = value }, accept: (value: boolean) => { accepted = value } }
}

it('SDK and compiled CLI add only the exact App message event while carrying the original persistent delivery mode', async () => {
  const f = await fixture()
  const catalog = (await f.read('event-catalog')).applicationInspection!.selected!
  const settings = (await f.read('event-settings')).applicationInspection!.selected!
  const before = [...f.native]
  const offered = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect])
  expect(offered.applicationConfiguration).toMatchObject({ effect, subject: 'event-settings', sources: { catalog, settings }, review: { reception: 'missing', transport: 'persistent-connection' }, capability: 'disabled', selected: null })
  expect(f.native).toEqual(before)
  const input = action(offered, effect), accepted = await f.cli(['advance', '--input', '-'], input)
  expect(accepted.applicationConfiguration!.selected).toEqual({ effect, stepId: accepted.receipt!.stepId, input, request: 'confirmed', secureStorage: 'stored', sourceStepIds: { catalog: catalog.stepId, settings: settings.stepId }, transport: 'persistent-connection' })
  expect(f.native.slice(before.length)).toEqual([{ path: '/developers/v1/event/update/' + APP, body: { events: [], appEvents: [EVENT], userEvents: [], operation: 'add', eventMode: 4 } }])
  expect(await f.sdk.call('connection.setup.advance', input)).toEqual(accepted)
  expect(f.native.slice(before.length)).toHaveLength(1)
  expect(accepted.applicationConfiguration!.capability).toBe('unknown')
  f.settings({ eventMode: 4, appEventDetails: [{ items: [{ id: EVENT }] }] }); await f.read('event-settings')
  expect((await f.inspect()).applicationConfiguration).toMatchObject({ capability: 'enabled', review: { reception: 'subscribed' }, actions: [] })
  expect((await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection).toEqual(f.saved.connection)
}, 30_000)

it('already configured App membership is zero-write and user or generic event buckets never stand in for the App bucket', async () => {
  const f = await fixture(); await f.read('event-catalog')
  for (const [settings, capability] of [
    [{ eventMode: 4, appEventDetails: [{ items: [{ id: EVENT }] }] }, 'enabled'],
    [{ eventMode: 4, userEventDetails: [{ items: [{ id: EVENT }] }], eventDetails: [] }, 'unknown'],
    [{ eventMode: 4, appEventDetails: [], userEventDetails: [{ items: [{ id: EVENT }] }] }, 'disabled']
  ] as const) {
    f.settings(settings); await f.read('event-settings')
    expect((await f.inspect()).applicationConfiguration!.capability).toBe(capability)
  }
  expect(f.native.filter(call => call.path.includes('/update/'))).toEqual([])
}, 30_000)

it('only the unique exact App catalog ID and known current persistent mode qualify; aliases and incomplete structures stay unknown', async () => {
  const f = await fixture()
  for (const [catalog, settings, capability, offers] of [
    [{ events: [{ items: [{ id: 'different-id', eventTypes: [EVENT], name: EVENT, supportIdentityTypes: [2] }] }] }, { eventMode: 4, appEventDetails: [] }, 'unknown', 0],
    [{ events: [{ items: [{ id: EVENT, supportIdentityTypes: [1] }] }] }, { eventMode: 4, appEventDetails: [] }, 'unknown', 0],
    [{ events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }, { id: EVENT, supportIdentityTypes: [2] }] }] }, { eventMode: 4, appEventDetails: [] }, 'unknown', 0],
    [{ events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }] }] }, { eventMode: 4, appEventDetails: [{ items: [null] }] }, 'unknown', 0],
    [{ events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }] }] }, { eventMode: '4', appEventDetails: [] }, 'disabled', 0],
    [{ events: [{ items: [{ id: EVENT, supportIdentityTypes: [2] }] }] }, { eventMode: 1, appEventDetails: [] }, 'disabled', 0],
    [{ events: [{ items: [{ id: EVENT, supportIdentityTypes: [1] }, { id: EVENT, supportIdentityTypes: [2] }] }] }, { eventMode: 4, appEventDetails: [] }, 'disabled', 1]
  ] as const) {
    f.catalog(catalog); f.settings(settings); await f.read('event-catalog'); await f.read('event-settings')
    const configuration = (await f.inspect()).applicationConfiguration!
    expect(configuration.capability).toBe(capability)
    expect(configuration.actions.filter(a => a.kind === effect)).toHaveLength(offers)
  }
  expect(f.native.filter(call => call.path.includes('/update/') || call.path.includes('/switch/'))).toEqual([])
}, 30_000)

it('an unknown original mode claim requires a fresh settings read, then permits a distinct explicit add carrying compatible4 without retrying or ACKing that switch', async () => {
  const f = await fixture(); f.settings({ eventMode: 1, appEventDetails: [] })
  await f.read('event-settings'); await f.read('event-catalog')
  const switchInput = action(await f.inspect('use-persistent-connection'), 'use-persistent-connection')
  f.accept(false)
  const original = (await f.sdk.call('connection.setup.advance', switchInput)).applicationConfiguration!.selected!
  expect(original).toMatchObject({ effect: 'use-persistent-connection', request: 'unknown' })
  await f.read('event-catalog')
  expect((await f.inspect()).applicationConfiguration).toMatchObject({ capability: 'unknown', review: null, actions: [] })
  f.settings({ eventMode: 4, appEventDetails: [] }); await f.read('event-settings'); f.accept(true)
  const offered = await f.inspect(), addInput = action(offered, effect)
  const accepted = await f.sdk.call('connection.setup.advance', addInput)
  expect(accepted.applicationConfiguration!.selected).toMatchObject({ effect, request: 'confirmed', secureStorage: 'stored' })
  expect((await f.inspect('use-persistent-connection')).applicationConfiguration!.selected).toEqual(original)
  expect((await f.sdk.call('connection.setup.advance', switchInput)).applicationConfiguration!.selected).toEqual(original)
  expect(f.native.filter(call => call.path.includes('/switch/') || call.path.includes('/update/'))).toEqual([
    { path: '/developers/v1/event/switch/' + APP, body: { eventMode: 4 } },
    { path: '/developers/v1/event/update/' + APP, body: { events: [], appEvents: [EVENT], userEvents: [], operation: 'add', eventMode: 4 } }
  ])
}, 30_000)

it('an event-add claim also invalidates old mode settings; catalog-only refresh cannot revive it or block independent mode and bot intents', async () => {
  const f = await fixture(); await f.read('event-settings'); await f.read('event-catalog')
  f.accept(false)
  const original = (await f.sdk.call('connection.setup.advance', action(await f.inspect(), effect))).applicationConfiguration!.selected!
  await f.read('event-catalog')
  expect((await f.inspect('use-persistent-connection')).applicationConfiguration).toMatchObject({ capability: 'unknown', actions: [] })
  f.settings({ eventMode: 1, appEventDetails: [] }); await f.read('event-settings'); f.accept(true)
  const transport = await f.sdk.call('connection.setup.advance', action(await f.inspect('use-persistent-connection'), 'use-persistent-connection'))
  expect(transport.applicationConfiguration!.selected).toMatchObject({ effect: 'use-persistent-connection', request: 'confirmed' })
  await f.read('bot-settings')
  expect((await f.sdk.call('connection.setup.advance', action(await f.inspect('enable-messaging'), 'enable-messaging'))).applicationConfiguration!.selected).toMatchObject({ effect: 'enable-messaging', request: 'confirmed' })
  expect((await f.inspect()).applicationConfiguration!.selected).toEqual(original)
  expect(f.native.filter(call => call.path.includes('/update/'))).toHaveLength(1)
}, 30_000)

it.each(['catalog', 'settings', 'target', 'actor'] as const)('a %s change during a private source yield refuses only the uncommitted message addition', async change => {
  const f = await fixture(); const catalog = (await f.read('event-catalog')).applicationInspection!.selected!, settings = (await f.read('event-settings')).applicationInspection!.selected!
  const input = action(await f.inspect(), effect), db = f.services.database!
  const source = change === 'settings' ? settings : catalog
  const ref = db.prepare('SELECT private_ref FROM connection_setup_inspection WHERE step_id=?').get(source.stepId)!.private_ref
  const actor = JSON.parse(String(db.prepare('SELECT actor_json FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!.actor_json))
  let entered!: () => void, release!: () => void, held = false, authorized = true
  const waiting = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done }), resolve = DesktopConnectorSecrets.prototype.resolve
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function (current) {
    const value = await resolve.call(this, current)
    if (!held && current === ref) { held = true; entered(); await gate }
    return value
  })
  const pending = f.services.connections.setup!.advance(input, { actor, assertCurrent: () => { if (!authorized) throw new AgentMuxError('The current actor is no longer authorized', 'CONTROL_PERMISSION_DENIED') } }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  try {
    await waiting
    if (change === 'catalog' || change === 'settings') await f.read(change === 'catalog' ? 'event-catalog' : 'event-settings')
    else if (change === 'target') await f.sdk.call('connection.configure', { operationId: 'message-reception-target-revised', expectedRevision: f.saved.connection.revision, connection: { ...f.saved.connection.config, label: 'Revised reception target' } })
    else authorized = false
  } finally { release() }
  expect((await pending).error?.code).toBe(change === 'actor' ? 'CONTROL_PERMISSION_DENIED' : 'CONNECTION_SETUP_ACTION_STALE')
  expect(f.native.filter(call => call.path.includes('/update/'))).toEqual([])
  expect(db.prepare("SELECT count(*) AS count FROM connection_setup_inspection WHERE json_extract(record_json,'$.effect')='add-message-reception'").get()!.count).toBe(0)
}, 30_000)

function childMessage(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => { if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) { child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>) } }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Message reception owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each(['native-inflight', 'stored-ack'] as const)('a true %s writer exit preserves the same reception child and independent reader recovery without current adapter or replay', async mode => {
  const f = await fixture(); await f.read('event-catalog'); await f.read('event-settings')
  const offered = await f.inspect(), input = action(offered, effect)
  await f.close()
  const start = async (mode: string) => {
    const child = fork(new URL('./fixtures/connection-setup-message-subscription-owner.mjs', import.meta.url), [f.directory, mode], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
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
  const original = (await cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect])).applicationConfiguration!.selected!
  expect(original).toMatchObject({ effect, input, sourceStepIds: offered.applicationConfiguration!.effect === effect ? offered.applicationConfiguration.sources && { catalog: offered.applicationConfiguration.sources.catalog!.stepId, settings: offered.applicationConfiguration.sources.settings!.stepId } : null, transport: 'persistent-connection' })
  writer.kill('SIGKILL'); await once(writer, 'exit'); expect((await pending).code).not.toBe(0)
  const native = await readFile(join(f.directory, 'message-writes.ndjson'), 'utf8')
  await start('recover')
  const local = await cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--configuration-step', original.stepId])
  expect(local.applicationConfiguration!.capability).toBe('unknown')
  const resumed = await cli(['advance', '--input', '-'], mode === 'stored-ack' ? action(local, 'recover-configuration-effect') : input)
  expect(resumed.applicationConfiguration!.selected).toEqual({ ...original, request: mode === 'stored-ack' ? 'confirmed' : 'unknown', secureStorage: mode === 'stored-ack' ? 'stored' : 'not-started' })
  expect((await cli(['advance', '--input', '-'], input)).applicationConfiguration!.selected).toEqual(resumed.applicationConfiguration!.selected)
  expect(await readFile(join(f.directory, 'message-writes.ndjson'), 'utf8')).toBe(native)
  expect(native.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ path: '/developers/v1/event/update/' + APP, body: { events: [], appEvents: [EVENT], userEvents: [], operation: 'add', eventMode: 4 } }])
}, 30_000)


it('SDK and compiled CLI reject wrong effect, subject or selected-child wire relations while exact selection remains local and usable', async () => {
  const f = await fixture(); await f.read('event-catalog'); const settings = (await f.read('event-settings')).applicationInspection!.selected!
  const accepted = await f.sdk.call('connection.setup.advance', action(await f.inspect(), effect)), selected = accepted.applicationConfiguration!.selected!
  const before = [...f.native], path = join(f.root, 'wire.sock'), sockets = new Set<Socket>()
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
  const input = { operationId: f.input.operationId, applicationConfiguration: { effect, selectedStepId: selected.stepId } }
  const valid = await sdk.call('connection.setup.inspect', input)
  const faults: Array<(value: ConnectionSetupView) => unknown> = [
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, effect: 'enable-messaging' } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, subject: 'bot-settings' } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, sources: { ...(value.applicationConfiguration!.effect === effect ? value.applicationConfiguration.sources : {}), settings: { ...settings, subject: 'bot-settings' } } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, effects: [], selected: { ...value.applicationConfiguration!.selected!, transport: 'webhook' } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, effects: [], selected: { ...value.applicationConfiguration!.selected!, effect: 'enable-messaging' } } }),
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, effects: [], selected: { ...value.applicationConfiguration!.selected!, stepId: 'another-selected-child' } } })
  ]
  for (const fault of faults) {
    corrupt = fault
    await expect(sdk.call('connection.setup.inspect', input)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + path, 'connection', 'setup', 'inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--configuration-step', selected.stepId], objectCliEnvironment(f.root))
    expect(cli.code).not.toBe(0); expect(cli.stdout + cli.stderr).toContain('CONTROL_PROTOCOL_ERROR')
  }
  corrupt = value => value
  expect(await sdk.call('connection.setup.inspect', input)).toEqual(valid)
  const other = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationConfiguration: { effect: 'enable-messaging', selectedStepId: selected.stepId } })
  expect(other.applicationConfiguration!.selected).toBeNull(); expect(other.applicationConfiguration!.effect).toBe('enable-messaging')
  expect(f.native).toEqual(before)
}, 30_000)


it('an unknown event addition never renews or aliases into another write and a fresh read cannot ACK the original result', async () => {
  const f = await fixture(); await f.read('event-catalog'); await f.read('event-settings')
  const input = action(await f.inspect(), effect); f.accept(false)
  const original = (await f.sdk.call('connection.setup.advance', input)).applicationConfiguration!.selected!
  await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
  await f.confirm(); await f.read('event-catalog'); await f.read('event-settings')
  const renewed = await f.inspect()
  expect(renewed.applicationConfiguration).toMatchObject({ reason: 'original-effect-unconfirmed', actions: [], unresolved: { stepId: original.stepId } })
  const alias = await f.sdk.call('connection.configure', { operationId: 'reception-alias-save', expectedRevision: null, connection: { ...f.saved.connection.config, connectionId: 'reception-alias' } })
  const aliasInput = { ...f.input, operationId: 'reception-alias-management', connectionId: alias.connection.config.connectionId }
  await f.confirm(aliasInput); await f.read('event-catalog', aliasInput.operationId)
  f.settings({ eventMode: 4, appEventDetails: [{ items: [{ id: EVENT }] }] }); await f.read('event-settings', aliasInput.operationId)
  const other = await f.inspect(effect, aliasInput.operationId)
  expect(other.applicationConfiguration).toMatchObject({ capability: 'enabled', reason: 'original-effect-unconfirmed', actions: [], unresolved: { operationId: f.input.operationId, connectionId: f.input.connectionId, stepId: original.stepId } })
  expect((await f.sdk.call('connection.setup.advance', input)).applicationConfiguration!.selected).toEqual(original)
  expect(f.native.filter(call => call.path.includes('/update/'))).toHaveLength(1)
}, 30_000)
