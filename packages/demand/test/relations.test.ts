import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { parseDemandDelegations } from '../src/delegations.js'
import { parseDemandProgressUpdates } from '../src/responsibility.js'
import { demandRelationKey, projectDemandRelations, type GoalRelationSource } from '../src/relations.js'
import { fixtureEpoch as _historyTailFixtureEpoch } from '../../../test/fixture-values.mjs'

const goal = (extra: Partial<GoalRelationSource> = {}): GoalRelationSource => ({ id: 'original-goal', title: 'Original Goal', status: 'in_progress', ...extra })
const participation = (id: string, hostId: string, kind: 'create' | 'discussion' | 'requirements' = 'discussion') => ({
  id, operationId: id, hostId, agentSessionId: 'shared-session', kind, entryPoint: 'original-entry', recordedAt: _historyTailFixtureEpoch(0, 0, 1)
})
const dispatch = (operationId: string, hostId: string, agentSessionId = 'shared-session') => ({
  operationId, hostId, agentSessionId, runId: 'original-run', execution: 'finite' as const, prompt: 'Original request',
  stage: 'unknown' as const, preparedAt: _historyTailFixtureEpoch(0, 0, 1), submittedAt: _historyTailFixtureEpoch(0, 0, 2)
})

it('projects original persisted business facts without upgrading bare assignments to either Host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'goal-relations-'))
  try {
    const store = openDemandStore({ root })
    await store.create({ id: 'original-goal', title: 'Original Goal', assigneeSessionIds: ['shared-session'], supervisorSessionId: 'shared-session' })
    const { stage: _stage, preparedAt: _preparedAt, submittedAt: _submittedAt, ...intent } = dispatch('start-a', 'host-a')
    await store.prepareDispatch('original-goal', intent)
    await store.recordParticipation('original-goal', { kind: 'discussion', agentSessionId: 'shared-session', hostId: 'host-b', entryPoint: 'original-entry' }, { operationId: 'discussion-b' })
    const before = await store.snapshot(), result = projectDemandRelations(before.demands)
    expect(result.qualified.get(demandRelationKey('host-a', 'shared-session'))?.[0]?.roles.map(role => role.kind)).toEqual(['execution'])
    expect(result.qualified.get(demandRelationKey('host-b', 'shared-session'))?.[0]?.roles.map(role => role.kind)).toEqual(['discussion'])
    expect(result.qualified.has(demandRelationKey('host-c', 'shared-session'))).toBe(false)
    expect(result.unqualified.get('shared-session')?.[0]?.roles.map(role => role.kind)).toEqual(['related', 'assignee', 'supervisor'])
    expect(await store.snapshot()).toEqual(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('deduplicates the original Goal while retaining every distinct role and provenance', () => {
  const original = goal({ participations: [participation('create-original', 'host-a', 'create'), participation('discussion-first', 'host-a'),
    participation('discussion-second', 'host-a'), participation('requirements-original', 'host-a', 'requirements')],
    dispatches: [dispatch('start-original', 'host-a')], assigneeSessionIds: ['shared-session', 'shared-session'] })
  const result = projectDemandRelations([original, original])
  const exact = result.qualified.get(demandRelationKey('host-a', 'shared-session'))!
  expect(exact).toHaveLength(1)
  expect(exact[0]!.roles.map(role => [role.kind, role.source.kind, role.source.id])).toEqual([
    ['create', 'participation', 'create-original'], ['discussion', 'participation', 'discussion-first'],
    ['discussion', 'participation', 'discussion-second'], ['requirements', 'participation', 'requirements-original'],
    ['execution', 'dispatch', 'start-original']
  ])
  expect(result.unqualified.get('shared-session')).toEqual([{ goalId: original.id, title: original.title, status: original.status,
    roles: [{ kind: 'assignee', source: { kind: 'assignment', id: 'assigneeSessionIds' } }] }])
})

it.each(['done', 'cancelled'] as const)('retains %s and historical participation without calling it current execution', status => {
  const result = projectDemandRelations([goal({ status, participations: [participation('historical-record', 'host-a', 'requirements')] })])
  expect(result.qualified.get(demandRelationKey('host-a', 'shared-session'))).toEqual([{ goalId: 'original-goal', title: 'Original Goal', status,
    roles: [{ kind: 'requirements', source: { kind: 'participation', id: 'historical-record' } }] }])
  expect(result.unqualified.size).toBe(0)
})

it('keeps source-qualified delegation, Supervisor and progress targets separate from an unqualified author', () => {
  const execution = { kind: 'delegation' as const, operationId: 'delegation-original', hostId: 'worker-host', agentSessionId: 'worker', runId: 'worker-run' }
  const original = goal({
    delegations: [{ operationId: 'delegation-original', sourceMessageId: 'source-original', hostId: 'worker-host', ownerAgentSessionId: 'owner',
      workerAgentSessionId: 'worker', ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'original-thread', text: 'Original task', alignmentRevision: 1,
      criterionIds: ['original-criterion'], preparedAt: _historyTailFixtureEpoch(0, 0, 1), linkedAt: _historyTailFixtureEpoch(0, 0, 1), capturedCriteria: [{ id: 'original-criterion', text: 'Original criterion' }], attention: { operationId: 'attention-original', intentId: 'notice-original',
        hostId: 'worker-host', supervisorAgentSessionId: 'supervisor', supervisorRunId: 'supervisor-run', occurrenceAt: _historyTailFixtureEpoch(0, 0, 1), agentMuxNote: 'Original notice', preparedAt: _historyTailFixtureEpoch(0, 0, 1) } }],
    progressUpdates: [{ operationId: 'progress-original', execution, expectedScope: 'original-scope', phase: 'handed-off', summary: 'Original progress',
      evidence: [], nextAction: 'Read the original result', author: { kind: 'agent', id: 'manager-without-host' }, reportingRunId: 'manager-run',
      recordedAt: _historyTailFixtureEpoch(0, 0, 1), basis: { stateEnteredAt: null, activityRevision: null, inputSubmissionId: null }, managerVerified: true,
      handoffExecution: { ...execution, operationId: 'handoff-original', hostId: 'target-host', agentSessionId: 'target', runId: 'target-run' } }]
  })
  expect(parseDemandDelegations(original.delegations)).toEqual(original.delegations)
  expect(parseDemandProgressUpdates(original.progressUpdates)).toEqual(original.progressUpdates)
  const result = projectDemandRelations([original])
  const roles = (hostId: string, sid: string) => result.qualified.get(demandRelationKey(hostId, sid))?.[0]?.roles.map(role => role.kind)
  expect(roles('worker-host', 'worker')).toEqual(['delegation-worker', 'execution-progress'])
  expect(roles('worker-host', 'owner')).toEqual(['delegation-owner'])
  expect(roles('worker-host', 'supervisor')).toEqual(['supervisor'])
  expect(roles('target-host', 'target')).toEqual(['execution-handoff'])
  expect([...result.qualified.keys()].some(key => key.includes('manager-without-host'))).toBe(false)
})

it('reads an immutable original iterator once and keeps continuation provenance without inspecting loops', () => {
  const original = goal({ dispatches: [{ ...dispatch('continue-original', 'host-a'), execution: 'continue', loopId: 'original-loop', alignmentRevision: 1 }],
    sessionIds: ['bare-session'], participations: [participation('source-original', 'host-a')] })
  const freeze = (value: unknown): void => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value) } }
  freeze(original)
  let reads = 0
  function* inputs() { reads++; yield original }
  const result = projectDemandRelations(inputs())
  expect(reads).toBe(1)
  expect(result.qualified.get(demandRelationKey('host-a', 'shared-session'))?.[0]?.roles.map(role => role.kind)).toEqual(['discussion', 'execution', 'continuation'])
  expect(result.unqualified.get('bare-session')?.[0]?.roles.map(role => role.kind)).toEqual(['related'])
  expect(projectDemandRelations([]).qualified.size).toBe(0)
})

it('exposes the browser-safe public package entry without importing a Runtime or filesystem owner', async () => {
  const publicApi = await import('@agentmux/demand/relations')
  const result = publicApi.projectDemandRelations([goal({ sessionIds: ['bare-session'] })])
  expect(publicApi.demandRelationKey('host-a', 'shared-session')).not.toBe(publicApi.demandRelationKey('host-b', 'shared-session'))
  expect(result.qualified.size).toBe(0)
  expect(result.unqualified.get('bare-session')?.[0]?.goalId).toBe('original-goal')
})
