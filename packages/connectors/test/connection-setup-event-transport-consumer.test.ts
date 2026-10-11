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

const APP = 'cli_event_transport_original', effect = 'use-persistent-connection' as const
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of clean.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (errors.length) throw new AggregateError(errors, 'Event transport consumer cleanup failed')
})
function action(view: ConnectionSetupView, kind: ConnectionSetupAction['kind']): ConnectionSetupAdvance {
  const offered = [...view.continuation?.actions ?? [], ...view.applicationInspection?.actions ?? [], ...view.applicationConfiguration?.actions ?? []].find(a => a.kind === kind)
  expect(offered, kind).toBeDefined()
  return { operationId: view.operation!.operationId, expectedRevision: offered!.expectedRevision, decision: { actionId: offered!.actionId, value: kind === 'confirm-account' || kind === 'enable-messaging' || kind === effect ? 'confirm' : kind === 'renew' ? 'renew' : 'continue' } }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'event-transport-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock')
  const services = await createDesktopConnections({ directory, encryption: enrollmentEncryption() })
  const server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Event transport cannot borrow an Agent Runtime') } })
  await server.start()
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
  let closed = false
  const close = async () => { if (closed) return; closed = true; sdk.dispose(); await server.stop(); services.close() }
  clean.push(() => rm(root, { recursive: true, force: true }), close)
  const native: Array<{ path: string; body: unknown }> = []
  let mode: unknown = 1, accepted = true
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url)); native.push({ path: target.pathname, body: JSON.parse(String(init?.body ?? '{}')) })
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'event-transport-private-token' } } }, { headers: { 'x-flow-key': 'event-transport-private-flow', 'set-cookie': 'session=event-transport-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing text does not supply an account')
    if (target.href === 'https://open.feishu.cn/app') return new Response('<script>window.user={"id":"event-transport-user","tenantId":"event-transport-enterprise"};window.csrfToken="event-transport-private-csrf";</script>', { headers: { 'content-type': 'text/html' } })
    expect(new Headers(init?.headers).get('x-csrf-token')).toBe('event-transport-private-csrf')
    expect(new Headers(init?.headers).get('cookie')).toContain('session=event-transport-private-cookie')
    if (target.pathname === '/developers/v1/event/' + APP) return Response.json({ code: 0, data: { eventMode: mode, events: ['unrelated-private-subscription'] } })
    if (target.pathname === '/developers/v1/robot/' + APP) return Response.json({ code: 0, data: { enable: false } })
    if (target.pathname === '/developers/v1/event/switch/' + APP || target.pathname === '/developers/v1/robot/switch/' + APP) return accepted ? Response.json({ code: 0, data: { receipt: 'event-transport-private-result' } }) : new Response('Unconfirmed', { status: 502 })
    throw Error('Unexpected event transport native request')
  }))
  const credential = await services.secrets.store({ operationId: 'event-transport-credential', secret: 'event-transport-private-secret' })
  const saved = await sdk.call('connection.configure', { operationId: 'event-transport-save', expectedRevision: null, connection: { connectionId: 'event-transport-bot', adapterId: 'feishu', application: { domain: 'open.feishu.cn', appId: APP }, label: 'Event transport bot', enabled: false, credentialRef: credential.credentialRef } })
  const input: ConnectionSetupBegin = { operationId: 'event-transport-management', connectionId: saved.connection.config.connectionId, expectedConnectionRevision: saved.connection.revision, goal: { kind: 'agent-conversation', interaction: 'messages' } } as const
  const confirm = async (original = input) => {
  let view = await sdk.call('connection.setup.begin', original)
  for (let i = 0; i < 8 && view.continuation?.stage !== 'account'; i++) view = await sdk.call('connection.setup.advance', action(view, 'continue'))
  expect(view.continuation?.stage).toBe('account')
  view = await sdk.call('connection.setup.advance', action(view, 'confirm-account'))
  expect(view.continuation?.stage).toBe('confirmed'); return view
  }
  await confirm()
  const inspect = (selectedEffect: ConnectionSetupConfigurationEffect = effect, operationId: string = input.operationId) => sdk.call('connection.setup.inspect', { operationId, applicationInspection: {}, applicationConfiguration: { effect: selectedEffect } })
  const read = async (subject: 'event' | 'bot' = 'event', operationId: string = input.operationId) => {
    const view = await sdk.call('connection.setup.inspect', { operationId, applicationInspection: {} })
    return sdk.call('connection.setup.advance', action(view, subject === 'event' ? 'read-event-settings' : 'read-bot-settings'))
  }
  const cli = async (args: string[], input?: unknown): Promise<ConnectionSetupView> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), input === undefined ? '' : JSON.stringify(input))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { root, directory, services, sdk, native, saved, input, inspect, read, cli, confirm, close, mode: (value: unknown) => { mode = value }, accept: (value: boolean) => { accepted = value } }
}

