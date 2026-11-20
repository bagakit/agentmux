import { goalTickets } from './helpers/goal-tickets.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { seedStoredDemand } from '../../../test/fixtures/stored-demand.mjs'
import { delegationWorkerHostId, parseDemandDelegationIntent, type DemandDelegationIntent } from '../src/delegations.js'
import { demandExecutionReferences } from '../src/responsibility.js'
import { projectGoalPlan } from '../src/goal-plan.js'

let root: string, store: ReturnType<typeof openDemandStore>
let tickets: ReturnType<typeof goalTickets>
const criteria = [{ id: 'original', text: 'Deliver the original result' }]
const intent = (worker = 'worker'): DemandDelegationIntent => ({ operationId: 'original-delegation', sourceMessageId: 'original-source',
  hostId: 'owner-host', workerHostId: 'worker-host', ownerAgentSessionId: 'owner', workerAgentSessionId: worker,
  ownerRunId: 'owner-run', workerRunId: 'worker-run', threadId: 'original-thread', text: 'Deliver the original result', alignmentRevision: 1, criterionIds: ['original'] })
const node = (id: string, dependsOn: string[] = [], agentSessionId = 'worker') => ({ id, title: id, outcome: 'Deliver the original result',
  dependsOn, criterionIds: ['original'], check: 'pnpm test result', executor: { hostId: 'worker-host', agentSessionId } })
const review = { operationId: 'original-review', nodeId: 'work', delegationOperationId: 'original-delegation', verdict: 'pass' as const,
  check: { command: 'pnpm test result', result: 'passed', evidence: ['artifacts/result.log'] }, note: '' }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'goal-delegation-hosts-')); tickets = goalTickets(root); store = tickets.store
  await seedStoredDemand(store, { id: 'goal', title: 'One Goal', sessionIds: ['owner', 'worker'], assigneeSessionIds: ['owner', 'worker'], supervisorSessionId: 'owner' })
  await store.proposeAlignment('goal', { summary: 'Original target', criteria, openQuestions: [] })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('retains a shared-Host record and freezes a distinct worker Host through persistence and replay', async () => {
  const task = intent(), { workerHostId: _remote, ...legacy } = task
  expect(delegationWorkerHostId(parseDemandDelegationIntent(legacy))).toBe('owner-host')
  await store.prepareDelegation('goal', task, 'owner')
  let signingReads = 0
  const reopened = openDemandStore({ root, goalTicketSigner: async () => { signingReads++; throw new Error('The Ticket signer is offline') } })
  const saved = (await reopened.inspectDelegation('goal', task.operationId))!
  await expect(reopened.confirmDelegationSubmission('goal', saved)).resolves.toEqual({})
  expect(signingReads).toBe(0)
  expect(saved.workerHostId).toBe('worker-host')
  expect(delegationWorkerHostId(saved)).toBe('worker-host')
  expect((await reopened.prepareDelegation('goal', task, 'owner')).replayed).toBe(true)
  await expect(reopened.prepareDelegation('goal', { ...task, workerHostId: 'another-host' }, 'owner')).rejects.toThrow('original delegation identity')
  expect(demandExecutionReferences((await reopened.get('goal'))!)[0]).toMatchObject({ hostId: 'worker-host', agentSessionId: 'worker', runId: 'worker-run' })
})

it('keeps old persisted records usable without rewriting their shared-Host identity', async () => {
  const { workerHostId: _remote, ...legacy } = intent()
  await store.prepareDelegation('goal', legacy, 'owner')
  const reopened = openDemandStore({ root }), saved = (await reopened.inspectDelegation('goal', legacy.operationId))!
  expect(saved).not.toHaveProperty('workerHostId')
  expect(delegationWorkerHostId(saved)).toBe('owner-host')
  expect((await reopened.prepareDelegation('goal', { ...legacy, workerHostId: 'owner-host' }, 'owner')).replayed).toBe(true)
})

it('matches a plan executor against the exact worker Host, while the original owner stays on its Host', async () => {
  await tickets.revise('goal', { operationId: 'plan', expectedRevision: 0, alignmentRevision: 1, nodes: [node('work')] }, { kind: 'agent', id: 'owner', hostId: 'owner-host' })
  const task = { ...intent(), planNodeId: tickets.id('work') }
  await expect(store.prepareDelegation('goal', { ...task, workerHostId: 'owner-host' }, 'owner')).rejects.toThrow('names worker on worker-host')
  await store.prepareDelegation('goal', task, 'owner')
  expect((await store.inspectDelegation('goal', task.operationId))!.hostId).toBe('owner-host')
})

