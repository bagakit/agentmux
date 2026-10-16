import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer, connectAgentMuxRpc, AgentMuxError } from '@agentmux/core'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { DesktopConnectorSecrets } from '../../../apps/desktop/src/main/connector-secrets.js'
import { enrollmentEncryption } from './fixtures/connection-enrollment.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import type { ConnectionSetupView, ConnectionSetupListing } from '@agentmux/core/connections'

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
const APP = 'cli_continuation_original', USER = 'continuation-user', TENANT = 'continuation-tenant'
const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of clean.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  try { vi.restoreAllMocks(); vi.unstubAllGlobals() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Continuation consumer cleanup failed')
})
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'setup-continuation-')), directory = join(root, 'connections'), socketPath = join(root, 'owner.sock')
  let services: Awaited<ReturnType<typeof createDesktopConnections>>, server: AgentMuxControlServer, sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>, closed = false
  const open = async () => {
    services = await createDesktopConnections({ directory, encryption: enrollmentEncryption() })
    server = new AgentMuxControlServer({ socketPath, connections: services.connections, coreClients: () => { throw Error('Local handoff cannot borrow an Agent Runtime') } })
    await server.start(); sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); closed = false
  }
  const closeOwner = async () => {
    if (closed) return
    closed = true
    const errors: unknown[] = []
    for (const close of [() => sdk.dispose(), () => server.stop(), () => services.close()]) try { await close() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Continuation owner cleanup failed')
  }
  clean.push(() => rm(root, { recursive: true, force: true })); clean.push(closeOwner)
  await open()
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    const target = new URL(String(url)); calls.push(target.pathname)
    if (target.pathname === '/accounts/qrlogin/init') return Response.json({ code: 0, data: { step_info: { token: 'continuation-private-qr' } } }, { headers: { 'x-flow-key': 'continuation-private-flow', 'set-cookie': 'session=continuation-private-cookie; Domain=.feishu.cn; Path=/; Secure' } })
    if (target.pathname === '/accounts/qrlogin/polling') return Response.json({ code: 0, data: { next_step: 'enter_app', step_info: { status: 1, cross_login_uri: 'https://accounts.feishu.cn/cross' } } })
    if (target.href === 'https://accounts.feishu.cn/cross') return new Response(null, { status: 302, headers: { location: 'https://ask.feishu.cn/' } })
    if (target.href === 'https://ask.feishu.cn/') return new Response('Landing is not account identity')
    if (target.href === 'https://open.feishu.cn/app') return new Response(`<script>window.user=${JSON.stringify({ id: USER, tenantId: TENANT })};window.csrfToken="continuation-private-csrf";</script>`, { headers: { 'content-type': 'text/html' } })
    if (target.pathname === '/developers/v1/app/upload/image') return Response.json({ code: 0, data: { url: 'https://images.example.test/original.png' } })
    if (target.pathname === '/developers/v1/manifest/upsert_by_template') return Response.json({ code: 0, data: { ClientID: APP } })
    if (target.pathname === '/developers/v1/secret/' + APP) return Response.json({ code: 0, data: { secret: 'continuation-private-app-secret' } })
    if (target.pathname === '/developers/v1/robot/' + APP) {
      expect(new Headers(options?.headers).get('x-csrf-token')).toBe('continuation-private-csrf')
      expect(new Headers(options?.headers).get('cookie')).toContain('session=continuation-private-cookie')
      return Response.json({ code: 0, data: { enable: false } })
    }
    throw Error('Unexpected continuation request')
  }))
  let enrollment = await sdk.call('connection.enrollment.begin', { operationId: 'creation-original', connectionId: 'continuation-original', adapterId: 'feishu', domain: 'open.feishu.cn', label: 'Original bot', preset: { name: 'Original bot', avatar: { pngDataUrl: PNG } } })
  const advanceEnrollment = async (kind: string) => {
    const action = enrollment.actions.find(a => a.kind === kind)!
    expect(action).toBeDefined()
    enrollment = await sdk.call('connection.enrollment.advance', { operationId: enrollment.operation!.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
  }
  for (let i = 0; i < 8 && enrollment.operation!.authentication?.stage !== 'account'; i++) {
    if (enrollment.challenge && enrollment.challenge.nextPollAt > Date.now()) await new Promise(done => setTimeout(done, enrollment.challenge!.nextPollAt - Date.now()))
    await advanceEnrollment('continue-authentication')
  }
  await advanceEnrollment('confirm-account'); await advanceEnrollment('create')
  expect(enrollment.operation!.configuration).toBe('configured')
  const saved = enrollment.operation!.configured!.connection
  const input = { operationId: 'management-original', connectionId: saved.config.connectionId, expectedConnectionRevision: saved.revision, goal: { kind: 'agent-conversation', interaction: 'messages' }, source: { kind: 'enrollment', operationId: enrollment.operation!.operationId, expectedRevision: enrollment.operation!.revision } } as const
  const cli = async <T = ConnectionSetupView>(args: string[], value?: unknown): Promise<T> => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'setup', ...args], objectCliEnvironment(root), value === undefined ? '' : JSON.stringify(value))
    expect(result.code, result.stdout + result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { root, directory, socketPath, get services() { return services }, get sdk() { return sdk }, calls, enrollment, saved, input, cli, closeOwner, reopen: open }
}

