import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createGoalQualifiedPublicFixture } from './helpers/goal-qualified-public-fixture'
import { createHostGoals } from '../../host/src/goals'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const params = (f: Awaited<ReturnType<typeof createGoalQualifiedPublicFixture>>, operationId: string) => ({ goalId: f.goal.id, operationId, agentReference: f.reference, access: f.access })

it('wrong connection preserves a Run-less request; Check never opens Core; explicit same OP continuation keeps the original body after Goal edits', async () => {
  const f = await createGoalQualifiedPublicFixture(cleanup), operationId = 'domain-first-wrong-source'
  const request = vi.spyOn(f.goals.demands, 'requestDispatch'), prepare = vi.spyOn(f.goals.demands, 'prepareDispatch')
  await expect(f.rpc.call('goal.start', { ...params(f, operationId), access: { source: { hostId: 'D-current' } } })).rejects.toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' })
  const saved = (await f.goals.demands.inspectDispatch(f.goal.id, operationId))!
  expect(saved).toMatchObject({ stage: 'requested', target: f.reference, prompt: f.goal.description, request: { goalUpdatedAt: f.goal.updatedAt } })
  if (saved.stage !== 'requested') throw Error('The actual public Start did not save its original business request')
  expect(saved).not.toHaveProperty('runId'); expect(saved).not.toHaveProperty('agentMuxNote')
  expect(request).toHaveBeenCalledTimes(1); expect(prepare).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  const open = vi.spyOn(f.goals.runtime, 'openFinite'), read = vi.spyOn(f.goals.runtime, 'openFiniteInspection')
  const check = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId })
  expect(check.goal?.dispatches?.find(value => value.operationId === operationId)).toEqual(saved)
  const work = await f.rpc.call('goal.delegations', { goalId: f.goal.id })
  expect(work.startObservations).toMatchObject([{ operationId, input: { state: 'unknown' }, responsibility: 'observation-unknown' }])
  expect(work.startObservations?.[0]).not.toHaveProperty('originalRun')
  expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  await f.goals.demands.update(f.goal.id, { description: 'Changed after original request' })
  await expect(f.rpc.call('goal.start', params(f, operationId))).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(open).not.toHaveBeenCalled()
  await f.rpc.call('goal.start', { ...params(f, operationId), resumeOriginal: true }).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  const prepared = await f.goals.demands.inspectDispatch(f.goal.id, operationId)
  expect(prepared).toMatchObject({ prompt: saved.prompt, target: saved.target, request: saved.stage === 'requested' ? saved.request : undefined,
    runId: f.session.run.runId, resultBasis: saved.resultBasis })
  expect(prepared).toHaveProperty('agentMuxNote', expect.stringContaining(f.session.run.runId))
  expect(f.raw).not.toHaveBeenCalled(); expect(f.stop).not.toHaveBeenCalled()
})

it.each([false, true])('two original Goal owners sharing the same root preserve OP authority when another preflight is held=%s', async heldRight => {
  const f = await createGoalQualifiedPublicFixture(cleanup), operationId = 'two-owners-' + heldRight
  const two = createHostGoals({ configurationPath: join(f.sourceRoot, 'goal-config.json'), runtime: () => f.runtime,
    clients: () => [{ hostId: 'D-current', client: f.configuredD }], projects: async () => [],
    coreCall: (hostId, method, input, context) => { if (hostId !== 'local') throw Error('Only original B'); return f.goalServer.callRpc(method, input, context) } })
  cleanup.push(() => two.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.sourceRoot, 'second-goals.sock'), goalControl: two.execute })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => rpc.dispose())
  const wrongEntered = deferred(), wrongHeld = deferred(), rightEntered = deferred(), rightHeld = deferred()
  cleanup.push(wrongHeld.release, rightHeld.release)
  const firstOpen = f.goals.runtime.openFinite.bind(f.goals.runtime), secondOpen = two.runtime.openFinite.bind(two.runtime)
  vi.spyOn(f.goals.runtime, 'openFinite').mockImplementation(async (...args) => { wrongEntered.release(); await wrongHeld.promise; return firstOpen(...args) })
  vi.spyOn(two.runtime, 'openFinite').mockImplementation(async (...args) => { rightEntered.release(); if (heldRight) await rightHeld.promise; return secondOpen(...args) })
  const failed = f.rpc.call('goal.start', { ...params(f, operationId), access: { source: { hostId: 'D-current' } } }).catch(error => error)
  await wrongEntered.promise
  const saved = await two.demands.inspectDispatch(f.goal.id, operationId)
  expect(saved?.stage).toBe('requested')
  const good = rpc.call('goal.start', { ...params(f, operationId), resumeOriginal: true }).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
  await rightEntered.promise
  if (!heldRight) await expect.poll(() => f.send.mock.calls.length).toBe(1)
  wrongHeld.release(); const failure = await failed
  expect(failure).toMatchObject({ code: 'RUNTIME_OWNER_MISMATCH' }); expect(failure).not.toHaveProperty('controlFailure.disposition', 'not_applied')
  if (heldRight) { expect(f.send).not.toHaveBeenCalled(); expect(await two.demands.inspectDispatch(f.goal.id, operationId)).toEqual(saved) }
  rightHeld.release(); await good
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  expect(await two.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ operationId, target: f.reference, runId: f.session.run.runId, prompt: saved?.prompt })
  expect(f.send).toHaveBeenCalledTimes(1)
})

