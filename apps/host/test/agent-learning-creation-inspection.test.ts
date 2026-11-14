import { expect, it, vi } from 'vitest'
import { type AgentMuxAgentCreationInspection } from '@agentmux/core'
import { parseCreationInspection } from '../../../packages/core/src/agent-creation-inspection.js'
import type { CtxmuxRunAdapter } from '../../../packages/core/src/ctxmux-run-adapter.js'
import type { AgentMuxLifecycleReservation } from '../../../packages/core/src/agent-session-store.js'
import { learningPublicFixture } from './agent-learning-public-fixture.js'

/** The original learning fixture has deterministic Runtime I/O. Keep modern
 * prepared-Start identity and exact-key observation at that same leaf. */
async function fixture() {
  const f = await learningPublicFixture()
  const runtime = { runtimeId: 'learning-runtime', instanceId: 'learning-instance', buildIdentity: 'controlled-runtime', protocolVersion: 1 }
  const requests = new Map<string, { request: Parameters<CtxmuxRunAdapter['startPrepared']>[0]; run: Awaited<ReturnType<CtxmuxRunAdapter['startPrepared']>> }>()
  const start: CtxmuxRunAdapter['startPrepared'] = async (request, operationKey, expected) => {
    if (expected) expect(expected).toEqual(runtime)
    const prior = requests.get(operationKey)
    if (prior) { expect(request).toEqual(prior.request); return prior.run }
    const run = await f.inner.kernel.start({ ...request, operationKey })
    requests.set(operationKey, { request, run }); return run
  }
  const inspect: CtxmuxRunAdapter['inspectPreparedStart'] = async (request, operationKey) => {
    const prior = requests.get(operationKey)
    if (!prior) return null
    expect(request).toEqual(prior.request); return prior.run
  }
  f.inner.kernel.creationRuntimeIdentity = () => runtime
  f.inner.kernel.startPrepared = vi.fn(start)
  f.inner.kernel.inspectPreparedStart = vi.fn(inspect)
  f.inner.kernel.observePreparedStartRetirement = vi.fn(async () => ({ runtime, outcome: 'not_retired' }))
  f.inner.kernel.retirePreparedStart = vi.fn(async (...[request, operationKey, expected]: Parameters<CtxmuxRunAdapter['retirePreparedStart']>) => {
    expect(expected).toEqual(runtime)
    expect(request.env.AGENTMUX_LIFECYCLE_OPERATION_ID).toBe(operationKey)
    expect(requests.has(operationKey)).toBe(false)
    return { runtime, outcome: 'retired' }
  })
  f.inner.hookServer.createBinding = (_sessionId: string, _providerId: string, bindingId: string) => ({ bindingId,
    endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  return { ...f, start, unknownStart: (applied = false) => f.inner.kernel.startPrepared.mockImplementationOnce(async (...args: Parameters<CtxmuxRunAdapter['startPrepared']>) => {
    if (applied) await start(...args)
    throw new Error('The original Runtime Start result is unknown')
  }) }
}

async function closeOriginal(f: Awaited<ReturnType<typeof fixture>>, agentSessionId: string, createOperationId: string) {
  const result = await f.core.resolveAgentCreation({ agentSessionId, createOperationId, operationId: 'close-' + createOperationId })
  expect(result.kind).toBe('closed-agent-creation')
  return result
}

it.each(['prepared-agent-creation', 'closed-agent-creation'] as const)('keeps %s unavailable without inventing worker retirement or a Run', async kind => {
  const f = await fixture(); f.unknownStart(kind === 'prepared-agent-creation')
  const operation = await f.prepare(), original = operation.proposer
  expect(original.state).toBe('unknown'); expect(original.runId).toBeUndefined()
  if (kind === 'closed-agent-creation') await closeOriginal(f, original.agentSessionId, original.createOperationId)
  const before = await f.core.inspectAgentCreation(original.agentSessionId)
  expect(before.kind).toBe(kind)
  expect(before).not.toHaveProperty('run')
  const nativeWrites = f.submit.mock.calls.length
  const read = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: operation.operationId })).operation!
  expect(read.proposer, 'non-Session creation must keep the original worker fact, not derive retirement or a Run').toEqual(original)
  expect(read.unavailable).toContainEqual(expect.objectContaining({ step: 'extraction', code: 'LEARNING_CREATION_UNCONFIRMED' }))
  await f.prepare()
  expect(f.started).toHaveLength(kind === 'prepared-agent-creation' ? 1 : 0); expect(f.submit).toHaveBeenCalledTimes(nativeWrites)
  expect(await f.core.inspectAgentCreation(original.agentSessionId)).toEqual(before)
  if (kind === 'prepared-agent-creation') f.inner.kernel.startPrepared.mockImplementation(f.start)
  const continued = (await f.client.call('agent.learning.continue', { hostId: 'local', operationId: operation.operationId, step: 'extraction' })).operation
  expect(continued.proposer, JSON.stringify(continued.issues)).toMatchObject({ agentSessionId: original.agentSessionId, createOperationId: original.createOperationId,
    state: kind === 'prepared-agent-creation' ? 'created' : 'unknown' })
  expect(f.started).toHaveLength(kind === 'prepared-agent-creation' ? 1 : 0)
  if (kind === 'closed-agent-creation') {
    expect(continued.issues).toContainEqual(expect.objectContaining({ code: 'AGENT_CREATION_CLOSED' }))
    expect(await f.core.inspectAgentCreation(original.agentSessionId)).toEqual(before)
  } else {
    await f.client.call('agent.learning.continue', { hostId: 'local', operationId: operation.operationId, step: 'extraction' })
    expect(f.started).toHaveLength(1)
    expect((await f.store.readMetadata(original.agentSessionId))?.creation?.createOperationId).toBe(original.createOperationId)
  }
})

