import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { openDemandStore } from '../src/demand-store.js'
import { parseDemandDispatch, type DemandQualifiedDispatchIntent } from '../src/dispatch.js'
import { demandExecutionReferences } from '../src/responsibility.js'
import type { DemandSpaceMemberReference } from '../src/relations.js'

const cleanup: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of cleanup.splice(0)) await rm(root, { recursive: true, force: true }) })
const target: DemandSpaceMemberReference = { kind: 'space-member', source: { runtimeId: 'B', spaceId: 'space', regionId: 'region', admission: { kind: 'creation', operationId: 'C' } }, execution: { runtimeId: 'D', agentSessionId: 'SID' } }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-domain-request-')); cleanup.push(root)
  const one = openDemandStore({ root }), two = openDemandStore({ root })
  const goal = (await one.create({ id: 'goal', title: 'Original title', description: '  Original body\n ', assigneeSessionIds: [target] })).demand
  return { root, one, two, goal }
}

it('the original transaction returns one fresh receipt across independent owners and freezes original content before any Run', async () => {
  const { one, two, goal } = await fixture(), input = { operationId: 'OP', target }
  const receipts = await Promise.all([one.requestDispatch(goal.id, input, goal.updatedAt), two.requestDispatch(goal.id, input, goal.updatedAt)])
  expect(receipts.filter(value => value.replayed === true)).toHaveLength(1)
  const saved = await one.inspectDispatch(goal.id, 'OP')
  expect(saved).toMatchObject({ stage: 'requested', prompt: 'Original body', target, request: { goalUpdatedAt: goal.updatedAt } })
  for (const field of ['runId', 'preparedAt', 'agentMuxNote', 'receipt']) expect(saved).not.toHaveProperty(field)
  await one.update(goal.id, { description: 'Changed later', assigneeSessionIds: [] })
  const repeated = await two.requestDispatch(goal.id, input, 0)
  expect(repeated.replayed).toBe(true); expect(await two.inspectDispatch(goal.id, 'OP')).toEqual(saved)
  expect(demandExecutionReferences(repeated.demand)).toEqual([])
})

it('promotion freezes the real Run/note once, preserving request origin and refusing a different Run or phase on Run-less records', async () => {
  const { one, two, goal } = await fixture()
  await one.requestDispatch(goal.id, { operationId: 'OP', target }, goal.updatedAt)
  const requested = (await one.inspectDispatch(goal.id, 'OP'))!
  await expect(one.recordDispatchPhase(goal.id, 'OP', { stage: 'submitted' })).rejects.toThrow('no prepared input')
  const intent: DemandQualifiedDispatchIntent = { operationId: 'OP', target, execution: 'finite', runId: 'actual-Run', prompt: requested.prompt!, agentMuxNote: 'Original note: actual-Run' }
  await two.prepareDispatch(goal.id, intent)
  const prepared = (await one.inspectDispatch(goal.id, 'OP'))!
  expect(prepared).toMatchObject({ ...intent, stage: 'prepared', resultBasis: requested.resultBasis })
  expect('request' in prepared && prepared.request).toEqual('request' in requested && requested.request)
  await expect(one.prepareDispatch(goal.id, { ...intent, runId: 'another-Run' })).rejects.toThrow('another Goal, Session, Run or input')
  expect(await two.inspectDispatch(goal.id, 'OP')).toEqual(prepared)
})

it('the existing root OP owner refuses another Goal and target without overwriting the original', async () => {
  const { one, two, goal } = await fixture()
  await one.create({ id: 'other', title: 'Other', assigneeSessionIds: [target] })
  await one.requestDispatch(goal.id, { operationId: 'OP', target })
  const saved = await one.inspectDispatch(goal.id, 'OP')
  await expect(two.requestDispatch('other', { operationId: 'OP', target })).rejects.toThrow('another Goal or member')
  await expect(two.requestDispatch(goal.id, { operationId: 'OP', target: { ...target, execution: { ...target.execution, runtimeId: 'other-D' } } })).rejects.toThrow('another Goal or member')
  expect(await two.inspectDispatch(goal.id, 'OP')).toEqual(saved)
  expect(await two.inspectDispatch('other', 'OP')).toBeNull()
})

it('version and assignee refusals are immutable business outcomes without invented body or input', async () => {
  const { one, two, goal } = await fixture()
  await one.requestDispatch(goal.id, { operationId: 'wrong-version', target }, goal.updatedAt - 1)
  const rejected = (await one.inspectDispatch(goal.id, 'wrong-version'))!
  expect(rejected).toMatchObject({ stage: 'rejected', expectedUpdatedAt: goal.updatedAt - 1, observedGoalUpdatedAt: goal.updatedAt,
    rejection: { kind: 'goal-start-version-conflict', goalId: goal.id, operationId: 'wrong-version', currentUpdatedAt: goal.updatedAt } })
  for (const field of ['prompt', 'runId', 'preparedAt', 'agentMuxNote', 'receipt']) expect(rejected).not.toHaveProperty(field)
  await two.requestDispatch(goal.id, { operationId: 'wrong-version', target })
  expect(await two.inspectDispatch(goal.id, 'wrong-version')).toEqual(rejected)
  await expect(one.prepareDispatch(goal.id, { operationId: 'wrong-version', target, execution: 'finite', runId: 'invented', prompt: goal.description })).rejects.toThrow()
  await one.update(goal.id, { assigneeSessionIds: [] })
  await one.requestDispatch(goal.id, { operationId: 'wrong-assignee', target }, 0)
  const assignee = await two.inspectDispatch(goal.id, 'wrong-assignee')
  expect(assignee).toMatchObject({ stage: 'rejected', rejection: { kind: 'goal-start-assignee-conflict', target } })
  const snapshot = await one.get(goal.id)
  for (const invalid of [-1, 1.5, NaN, Infinity]) await expect(one.requestDispatch(goal.id, { operationId: 'invalid', target }, invalid)).rejects.toThrow('version is invalid')
  expect(await one.get(goal.id)).toEqual(snapshot)
  expect(() => parseDemandDispatch({ ...rejected, rejection: { ...(rejected.stage === 'rejected' ? rejected.rejection : {}), operationId: 'other' } }, goal.id)).toThrow()
  expect(() => parseDemandDispatch(rejected, 'other-goal')).toThrow()
  expect(() => parseDemandDispatch({ ...rejected, runId: 'fake' })).toThrow()
  expect(demandExecutionReferences(snapshot!)).toEqual([])
})

it('each new business request uses one original snapshot replacement and file-plus-directory fsync, with no second ledger', async () => {
  const { root, one, goal } = await fixture(), syncs: string[] = [], opened = fs.open.bind(fs)
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await opened(...args), sync = handle.sync.bind(handle)
    handle.sync = async () => { syncs.push(String(args[0])); return sync() }
    return handle
  })
  const before = JSON.parse(await fs.readFile(one.storePath, 'utf8'))
  await one.requestDispatch(goal.id, { operationId: 'one-snapshot', target }, goal.updatedAt)
  const after = JSON.parse(await fs.readFile(one.storePath, 'utf8'))
  expect(after.revision).toBe(before.revision + 1)
  expect(syncs.filter(value => value.startsWith(one.storePath + '.tmp-'))).toHaveLength(1)
  expect(syncs.filter(value => value === root)).toHaveLength(1)
  expect(syncs).toHaveLength(2)
})