it('SDK and compiled CLI explicitly switch only the exact application event transport scalar and retain separate original read and acceptance', async () => {
  const f = await fixture(), read = await f.read(), source = read.applicationInspection!.selected!
  expect(read.applicationInspection!.readResult).toEqual({ subject: 'event-settings', transport: 'webhook' })
  const before = [...f.native]
  const offered = await f.cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect])
  expect(offered.applicationConfiguration).toMatchObject({ effect, subject: 'event-settings', source, capability: 'disabled', selected: null })
  expect(f.native).toEqual(before)
  const input = action(offered, effect), accepted = await f.cli(['advance', '--input', '-'], input)
  expect(accepted.applicationConfiguration!.selected).toMatchObject({ effect, sourceStepId: source.stepId, input, request: 'confirmed', secureStorage: 'stored' })
  expect(accepted.applicationConfiguration!.capability).not.toBe('enabled')
  expect(f.native.slice(before.length)).toEqual([{ path: '/developers/v1/event/switch/' + APP, body: { eventMode: 4 } }])
  expect(await f.sdk.call('connection.setup.advance', input)).toEqual(accepted)
  expect(f.native.slice(before.length)).toHaveLength(1)
  const originalRead = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: { selectedStepId: source.stepId } })
  expect(originalRead.applicationInspection!.readResult).toEqual({ subject: 'event-settings', transport: 'webhook' })
  f.mode(4); await f.read()
  const current = await f.inspect()
  expect(current.applicationConfiguration).toMatchObject({ effect, capability: 'enabled', actions: [] })
  expect(current.applicationConfiguration).not.toHaveProperty('ready')
  expect((await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection).toEqual(f.saved.connection)
}, 30_000)

it('only known non-persistent raw event modes qualify the effect and already-persistent observations never write', async () => {
  const f = await fixture()
  for (const [mode, capability] of [[1, 'disabled'], [2, 'disabled'], [3, 'disabled'], [4, 'enabled'], [0, 'unknown'], [5, 'unknown'], ['4', 'unknown'], [null, 'unknown']] as const) {
    f.mode(mode); await f.read()
    const view = await f.inspect()
    expect(view.applicationConfiguration!.capability).toBe(capability)
    expect(view.applicationConfiguration!.actions.filter(a => a.kind === effect)).toHaveLength(capability === 'disabled' ? 1 : 0)
  }
  expect(f.native.filter(call => call.path.includes('/switch/'))).toEqual([])
}, 30_000)