it('distinguishes the same Session id on two Hosts for delegation and independent review', async () => {
  await tickets.revise('goal', { operationId: 'plan', expectedRevision: 0, alignmentRevision: 1,
    nodes: [node('work', [], 'owner'), node('next', ['work'], 'worker')] }, { kind: 'agent', id: 'owner', hostId: 'owner-host' })
  const task = { ...intent('owner'), planNodeId: tickets.id('work') }
  await store.prepareDelegation('goal', task, 'owner')
  await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner')
  await tickets.submit('goal', task.operationId, { operationId: 'worker-report', replyMessageId: 'worker-reply', authorAgentSessionId: 'owner',
    grounding: { alignmentRevision: 1, summary: 'Delivered', checks: [{ criterionId: 'original', outcome: 'met', evidence: ['artifacts/result.log'], note: '' }] } }, 'owner')
  await expect(tickets.review('goal', review, { kind: 'agent', id: 'owner', hostId: 'worker-host' })).rejects.toThrow('cannot review its own work')
  await tickets.review('goal', review, { kind: 'agent', id: 'owner', hostId: 'owner-host' })
  const saved = (await openDemandStore({ root }).get('goal'))!
  expect(saved.plan!.reviews[0]!.reviewer).toEqual({ kind: 'agent', id: 'owner', hostId: 'owner-host' })
  expect(projectGoalPlan(saved.plan!, saved.delegations!, criteria).nodes.map(item => item.state)).toEqual(['done', 'ready'])
})

it('retains verified Runtime references and rejects the worker under a second Host alias', async () => {
  await tickets.revise('goal', { operationId: 'plan', expectedRevision: 0, alignmentRevision: 1,
    nodes: [node('work'), node('next', ['work'])] }, { kind: 'agent', id: 'owner', hostId: 'owner-host', runtimeId: 'owner-runtime' })
  const task = { ...intent(), planNodeId: tickets.id('work') }, runtimeIdentity = { ownerRuntimeId: 'owner-runtime', workerRuntimeId: 'worker-runtime' }
  expect(() => parseDemandDelegationIntent({ ...task, runtimeIdentity })).toThrow('unsupported')
  await store.prepareDelegation('goal', task, 'owner')
  await store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner', runtimeIdentity)
  await expect(store.linkDelegation('goal', task.operationId, task.sourceMessageId, 'owner', { ...runtimeIdentity, workerRuntimeId: 'other-runtime' })).rejects.toThrow('Runtime identities differ')
  await tickets.submit('goal', task.operationId, { operationId: 'worker-report', replyMessageId: 'worker-reply', authorAgentSessionId: 'worker',
    grounding: { alignmentRevision: 1, summary: 'Delivered', checks: [{ criterionId: 'original', outcome: 'met', evidence: ['artifacts/result.log'], note: '' }] } }, 'worker')
  await expect(tickets.review('goal', review, { kind: 'agent', id: 'worker', hostId: 'second-worker-alias', runtimeId: 'worker-runtime' })).rejects.toThrow('cannot review its own work')
  await expect(tickets.review('goal', review, { kind: 'agent', id: 'reviewer', hostId: 'review-host' })).rejects.toThrow('Runtime is not yet confirmed')
  await tickets.review('goal', review, { kind: 'agent', id: 'worker', hostId: 'other-host', runtimeId: 'independent-runtime' })
  const saved = (await openDemandStore({ root }).get('goal'))!
  expect(saved.delegations![0]!.runtimeIdentity).toEqual(runtimeIdentity)
  expect(saved.plan!.reviews[0]!.reviewer.runtimeId).toBe('independent-runtime')
  expect((await tickets.review('goal', review, { kind: 'agent', id: 'worker', hostId: 'second-independent-alias', runtimeId: 'independent-runtime' })).replayed).toBe(true)
  expect(projectGoalPlan(saved.plan!, saved.delegations!, criteria).nodes.map(item => item.state)).toEqual(['done', 'ready'])
})
