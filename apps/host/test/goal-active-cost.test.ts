import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DemandStore } from '@agentmux/demand'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const release of cleanup.splice(0).reverse()) await release(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('reads only current work at the original owner after a cold restart and keeps historical reads', async () => {
  const owner = await crossHostOwner(cleanup, 'active-plan', ['supervisor', 'worker', 'observer'])
  const goalId = (await owner.call('supervisor', ['goal', 'create', '--title', 'Active work', '--status', 'in_progress',
    '--assignees', JSON.stringify(['supervisor', 'worker']), '--related', JSON.stringify(['observer']),
    '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])).goal.id
  await owner.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({
    summary: 'Read only the relevant work', criteria: [{ id: 'work', text: 'A file exists' }], openQuestions: [],
  })])
  const node = { id: 'open', title: 'Make the file', outcome: 'A delivered file', check: 'Read the file', dependsOn: [], criterionIds: ['work'], executor: null }
  const published = await owner.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: { operationId: 'define-work', expectedRevision: 0, alignmentRevision: 1,
    nodes: [node, { ...node, id: 'closed', cancelled: true }, { ...node, id: 'waiting', dependsOn: [node.id] }] } })
  const id = published.plan.nodes[0].id
  const opened = await owner.call('supervisor', ['goal', 'plan', 'assignment', '--input', '-'], {
    goalId, nodeId: id, expectedRevision: 1, operationId: 'open-work', assignment: { kind: 'open' },
  })
  const secondId = (await owner.call('observer', ['goal', 'create', '--title', 'Independent work', '--status', 'in_progress',
    '--assignees', '["observer"]', '--supervisor', 'observer', '--risk', 'low', '--confirm', 'user'])).goal.id
  await owner.call(null, ['goal', 'update', '--goal', secondId, '--alignment', JSON.stringify({
    summary: 'Independent work', criteria: [{ id: 'work', text: 'A report exists' }], openQuestions: [],
  })])
  await owner.call('observer', ['goal', 'plan', 'revise', '--input', '-'], { goalId: secondId,
    revision: { operationId: 'define-report', expectedRevision: 0, alignmentRevision: 1, nodes: [{ ...node, title: 'Write the report' }] } })
  const working = ['goal', 'plan', 'active']
  const initial = await owner.call('worker', working)
  expect(initial.goals).toHaveLength(1)
  expect(initial.goals[0].nodes.map((item: { nodeId: string }) => item.nodeId)).toEqual([id])
  const claimToken = opened.planState.nodes[0].claimToken
  expect(initial.goals[0].nodes[0].claimToken).toBe(claimToken)
  const original = new DemandStore({ root: join(owner.original.root, 'demands') })
  const old = await stat(original.storePath)
  const archives = []
  for (const title of ['Archived input', 'Archived handoff', 'Archived result']) archives.push(await original.create({
    title, description: 'archived evidence '.repeat(30_000), status: 'done',
  }))
  expect((await stat(original.storePath)).size).toBeGreaterThan(old.size + 1_000_000)
  await owner.stop(); await owner.start()
  const store = DemandStore.prototype as unknown as { readConfirmedSnapshot(): Promise<unknown> }
  const fullRead = vi.spyOn(store, 'readConfirmedSnapshot')
  try {
    const cold = await owner.call('worker', working)
    expect(cold).toEqual(initial)
    expect(await owner.call('worker', working)).toEqual(initial)
    expect(await owner.call('observer', working)).toMatchObject({ goals: [] })
    const managed = await owner.call(null, [...working, '--goal', goalId])
    expect(managed.goals[0].nodes).toEqual([{ nodeId: id, title: node.title, state: 'ready', unknown: [], predecessors: [] }])
    const allManaged = await owner.call(null, [...working, '--view', 'manage'])
    expect(allManaged.goals.map((entry: { goalId: string }) => entry.goalId)).toEqual([goalId, secondId].sort())
    expect(allManaged.goals.find((entry: { goalId: string }) => entry.goalId === goalId)).toEqual(managed.goals[0])
    expect(allManaged).toEqual(await owner.rpc.call('goal.plan.active', { view: 'manage' }))
    expect(await owner.call('supervisor', [...working, '--view', 'manage'])).toEqual(managed)
    expect(await owner.call('worker', [...working, '--view', 'manage'])).toMatchObject({ goals: [] })
    expect(fullRead, 'active reads must skip the original full snapshot').not.toHaveBeenCalled()
  } finally { fullRead.mockRestore() }
  await owner.call('worker', ['goal', 'plan', 'claim', '--goal', goalId, '--node', id, '--claim-token', claimToken, '--operation-id', 'claim-work'])
  expect(await owner.call('worker', working)).toMatchObject({ goals: [] })
  expect((await owner.call(null, ['goal', 'plan', '--goal', goalId])).plan.nodes).toHaveLength(3)
  const archiveId = archives[0]!.demand.id
  expect((await owner.call(null, ['goal', 'inspect', '--goal', archiveId])).goal.id).toBe(archiveId)
})