it('saved creation hands its original account to the same Setup with zero HTTP, separate account confirmation and an explicit exact-app read', async () => {
  const f = await fixture(), before = [...f.calls]
  const imported = await f.cli(['begin', '--input', '-'], f.input)
  expect(imported.continuation).toMatchObject({ stage: 'account', account: { userId: USER, tenantId: TENANT } })
  expect(imported.challenge).toBeNull(); expect(imported.receipt).toBeUndefined()
  expect(imported.operation!.request).toMatchObject({ kind: 'enrollment-handoff', state: 'confirmed' })
  expect(f.calls).toEqual(before)
  const original = await f.sdk.call('connection.setup.begin', f.input)
  expect(original).toEqual(imported)
  const action = original.continuation!.actions.find(a => a.kind === 'confirm-account')!
  expect(action).toBeDefined()
  const confirmed = await f.cli(['advance', '--input', '-'], { operationId: f.input.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'confirm' } })
  expect(confirmed.continuation!.stage).toBe('confirmed'); expect(f.calls).toEqual(before)
  const details = await f.sdk.call('connection.setup.inspect', { operationId: f.input.operationId, applicationInspection: {} })
  const read = details.applicationInspection!.actions.find(a => a.kind === 'read-bot-settings')!
  const observed = await f.cli(['advance', '--input', '-'], { operationId: f.input.operationId, expectedRevision: read.expectedRevision, decision: { actionId: read.actionId, value: 'continue' } })
  expect(observed.applicationInspection?.selected).toMatchObject({ subject: 'bot-settings', request: 'confirmed', secureStorage: 'stored' })
  expect(f.calls.slice(before.length)).toEqual(['/developers/v1/robot/' + APP])
  expect((await f.sdk.call('connection.enrollment.inspect', { operationId: f.enrollment.operation!.operationId })).operation).toEqual(f.enrollment.operation)
  const list = await f.sdk.call('connection.setup.ls', { connectionId: f.input.connectionId })
  expect(list.support).toEqual({ connectionRevision: f.saved.revision, capabilities: ['management-authentication', 'application-inspection', 'messaging-capability', 'persistent-event-transport', 'application-permissions', 'message-reception', 'card-actions', 'application-publication', 'enrollment-continuation'] })
  expect(await f.cli<ConnectionSetupListing>(['ls', '--connection', f.input.connectionId])).toEqual(list)
  for (const value of [USER, TENANT, 'continuation-private']) expect(JSON.stringify(list)).not.toContain(value)
}, 20_000)

it('authority revoked while the original Vault read yields cannot leak the old account or dispatch a request', async () => {
  const f = await fixture(), before = [...f.calls], entered = deferred(), release = deferred()
  const row = JSON.parse(String(f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.enrollment.operation!.operationId)!.record_json))
  const originalResolve = DesktopConnectorSecrets.prototype.resolve
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function (ref) {
    const value = await originalResolve.call(this, ref)
    if (ref === row.privateRef) { entered.resolve(); await release.promise }
    return value
  })
  let authorized = true
  const pending = f.services.connections.setup!.begin(f.input, { actor: row.actor, assertCurrent: () => { if (!authorized) throw new AgentMuxError('Original actor authority was revoked', 'CONTROL_PERMISSION_DENIED') } }).then(value => ({ value, error: null }), error => ({ value: null, error }))
  await Promise.race([entered.promise, pending.then(result => { expect(result.error).toBeNull(); expect(result.value?.continuation?.stage).toBe('account') })])
  authorized = false; release.resolve()
  const result = await pending
  expect(result.error?.code).toBe('CONTROL_PERMISSION_DENIED'); expect(result.value).toBeNull()
  expect(f.calls).toEqual(before)
  expect((await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection).toEqual(f.saved)
}, 20_000)

