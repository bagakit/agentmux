import { afterEach, expect, it, vi } from 'vitest'
import { ConnectionEnrollmentHost } from '@agentmux/connectors'
import { parseConnectionEnrollmentBegin } from '@agentmux/core/connections'
import { closeEnrollmentInitialFixtures, enrollmentInitialFixture } from './fixtures/connection-enrollment-initial.js'

afterEach(closeEnrollmentInitialFixtures)
const safeProgress = { stage: 'publication-status', state: 'complete', versionId: 'initial-version' }
const secrets = ['initial-private', 'original-creator', 'original-tenant', 'pngDataUrl', 'qrPayload']

it('freezes one original setup before effects and automatically composes creator-only cards setup through public SDK and compiled CLI', async () => {
  const f = await enrollmentInitialFixture()
  const initial = f.admitted.operation!.initialSetup!
  expect(initial).toEqual({ operationId: expect.any(String), progress: null })
  expect(initial.operationId).not.toBe(f.input.operationId)
  expect(f.admitted.operation!.initialPublication).toEqual(f.input.initialPublication)
  const admitted = f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)
  expect(JSON.parse(String(admitted!.record_json)).operation.initialSetup).toEqual(initial)
  const created = await f.finishCreation()
  expect(created.operation!.initialSetup).toEqual({ operationId: initial.operationId, progress: safeProgress })
  expect(created.actions.map(action => action.kind)).not.toContain('continue-setup')
  const setup = await f.sdk.call('connection.setup.inspect', { operationId: initial.operationId })
  expect(setup.operation).toMatchObject({ operationId: initial.operationId, connectionId: f.input.connectionId, goal: { kind: 'agent-conversation', interaction: 'cards' }, source: { kind: 'enrollment', operationId: f.input.operationId, expectedRevision: created.operation!.revision }, initialPublication: f.input.initialPublication })
  expect(f.requests.filter(request => request.path.includes('/manifest/upsert_by_template'))).toHaveLength(1)
  expect(f.requests.filter(request => request.path.includes('/callback/update/'))).toHaveLength(1)
  expect(f.requests.find(request => request.path.includes('/app_version/create/'))!.body).toMatchObject({ visibleSuggest: { members: ['original-creator'], departments: [], groups: [], isAll: 0 } })
  expect(f.requests.filter(request => request.path.includes('/publish/commit/'))).toHaveLength(1)
  const before = f.requests.length, revision = created.operation!.revision
  expect((await f.cli(['inspect', '--operation-id', f.input.operationId])).operation!.initialSetup).toEqual(created.operation!.initialSetup)
  const list = await f.sdk.call('connection.enrollment.ls', {})
  expect(list.operations[0].initialSetup).toEqual(created.operation!.initialSetup)
  for (const secret of secrets) expect(JSON.stringify(list.operations[0])).not.toContain(secret)
  expect(f.requests).toHaveLength(before)
  expect(list.operations[0].revision).toBe(revision)
  await f.reopen()
  expect((await f.cli(['inspect', '--operation-id', f.input.operationId])).operation!.initialSetup).toEqual(created.operation!.initialSetup)
  expect(f.requests).toHaveLength(before)
}, 30_000)