it('original business refusals are inspectable without access; malformed versions, invalid authors and missing-original resume do not reserve an OP', async () => {
  const f = await createGoalQualifiedPublicFixture(cleanup), opened = vi.spyOn(f.goals.runtime, 'openFinite')
  await expect(f.rpc.call('goal.start', { ...params(f, 'version-rejected'), expectedUpdatedAt: f.goal.updatedAt - 1 })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  const rejected = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: 'version-rejected' })
  expect(rejected.goal?.dispatches?.find(value => value.operationId === 'version-rejected')).toMatchObject({ stage: 'rejected', rejection: { kind: 'goal-start-version-conflict' } })
  expect(opened).not.toHaveBeenCalled()
  await expect(f.rpc.call('goal.start', { ...params(f, 'resume-absent'), resumeOriginal: true })).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  await expect(f.rpc.call('goal.start', { ...params(f, 'invalid-version'), expectedUpdatedAt: -1 })).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  // Deliberately malformed ingress context; its untyped caller cannot supply a business author.
  await expect(Reflect.apply(f.goalServer.callRpc, f.goalServer, ['goal.start', params(f, 'invalid-actor'), { principal: { kind: 'agent', id: 'forged-principal' } }])).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  for (const id of ['resume-absent', 'invalid-version', 'invalid-actor']) expect(await f.goals.demands.inspectDispatch(f.goal.id, id)).toBeNull()
  expect(f.send).not.toHaveBeenCalled()
})

it('a lost original request write acknowledgement never opens Core and keeps the stored request for explicit same-OP continuation', async () => {
  const f = await createGoalQualifiedPublicFixture(cleanup), operationId = 'request-write-ack-lost'
  const original = f.goals.demands.requestDispatch.bind(f.goals.demands)
  const request = vi.spyOn(f.goals.demands, 'requestDispatch').mockImplementationOnce(async (...args) => {
    await original(...args)
    throw Object.assign(new Error('Controlled loss after the original writer returned its durable receipt'), { code: 'WRITE_FAILED' })
  })
  const opened = vi.spyOn(f.goals.runtime, 'openFinite'), prepare = vi.spyOn(f.goals.demands, 'prepareDispatch')
  await expect(f.rpc.call('goal.start', params(f, operationId))).rejects.toMatchObject({ code: 'WRITE_FAILED' })
  expect(opened).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled()
  const saved = await f.goals.demands.inspectDispatch(f.goal.id, operationId)
  expect(saved).toMatchObject({ operationId, stage: 'requested', prompt: f.goal.description, target: f.reference })
  if (!saved || saved.stage !== 'requested') throw Error('The original writer did not retain the business request')
  expect(saved).not.toHaveProperty('runId')
  const check = await f.rpc.call('goal.inspect', { goalId: f.goal.id, dispatchOperationId: operationId })
  expect(check.goal?.dispatches?.find(value => value.operationId === operationId)).toEqual(saved)
  request.mockRestore()
  await expect(f.rpc.call('goal.start', params(f, operationId))).rejects.toMatchObject({ code: 'CONTROL_REQUEST_CONFLICT' })
  expect(opened).not.toHaveBeenCalled()
  await f.rpc.call('goal.start', { ...params(f, operationId), resumeOriginal: true }).catch(error => expect(error).toMatchObject({ code: 'CONTROL_UNAVAILABLE' }))
  await expect.poll(() => f.send.mock.calls.length).toBe(1)
  expect(await f.goals.demands.inspectDispatch(f.goal.id, operationId)).toMatchObject({ operationId, prompt: saved?.prompt, target: saved?.target })
})