it('an unknown transport result cannot replay through renewal or a saved-app alias and leaves independent bot enabling available', async () => {
  const f = await fixture(); await f.read()
  const offered = await f.inspect(), originalInput = action(offered, effect)
  f.accept(false)
  const unknown = await f.sdk.call('connection.setup.advance', originalInput), original = unknown.applicationConfiguration!.selected!
  expect(original.request).toBe('unknown')
  expect((await f.inspect()).applicationConfiguration!.reason).toBe('original-effect-unconfirmed')
  await f.read('bot')
  const bot = await f.inspect('enable-messaging')
  f.accept(true)
  const enabled = await f.sdk.call('connection.setup.advance', action(bot, 'enable-messaging'))
  expect(enabled.applicationConfiguration!.selected).toMatchObject({ effect: 'enable-messaging', request: 'confirmed' })
  await f.sdk.call('connection.setup.advance', action(await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId }), 'renew'))
  await f.confirm(); await f.read()
  const renewed = await f.inspect()
  expect(renewed.applicationConfiguration!.actions.filter(a => a.kind === effect)).toEqual([])
  expect(renewed.applicationConfiguration!.unresolved!.stepId).toBe(original.stepId)
  const alias = await f.sdk.call('connection.configure', { operationId: 'event-transport-alias-save', expectedRevision: null, connection: { ...f.saved.connection.config, connectionId: 'event-transport-alias' } })
  const aliasInput = { ...f.input, operationId: 'event-transport-alias-management', connectionId: alias.connection.config.connectionId }
  await f.confirm(aliasInput); await f.read('event', aliasInput.operationId)
  const other = await f.inspect(effect, aliasInput.operationId)
  expect(other.applicationConfiguration!.actions.filter(a => a.kind === effect)).toEqual([])
  expect(other.applicationConfiguration!.unresolved).toEqual({ operationId: f.input.operationId, connectionId: f.input.connectionId, stepId: original.stepId })
  f.mode(4); await f.read('event', aliasInput.operationId)
  expect((await f.inspect(effect, aliasInput.operationId)).applicationConfiguration).toMatchObject({ capability: 'enabled', reason: 'original-effect-unconfirmed' })
  expect((await f.sdk.call('connection.setup.advance', originalInput)).applicationConfiguration!.selected).toEqual(original)
  expect(f.native.filter(call => call.path.startsWith('/developers/v1/event/switch/'))).toHaveLength(1)
  expect(f.native.filter(call => call.path.startsWith('/developers/v1/robot/switch/'))).toHaveLength(1)
}, 30_000)