it('an independently saved Setup rechecks its current actor after a private Vault read', async () => {
  const f = await fixture(), before = [...f.calls]
  await f.sdk.call('connection.setup.begin', f.input)
  const row = f.services.database!.prepare('SELECT actor_json,private_ref FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!
  const entered = deferred(), release = deferred(), resolve = DesktopConnectorSecrets.prototype.resolve
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function (ref) {
    const value = await resolve.call(this, ref)
    if (ref === row.private_ref) { entered.resolve(); await release.promise }
    return value
  })
  let authorized = true
  const pending = f.services.connections.setup!.inspect({ operationId: f.input.operationId }, { actor: JSON.parse(String(row.actor_json)), assertCurrent: () => { if (!authorized) throw new AgentMuxError('Original actor authority was revoked', 'CONTROL_PERMISSION_DENIED') } })
  await entered.promise
  authorized = false; release.resolve()
  const result = await pending
  expect(result.continuation?.account ?? null).toBeNull()
  expect(result.challenge).toBeNull(); expect(result.reason).toBe('challenge-unavailable')
  expect(result.operation).toMatchObject({ operationId: f.input.operationId, secureStorage: 'stored' })
  expect(f.calls).toEqual(before)
}, 20_000)

it.each(['source-attempt', 'actor', 'target'] as const)('first local handoff cannot store a late account after %s changes during Vault receipt inspection', async change => {
  const f = await fixture(), before = [...f.calls], db = f.services.database!
  const originalSource = String(db.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.enrollment.operation!.operationId)!.record_json)
  const row = JSON.parse(originalSource), entered = deferred(), release = deferred()
  const inspect = DesktopConnectorSecrets.prototype.inspect, store = DesktopConnectorSecrets.prototype.store
  let held = false, authorized = true
  const stored: string[] = []
  vi.spyOn(DesktopConnectorSecrets.prototype, 'inspect').mockImplementation(async function (operationId) {
    const receipt = await inspect.call(this, operationId)
    if (!held && !receipt && operationId.startsWith('connection-setup-auth:')) { held = true; entered.resolve(); await release.promise }
    return receipt
  })
  vi.spyOn(DesktopConnectorSecrets.prototype, 'store').mockImplementation(async function (input) {
    if (input.operationId.startsWith('connection-setup-auth:')) stored.push(input.operationId)
    return store.call(this, input)
  })
  const context = { actor: row.actor, assertCurrent: () => { if (!authorized) throw new AgentMuxError('Original actor authority was revoked', 'CONTROL_PERMISSION_DENIED') } }
  const pending = f.services.connections.setup!.begin(f.input, context).then(value => ({ value, error: null }), error => ({ value: null, error }))
  await entered.promise
  const admitted = JSON.parse(String(db.prepare('SELECT record_json FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!.record_json))
  if (change === 'source-attempt') {
    row.operation.authentication.attemptId = 'a-different-original-attempt'
    db.prepare('UPDATE connection_enrollment SET record_json=? WHERE operation_id=?').run(JSON.stringify(row), f.enrollment.operation!.operationId)
  } else if (change === 'actor') authorized = false
  else await f.sdk.call('connection.configure', { operationId: 'target-before-handoff-store', expectedRevision: f.saved.revision, connection: { ...f.saved.config, label: 'Changed before handoff storage' } })
  release.resolve()
  const late = await pending
  expect(stored).toEqual([])
  expect(late.value?.continuation?.account ?? null).toBeNull()
  const safe = db.prepare('SELECT record_json,private_ref FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!
  expect(safe.private_ref).toBeNull(); expect(JSON.parse(String(safe.record_json)).secureStorage).not.toBe('stored')
  expect(f.calls).toEqual(before)
  if (change !== 'target') {
    authorized = true
    db.prepare('UPDATE connection_enrollment SET record_json=? WHERE operation_id=?').run(originalSource, f.enrollment.operation!.operationId)
    const continued = await f.services.connections.setup!.begin(f.input, context)
    expect(continued.operation!.request.attemptId).toBe(admitted.request.attemptId)
    expect(continued.continuation).toMatchObject({ stage: 'account', account: { userId: USER, tenantId: TENANT } })
    expect(stored).toEqual(['connection-setup-auth:' + admitted.request.attemptId]); expect(f.calls).toEqual(before)
  }
}, 20_000)

it.each(['source-attempt', 'target'] as const)('a changed %s during the original Vault read cannot bind the late account', async change => {
  const f = await fixture(), before = [...f.calls], entered = deferred(), release = deferred()
  const db = f.services.database!, stored = db.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.enrollment.operation!.operationId)!, row = JSON.parse(String(stored.record_json))
  const resolve = DesktopConnectorSecrets.prototype.resolve
  vi.spyOn(DesktopConnectorSecrets.prototype, 'resolve').mockImplementation(async function (ref) {
    const value = await resolve.call(this, ref)
    if (ref === row.privateRef) { entered.resolve(); await release.promise }
    return value
  })
  const pending = f.sdk.call('connection.setup.begin', f.input).then(value => ({ value, error: null }), error => ({ value: null, error }))
  await Promise.race([entered.promise, pending.then(result => { expect(result.error).toBeNull(); expect(result.value?.continuation?.stage).toBe('account') })])
  if (change === 'source-attempt') {
    row.operation.authentication.attemptId = 'a-different-original-attempt'
    db.prepare('UPDATE connection_enrollment SET record_json=? WHERE operation_id=?').run(JSON.stringify(row), f.enrollment.operation!.operationId)
  } else await f.sdk.call('connection.configure', { operationId: 'changed-target', expectedRevision: f.saved.revision, connection: { ...f.saved.config, label: 'Changed saved target' } })
  release.resolve()
  const late = await pending
  if (change === 'source-attempt') expect(late.error?.code).toBe('CONNECTION_REVISION_CONFLICT')
  else { expect(late.error).toBeNull(); expect(late.value?.reason).toBe('connection-revised') }
  expect(late.value?.continuation?.account ?? null).toBeNull()
  const privateRow = db.prepare('SELECT private_ref FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!
  expect(privateRow.private_ref).toBeNull(); expect(f.calls).toEqual(before)
}, 20_000)

it('requires the original actor, exact source revision and saved target, and freezes that source in duplicate input', async () => {
  const f = await fixture(), before = [...f.calls], row = JSON.parse(String(f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.enrollment.operation!.operationId)!.record_json))
  await expect(f.services.connections.setup!.begin(f.input, { actor: { kind: 'user', id: 'another-actor' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  await expect(f.sdk.call('connection.setup.begin', { ...f.input, operationId: 'wrong-source-revision', source: { ...f.input.source, expectedRevision: f.input.source.expectedRevision - 1 } })).rejects.toMatchObject({ code: 'CONNECTION_REVISION_CONFLICT' })
  const other = await f.sdk.call('connection.configure', { operationId: 'other-saved-app', expectedRevision: null, connection: { ...f.saved.config, connectionId: 'another-connection', application: { ...f.saved.config.application, appId: 'cli_other_saved_app' } } })
  await expect(f.sdk.call('connection.setup.begin', { ...f.input, operationId: 'wrong-saved-target', connectionId: other.connection.config.connectionId, expectedConnectionRevision: other.connection.revision })).rejects.toMatchObject({ code: 'CONNECTION_SETUP_SOURCE_UNCONFIRMED' })
  // This failed operation was admitted by the foreign actor and cannot be taken over.
  await expect(f.sdk.call('connection.setup.begin', f.input)).rejects.toMatchObject({ code: 'CONNECTION_SETUP_AUTHORITY_REQUIRED' })
  const input = { ...f.input, operationId: 'qualified-original-actor' }
  const bound = await f.sdk.call('connection.setup.begin', input)
  expect(bound.continuation?.stage).toBe('account')
  await expect(f.sdk.call('connection.setup.begin', { ...input, source: { ...input.source, expectedRevision: input.source.expectedRevision + 1 } })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
  await expect(f.services.connections.setup!.inspect({ operationId: input.operationId }, { actor: { kind: row.actor.kind, id: 'another-actor' } })).rejects.toMatchObject({ code: 'CONNECTION_SETUP_AUTHORITY_REQUIRED' })
  expect(await f.sdk.call('connection.setup.begin', input)).toEqual(bound); expect(f.calls).toEqual(before)
}, 20_000)

function message(child: ChildProcess, kind: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (value: unknown) => { if (value && typeof value === 'object' && (value as { kind?: string }).kind === kind) { child.off('message', onMessage); child.off('exit', onExit); resolve(value as Record<string, unknown>) } }
    const onExit = () => { child.off('message', onMessage); reject(new Error('Continuation owner exited before ' + kind)) }
    child.on('message', onMessage); child.once('exit', onExit)
  })
}

it('a real writer dies after Vault commit; an independent reader repairs the original child without the old source, adapter or HTTP', async () => {
  const f = await fixture(), before = [...f.calls]
  await f.closeOwner()
  const start = async (mode: string) => {
    const child = fork(new URL('./fixtures/connection-setup-continuation-owner.mjs', import.meta.url), [f.directory, mode], { execArgv: ['--experimental-transform-types'], env: objectCliEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    clean.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') } })
    let errors = ''; child.stderr!.on('data', value => { errors += value })
    const http: unknown[] = []; child.on('message', value => { if (value?.kind === 'unexpected-http') http.push(value) })
    await message(child, 'ready').catch(error => { throw new Error(errors || String(error)) })
    return { child, http }
  }
  const first = await start('hold-ack'), stored = message(first.child, 'stored')
  const args = ['--endpoint', 'unix:' + join(f.directory, 'owner.sock'), 'connection', 'setup']
  const pending = runCompiledObjectCli([...args, 'begin', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(f.input))
  const committed = await stored
  const inspect = await runCompiledObjectCli([...args, 'inspect', '--operation-id', f.input.operationId], objectCliEnvironment(f.root))
  expect(inspect.code, inspect.stdout + inspect.stderr).toBe(0)
  const original: ConnectionSetupView = JSON.parse(inspect.stdout).result
  expect(original.operation).toMatchObject({ request: { kind: 'enrollment-handoff', state: 'confirmed', attemptId: expect.any(String) }, secureStorage: 'storing' })
  expect(original.continuation?.account ?? null).toBeNull()
  first.child.kill('SIGKILL'); await once(first.child, 'exit'); await pending
  const second = await start('recover')
  const output = await runCompiledObjectCli([...args, 'begin', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify(f.input))
  expect(output.code, output.stdout + output.stderr).toBe(0)
  const recovered: ConnectionSetupView = JSON.parse(output.stdout).result
  expect(recovered.operation).toMatchObject({ ...f.input, request: original.operation!.request, secureStorage: 'stored' })
  expect(recovered.continuation).toMatchObject({ stage: 'account', account: { userId: USER, tenantId: TENANT } })
  const action = recovered.continuation!.actions.find(action => action.kind === 'confirm-account')!
  const confirmed = await runCompiledObjectCli([...args, 'advance', '--input', '-'], objectCliEnvironment(f.root), JSON.stringify({ operationId: f.input.operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: 'confirm' } }))
  expect(confirmed.code, confirmed.stdout + confirmed.stderr).toBe(0); expect(JSON.parse(confirmed.stdout).result.continuation.stage).toBe('confirmed')
  const db = new DatabaseSync(join(f.directory, 'connections.sqlite'))
  try {
    const row = db.prepare('SELECT private_ref FROM connection_setup_operation WHERE operation_id=?').get(f.input.operationId)!
    expect(row.private_ref).toBe(committed.credentialRef)
    const source = JSON.parse(String(db.prepare('SELECT record_json FROM enrollment_source_unavailable WHERE operation_id=?').get(f.enrollment.operation!.operationId)!.record_json))
    expect(source.operation).toEqual(f.enrollment.operation)
    const stored = JSON.stringify(db.prepare('SELECT * FROM connection_setup_operation').all())
    for (const value of [USER, TENANT, 'continuation-private']) expect(stored).not.toContain(value)
  } finally { db.close() }
  expect(first.http).toEqual([]); expect(second.http).toEqual([]); expect(f.calls).toEqual(before)
}, 30_000)