it('unknown setup writes keep the same source and action across reopen without platform work from reads or old local recovery', async () => {
  const f = await enrollmentInitialFixture('/event/switch/')
  const local = f.admitted.actions.find(action => action.kind === 'recover-local')!
  const localInput = { operationId: f.input.operationId, ownRevision: local.ownRevision, decision: { actionId: local.actionId, kind: local.kind } }
  await f.enrollmentAction('recover-local')
  const result = await f.finishCreation(), operation = result.operation!
  expect(operation.initialSetup?.progress).toEqual({ stage: 'event-transport', state: 'attention' })
  expect(result.actions.map(action => action.kind)).toEqual(['continue-setup'])
  const before = [...f.requests], row = f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)
  f.unblock(); await f.reopen()
  expect((await f.cli(['inspect', '--operation-id', f.input.operationId])).operation!.initialSetup).toEqual(operation.initialSetup)
  await f.sdk.call('connection.enrollment.ls', {})
  await f.sdk.call('connection.enrollment.advance', localInput)
  expect(f.requests).toEqual(before)
  expect(f.services.database!.prepare('SELECT record_json FROM connection_enrollment WHERE operation_id=?').get(f.input.operationId)).toEqual(row)
  const action = result.actions[0]
  const next = await f.cli(['advance', '--input', '-'], { operationId: f.input.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
  expect(next.operation!.initialSetup).toEqual(operation.initialSetup)
  expect(next.operation!.revision).toBe(operation.revision)
  expect(f.requests).toEqual(before)
  await expect(f.sdk.call('connection.enrollment.begin', { ...f.input, initialPublication: { version: '1.0.0', notes: 'Different consent' } })).rejects.toMatchObject({ code: 'CONNECTION_OPERATION_CONFLICT' })
}, 30_000)

it('a finite continuation recovers an observation gap through the original setup and leaves parent identity and revision unchanged', async () => {
  const f = await enrollmentInitialFixture('read-event-settings')
  const first = await f.finishCreation(), operation = first.operation!
  expect(operation.initialSetup?.progress).toEqual({ stage: 'event-transport', state: 'attention' })
  const before = f.requests.length
  await f.cli(['inspect', '--operation-id', f.input.operationId])
  expect(f.requests).toHaveLength(before)
  f.unblock()
  const action = first.actions.find(action => action.kind === 'continue-setup')!
  const next = await f.sdk.call('connection.enrollment.advance', { operationId: f.input.operationId, ownRevision: action.ownRevision, decision: { actionId: action.actionId, kind: action.kind } })
  expect(next.operation!.initialSetup).toEqual({ operationId: operation.initialSetup!.operationId, progress: safeProgress })
  expect(next.operation!.revision).toBe(operation.revision)
  expect(f.requests.filter(request => request.path.includes('/robot/switch/'))).toHaveLength(1)
  expect(f.requests.filter(request => request.path.includes('/manifest/upsert_by_template'))).toHaveLength(1)
  expect(next.actions).toEqual([])
}, 30_000)

it('platform approval remains original progress and unauthorized actors cannot drive or inspect the composition', async () => {
  const f = await enrollmentInitialFixture(null, 1), created = await f.finishCreation()
  expect(created.operation!.initialSetup?.progress).toEqual({ stage: 'publication-status', state: 'approval-required', versionId: 'initial-version' })
  const before = f.requests.length
  await expect(f.services.connections.enrollment!.inspect({ operationId: f.input.operationId }, { actor: { kind: 'agent', id: 'other-actor' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  const list = await f.services.connections.enrollment!.list({}, { actor: { kind: 'agent', id: 'other-actor' } })
  expect(list.operations).toEqual([])
  const setup = vi.spyOn(f.services.connections.setup!, 'inspect')
  const publicList = await f.services.connections.enrollment!.list({})
  expect(publicList.operations[0].initialSetup).toEqual({ operationId: created.operation!.initialSetup!.operationId, progress: null })
  expect(setup).not.toHaveBeenCalled(); expect(f.requests).toHaveLength(before)
}, 30_000)

it('unchanged enrollment without publication intent never starts setup and old records stay absent', async () => {
  const f = await enrollmentInitialFixture(null, 2, null)
  const result = await f.finishCreation()
  expect(result.operation).not.toHaveProperty('initialPublication')
  expect(result.operation).not.toHaveProperty('initialSetup')
  expect(f.requests.some(request => request.path.includes('/robot/'))).toBe(false)
  const before = f.requests.length
  await f.reopen()
  expect((await f.cli(['inspect', '--operation-id', f.input.operationId])).operation).not.toHaveProperty('initialSetup')
  expect(f.requests).toHaveLength(before)
}, 30_000)

it('strict original input and public replies reject changed consent, unsafe progress and private projection material', async () => {
  const f = await enrollmentInitialFixture()
  expect(() => parseConnectionEnrollmentBegin({ ...f.input, initialPublication: { version: '0.0.0', notes: 'Invalid version' } })).toThrow()
  expect(() => parseConnectionEnrollmentBegin({ ...f.input, initialPublication: { version: '1.0.0', notes: 'Consent', privateToken: 'secret' } })).toThrow()
  await f.finishCreation()
  const original = ConnectionEnrollmentHost.prototype.inspect
  const spy = vi.spyOn(ConnectionEnrollmentHost.prototype, 'inspect').mockImplementation(async function (input, context) {
    const view = await original.call(this, input, context)
    return { ...view, operation: view.operation ? { ...view.operation, initialSetup: { operationId: 'wrong-projection', progress: { stage: 'publication-status', state: 'complete' } } } as typeof view.operation : null }
  })
  await expect(f.sdk.call('connection.enrollment.inspect', { operationId: f.input.operationId })).rejects.toMatchObject({ code: 'INVALID_CONNECTION_SETUP_DATA' })
  spy.mockRestore()
}, 30_000)
