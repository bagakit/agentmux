import { afterEach, expect, it, vi } from 'vitest'
import { closeEnrollmentInitialFixtures, enrollmentInitialFixture } from './fixtures/connection-enrollment-initial.js'
import { ConnectionSecrets } from '../src/connection-secrets.js'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionEnrollmentHost, ConnectionSetupHost, ConnectionHost } from '@agentmux/connectors'
import { connectionSetupDecisionForAction } from '@agentmux/core/connections'

afterEach(closeEnrollmentInitialFixtures)

it('projects original completed initialization through the public connection record without reading private setup state', async () => {
  const f = await enrollmentInitialFixture()
  const created = await f.finishCreation()
  expect(created.operation!.initialSetup!.progress!.state).toBe('complete')
  const before = f.requests.length
  const resolve = vi.spyOn(ConnectionSecrets.prototype, 'resolve')
  const listed = await f.sdk.call('connection.ls', {})
  expect(listed.connections[0]).toHaveProperty('initialSetup', { state: 'complete' })
  expect(resolve).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(before)
  expect(JSON.stringify(listed)).not.toContain(created.operation!.initialSetup!.operationId)
  expect(JSON.stringify(listed)).not.toContain(f.input.operationId)
  expect((await f.connectionCli(['inspect', '--connection', f.input.connectionId])).connection.initialSetup).toEqual({ state: 'complete' })
  resolve.mockRestore()
  await f.reopen()
  const reopenedResolve = vi.spyOn(ConnectionSecrets.prototype, 'resolve')
  expect((await f.connectionCli(['ls'])).connections[0].initialSetup).toEqual({ state: 'complete' })
  expect(reopenedResolve).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(before)
}, 30_000)

it('keeps the original managed incomplete outcome separate from authentication and automatic service policy', async () => {
  const f = await enrollmentInitialFixture('/event/switch/')
  await f.finishCreation()
  const before = f.requests.length
  const record = (await f.sdk.call('connection.ls', {})).connections[0]!
  expect(record.initialSetup).toEqual({ state: 'incomplete' })
  await f.sdk.call('connection.service.configure', { operationId: 'pause-automatic', expectedRevision: 0, service: { enabled: false } })
  const paused = (await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection!
  expect(paused.initialSetup).toEqual(record.initialSetup)
  expect(paused.observation.transport.state).toBe('disabled')
  expect(f.requests).toHaveLength(before)
}, 30_000)

it('retains a managed requirement after connection commit loses its original parent acknowledgement', async () => {
  const f = await enrollmentInitialFixture()
  const configure = ConnectionHost.prototype.configure
  const spy = vi.spyOn(ConnectionHost.prototype, 'configure').mockImplementation(async function (input) {
    await configure.call(this, input)
    throw new AgentMuxError('Original configuration acknowledgement is unconfirmed.', 'CONNECTION_STORAGE_UNCONFIRMED')
  })
  while (f.enrollment.operation!.authentication?.stage !== 'account') {
    const next = f.enrollment.challenge?.nextPollAt ?? 0
    if (next > Date.now()) await new Promise(done => setTimeout(done, next - Date.now()))
    await f.enrollmentAction('continue-authentication')
  }
  await f.enrollmentAction('confirm-account'); await f.enrollmentAction('create')
  expect(f.enrollment.operation).toMatchObject({ configuration: 'unknown', configured: null, creation: { create: 'confirmed' } })
  const before = f.requests.length
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'unconfirmed' })
  expect(f.requests).toHaveLength(before)
  spy.mockRestore()
  await f.enrollmentAction('recover-local')
  expect(f.enrollment.operation!.configuration).toBe('configured')
  expect(f.requests.filter(row => row.path.includes('/manifest/upsert_by_template'))).toHaveLength(1)
}, 30_000)

it('records actual original completion on explicit historical inspection without changing the operation or replaying an effect', async () => {
  const f = await enrollmentInitialFixture(), created = await f.finishCreation()
  const id = created.operation!.initialSetup!.operationId, db = f.services.database!
  db.prepare("UPDATE connection_setup_operation SET record_json=json_remove(record_json,'$.initialCompletion') WHERE operation_id=?").run(id)
  const original = (await f.sdk.call('connection.setup.inspect', { operationId: id, requestTrace: { limit: 1 } })).operation
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'unconfirmed' })
  const before = f.requests.length
  const inspected = await f.sdk.call('connection.setup.inspect', { operationId: id })
  expect(inspected.initialSetup).toMatchObject({ state: 'complete', versionId: created.operation!.initialSetup!.progress!.versionId })
  expect(inspected.operation).toEqual(original)
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'complete' })
  expect(f.requests).toHaveLength(before)
}, 30_000)