it.each(['source', 'target', 'actor'] as const)('a %s change while the private source yields refuses only the new event transport write', async change => {
  const f = await fixture(), read = await f.read(), source = read.applicationInspection!.selected!
  const offered = await f.inspect(), input = action(offered, effect), db = f.services.database!
  const row = db.prepare('SELECT private_ref FROM connection_setup_inspection WHERE step_id=?').get(source.stepId)!
  const actor = JSON.parse(String(db.prepare('SELECT actor_json FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!.actor_json))
  let entered!: () => void, release!: () => void, held = false, authorized = true
  const waiting = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
  const resolve = DesktopConnectorSecrets.prototype.resolve
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function (ref) {
    const value = await resolve.call(this, ref)
    if (!held && ref === row.private_ref) { held = true; entered(); await gate }
    return value
  })
  const pending = f.services.connections.setup!.advance(input, { actor, assertCurrent: () => { if (!authorized) throw new AgentMuxError('Current actor authority was revoked', 'CONTROL_PERMISSION_DENIED') } }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  try {
    await waiting
    if (change === 'source') { f.mode(4); await f.read() }
    else if (change === 'target') await f.sdk.call('connection.configure', { operationId: 'event-target-revised', expectedRevision: f.saved.connection.revision, connection: { ...f.saved.connection.config, label: 'Revised event target' } })
    else authorized = false
  } finally { release() }
  const late = await pending
  expect(late.error?.code).toBe(change === 'actor' ? 'CONTROL_PERMISSION_DENIED' : 'CONNECTION_SETUP_ACTION_STALE')
  expect(f.native.filter(call => call.path.includes('/switch/'))).toEqual([])
  expect(db.prepare("SELECT count(*) AS count FROM connection_setup_inspection WHERE json_extract(record_json,'$.effect') IS NOT NULL").get()!.count).toBe(0)
}, 30_000)

function childMessage(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => { if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) { child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>) } }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Event transport owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it.each(['native-inflight', 'stored-ack'] as const)('a true %s writer exit preserves the same event child and independent reader recovery without current adapter or replay', async mode => {
  const f = await fixture(); await f.read()
  const offered = await f.inspect(), input = action(offered, effect)
  await f.close()
  const start = async (mode: string) => {
    const child = fork(new URL('./fixtures/connection-setup-event-transport-owner.mjs', import.meta.url), [f.directory, mode], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
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
  expect(original).toMatchObject({ effect, input, sourceStepId: offered.applicationConfiguration!.source!.stepId })
  writer.kill('SIGKILL'); await once(writer, 'exit'); expect((await pending).code).not.toBe(0)
  const native = await readFile(join(f.directory, 'event-writes.ndjson'), 'utf8')
  await start('recover')
  const local = await cli(['inspect', '--operation-id', f.input.operationId, '--application-configuration', effect, '--configuration-step', original.stepId])
  expect(local.applicationConfiguration!.capability).toBe('unknown')
  const resumed = await cli(['advance', '--input', '-'], mode === 'stored-ack' ? action(local, 'recover-configuration-effect') : input)
  expect(resumed.applicationConfiguration!.selected).toEqual({ ...original, request: mode === 'stored-ack' ? 'confirmed' : 'unknown', secureStorage: mode === 'stored-ack' ? 'stored' : 'not-started' })
  expect((await cli(['advance', '--input', '-'], input)).applicationConfiguration!.selected).toEqual(resumed.applicationConfiguration!.selected)
  expect(await readFile(join(f.directory, 'event-writes.ndjson'), 'utf8')).toBe(native)
  expect(native.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ path: '/developers/v1/event/switch/' + APP, body: { eventMode: 4 } }])
}, 30_000)

it('SDK and compiled CLI reject wrong effect, subject or selected-child wire relations while exact selection remains local and usable', async () => {
  const f = await fixture(); await f.read()
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
    value => ({ ...value, applicationConfiguration: { ...value.applicationConfiguration!, source: { ...value.applicationConfiguration!.source!, subject: 'bot-settings' } } }),
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

it('a known pre-dispatch authority refusal cannot become a permanent unknown write barrier', async () => {
  const f = await fixture(); await f.read()
  const input = action(await f.inspect(), effect), db = f.services.database!
  const actor = JSON.parse(String(db.prepare('SELECT actor_json FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!.actor_json))
  let entered!: () => void, release!: () => void, authorized = true
  const waiting = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
  const nativeWrites = () => f.native.filter(call => call.path.startsWith('/developers/v1/event/switch/'))
  const pending = f.services.connections.setup!.advance(input, { actor, assertCurrent: async () => {
    const claimed = db.prepare("SELECT count(*) AS count FROM connection_setup_inspection WHERE json_extract(record_json,'$.effect')=?").get(effect)!.count
    if (claimed && !nativeWrites().length) { entered(); await gate }
    if (!authorized) throw new AgentMuxError('Current actor authority was revoked', 'CONTROL_PERMISSION_DENIED')
  } }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  const deferredAfterClaim = await Promise.race([waiting.then(() => true), pending.then(() => false)])
  if (deferredAfterClaim) authorized = false
  release()
  let result = await pending
  if (deferredAfterClaim) {
    expect(nativeWrites()).toEqual([])
    authorized = true; await f.read()
    const available = await f.inspect()
    expect(available.applicationConfiguration!.reason).not.toBe('original-effect-unconfirmed')
    const value = await f.sdk.call('connection.setup.advance', action(available, effect))
    result = { value, error: null }
  }
  expect(nativeWrites()).toEqual([{ path: '/developers/v1/event/switch/' + APP, body: { eventMode: 4 } }])
  expect(result.error).toBeNull(); expect(result.value!.applicationConfiguration!.selected!.request).toBe('confirmed')
}, 30_000)