it.each(['prepared-agent-creation', 'closed-agent-creation'] as const)('does not treat a %s directory as a confirmed extraction source', async kind => {
  const f = await fixture(); f.unknownStart()
  await expect(f.core.createAgentWithDelivery({ agentSessionId: 'pending-source', createOperationId: 'pending-source-create', providerId: 'codex',
    executorId: 'codex', workspacePath: f.root, injectAgentMuxGuide: false })).rejects.toThrow()
  if (kind === 'closed-agent-creation') await closeOriginal(f, 'pending-source', 'pending-source-create')
  const original = await f.core.inspectAgentCreation('pending-source'), source = await f.store.readMetadata('source')
  expect(original.kind).toBe(kind)
  const prepared = await f.client.call('agent.learning.prepare', { operationId: 'pending-source-extraction', source: { hostId: 'local', agentSessionId: 'pending-source' }, executorId: 'saved' })
    .then(value => ({ value }), error => ({ error }))
  expect(prepared, 'uncommitted source must not admit a replacement extraction').toMatchObject({ error: { code: 'LEARNING_SOURCE_UNCONFIRMED' } })
  expect((await f.client.call('agent.learning.ls', { hostId: 'local', agentSessionId: 'pending-source' })).operations,
    'uncommitted source must not admit a replacement extraction').toEqual([])
  expect(await f.core.inspectAgentCreation('pending-source')).toEqual(original)
  expect(await f.store.readMetadata('source')).toEqual(source)
  expect(f.started).toHaveLength(0); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})

it.each(['prepared-agent-creation', 'closed-agent-creation'] as const)('preserves an earlier created fact when its current inspection is %s', async kind => {
  const f = await fixture(), operation = await f.prepare(), worker = operation.proposer
  expect(worker.state).toBe('created')
  const session = await f.core.inspectAgentCreation(worker.agentSessionId)
  if (session.kind !== 'agent' || !session.creation) throw Error('The actual original created Session is required')
  // A controlled read boundary reproduces a weaker current projection. It does
  // not mutate Core or assert that an original Run was stopped or never existed.
  const { createdRun: _run, initialInputKey: _key, resolution: _resolution, ...pendingCreation } = session.creation
  const projection: AgentMuxAgentCreationInspection = { kind, agentSessionId: session.agentSessionId, providerId: session.providerId,
    executorId: session.executorId, hostId: session.hostId, workspacePath: session.workspacePath, creation: pendingCreation,
    ...(kind === 'closed-agent-creation' ? { resolution: { operationId: 'controlled-fence', createOperationId: worker.createOperationId,
      agentSessionId: worker.agentSessionId, originalCreationKey: 'controlled-original-key', runtimeId: 'learning-runtime', admittedAt: session.updatedAt,
      source: { kind: 'prepared-dispatch' as const }, historicalEffect: 'unknown' as const, initialInputContinuation: 'held' as const, outcome: 'fenced' as const } } : {}) }
  expect(() => parseCreationInspection(projection)).not.toThrow()
  const inspect = f.core.inspectAgentCreation.bind(f.core)
  vi.spyOn(f.core, 'inspectAgentCreation').mockImplementation(target => typeof target === 'string' && target === worker.agentSessionId ? Promise.resolve(projection) : inspect(target))
  const result = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: operation.operationId })).operation!
  expect(result.proposer, 'an unavailable current creation observation cannot erase the original created fact').toEqual(worker)
  expect(result.unavailable).toContainEqual(expect.objectContaining({ code: 'LEARNING_CREATION_UNCONFIRMED' }))
  expect(f.started).toHaveLength(1)
})

async function retireHistory(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const session = (await f.store.readMetadata(id))!
  const reservation: Extract<AgentMuxLifecycleReservation, { kind: 'stop' }> = { kind: 'stop', agentSessionId: id,
    expectedRun: session.run, operationId: 'retirement-' + id, reservationId: 'reservation-' + id, ownerId: 'private-history-owner',
    ownerPid: process.pid, expiresAt: Date.now() + 60_000,
    stopOperation: { daemonInstance: 'fixture-runtime', operationKey: 'retirement-' + id, runId: session.run.runId } }
  // Exact typed retirement projection; this test is not Native Stop evidence.
  await f.store.reserveLifecycle(reservation); await f.store.commitLifecycle(reservation, null)
  return f.core.inspectAgentCreation(id)
}

it('keeps committed worker observations and retired source history usable through the original public owner', async () => {
  const f = await fixture(), operation = await f.prepare()
  expect(operation.proposer).toMatchObject({ state: 'created', runId: 'fixture-run-0' })
  const source = (await f.store.readMetadata('source'))!
  await f.store.compareAndSwapMetadata(source, { ...source, creation: { createOperationId: 'original-source-create', initialPrompt: 'not-requested' } })
  expect((await retireHistory(f, 'source')).kind).toBe('retired-agent')
  const next = (await f.client.call('agent.learning.prepare', { operationId: 'retired-source-extraction', source: { hostId: 'local', agentSessionId: 'source' }, executorId: 'saved' })).operation
  expect(next.proposer.state).toBe('created')
  const retired = await retireHistory(f, operation.proposer.agentSessionId)
  expect(retired.kind).toBe('retired-agent')
  const observed = (await f.client.call('agent.learning.inspect', { hostId: 'local', operationId: operation.operationId })).operation!
  expect(observed.proposer).toMatchObject({ state: 'retired', runId: operation.proposer.runId })
  expect(observed.unavailable).toEqual([])
  expect(f.started).toHaveLength(2)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