it('keeps a successful original result when only derived completion recording fails and later converges without platform work', async () => {
  const f = await enrollmentInitialFixture(), created = await f.finishCreation()
  const id = created.operation!.initialSetup!.operationId, db = f.services.database!
  db.prepare("UPDATE connection_setup_operation SET record_json=json_remove(record_json,'$.initialCompletion') WHERE operation_id=?").run(id)
  db.exec("CREATE TRIGGER fail_completion_observation BEFORE UPDATE OF record_json ON connection_setup_operation WHEN json_extract(NEW.record_json,'$.initialCompletion.state')='complete' BEGIN SELECT RAISE(ABORT,'controlled observation write'); END")
  const before = f.requests.length
  expect((await f.sdk.call('connection.setup.inspect', { operationId: id })).initialSetup?.state).toBe('complete')
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'unconfirmed' })
  db.exec('DROP TRIGGER fail_completion_observation')
  expect((await f.sdk.call('connection.setup.inspect', { operationId: id })).initialSetup?.state).toBe('complete')
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'complete' })
  expect(f.requests).toHaveLength(before)
}, 30_000)

it('preserves historical completion across same-application label and credential revisions but never lends it to another application', async () => {
  const f = await enrollmentInitialFixture(); await f.finishCreation()
  let current = (await f.sdk.call('connection.ls', {})).connections[0]!
  await f.sdk.call('connection.configure', { operationId: 'change-label-credential', expectedRevision: current.revision,
    connection: { ...current.config, label: 'Renamed saved identity', credentialRef: 'new-credential-reference' } })
  current = (await f.sdk.call('connection.inspect', { connectionId: f.input.connectionId })).connection!
  expect(current.revision).toBe(2); expect(current.initialSetup).toEqual({ state: 'complete' })
  await expect(f.sdk.call('connection.configure', { operationId: 'change-application', expectedRevision: current.revision,
    connection: { ...current.config, application: { ...current.config.application, appId: 'different-application' } } })).rejects.toMatchObject({ code: 'CONNECTION_IDENTITY_CONFLICT' })
  const id = f.enrollment.operation!.initialSetup!.operationId, db = f.services.database!
  db.prepare("UPDATE connection_setup_operation SET record_json=json_set(record_json,'$.application.appId','different-application') WHERE operation_id=?").run(id)
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'unconfirmed' })
}, 30_000)

it('keeps readable manual configuration when managed association lookup fails and contains a matched child observation failure', async () => {
  const f = await enrollmentInitialFixture(); await f.finishCreation()
  const parent = vi.spyOn(ConnectionEnrollmentHost.prototype, 'initialSetupObservation').mockImplementation(() => { throw Error('Observation only') })
  expect((await f.sdk.call('connection.ls', {})).connections[0]).not.toHaveProperty('initialSetup')
  parent.mockRestore()
  const child = vi.spyOn(ConnectionSetupHost.prototype, 'initialSetupObservation').mockImplementation(() => { throw Error('Child observation only') })
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'unconfirmed' })
  child.mockRestore()
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'complete' })
}, 30_000)

it('retains the original completed observation while a later original read is actually in flight', async () => {
  const f = await enrollmentInitialFixture(), created = await f.finishCreation()
  const operationId = created.operation!.initialSetup!.operationId, versionId = created.operation!.initialSetup!.progress!.versionId!
  const inspect = await f.sdk.call('connection.setup.inspect', { operationId, applicationInspection: { versionId } })
  const action = inspect.applicationInspection!.actions.find(item => item.kind === 'read-publication-version')!
  expect(action).toBeDefined()
  const native = globalThis.fetch
  let release!: () => void, held = false
  const wait = new Promise<void>(done => { release = done })
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).includes('/app_version/detail/') && !held) { held = true; await wait }
    return native(...args)
  })
  const pending = f.sdk.call('connection.setup.advance', { operationId, expectedRevision: action.expectedRevision, decision: { actionId: action.actionId, value: connectionSetupDecisionForAction(action) }, versionId })
  try {
    await vi.waitFor(() => expect(held).toBe(true))
    expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'complete' })
  } finally { release(); await pending }
  expect((await f.sdk.call('connection.ls', {})).connections[0]!.initialSetup).toEqual({ state: 'complete' })
}, 30_000)
