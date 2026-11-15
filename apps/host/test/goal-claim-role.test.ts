import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openDemandStore } from '@agentmux/demand'
import { goalTicketSigner } from '@agentmux/demand/goal-ticket-crypto'
import { projectGoalPlan } from '@agentmux/demand/goal-plan'
import type { DemandAgentReference } from '@agentmux/demand/relations'
import { changeGoalPlanAssignment } from '../src/goal-plan-assignment.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(assignee: DemandAgentReference) {
  const root = await mkdtemp(join(tmpdir(), 'amux-role-')); roots.push(root)
  const owner = { runtimeId: 'goal-runtime', namespace: 'goal-namespace' }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const key = publicKey.export({ type: 'spki', format: 'der' })
  const signer = goalTicketSigner(owner, key.toString('base64url'), createHash('sha256').update(key).digest('hex'), privateKey)
  const store = openDemandStore({ root, goalTicketSigner: async () => signer }), person = { kind: 'user' as const, id: 'person' }
  await store.create({ id: 'goal', title: 'Exact source', sessionIds: [assignee], assigneeSessionIds: [assignee] })
  await store.proposeAlignment('goal', { summary: 'Prepare', criteria: [{ id: 'a', text: 'Checked' }], openQuestions: [] })
  const node = { id: 'a', outcome: 'Checked', title: 'Prepare', check: 'check', criterionIds: ['a'], dependsOn: [], executor: null }
  const { demand } = await store.revisePlan('goal', { operationId: 'revision', expectedRevision: 0, alignmentRevision: 1, nodes: [node, { ...node, id: 'b' }] }, person)
  const [first, second] = demand.plan!.nodes.map(item => item.id)
  const act = async (nodeId: string, operationId: string, runtimeId: string, hostId = 'worker-host') => {
    const goal = (await store.get('goal'))!
    const claimToken = projectGoalPlan(goal.plan!, [], goal.alignment!.criteria, { ...owner, goalId: goal.id }).nodes.find(item => item.node.id === nodeId)?.claimToken
    expect(claimToken).toBeTruthy()
    return changeGoalPlanAssignment(store, { locateGoalAgentHost: () => 'worker-host' },
      { goalId: 'goal', nodeId, operationId, claimToken: claimToken! }, {},
      { actor: { kind: 'agent', id: 'worker' }, runtimeId, hostId }, owner)
  }
  const open = (nodeId: string, revision: number) => changeGoalPlanAssignment(store, {},
    { goalId: 'goal', nodeId, operationId: 'open-' + nodeId, expectedRevision: revision, assignment: { kind: 'open' } }, {}, { actor: person })
  return { act, open, store, first: first!, second: second! }
}

it('uses the execution Runtime of a Source-qualified work role, including when a namesake uses the same Host alias', async () => {
  const f = await fixture({ kind: 'space-member', execution: { runtimeId: 'worker-runtime', agentSessionId: 'worker' },
    source: { runtimeId: 'source-runtime', spaceId: 's', regionId: 'r', admission: { kind: 'association', operationId: 'original' } } })
  await f.open(f.first, 1)
  await expect(f.act(f.first, 'namesake', 'another-runtime')).rejects.toThrow('no work role')
  await f.act(f.first, 'claim', 'worker-runtime')
  expect((await f.store.get('goal'))!.plan!.nodes[0]!.executor).toEqual({ hostId: 'worker-host', agentSessionId: 'worker' })
})

it('pins bare work roles to the unique Host and the Runtime on the original claim, without granting future management rights', async () => {
  const f = await fixture('worker')
  await f.open(f.first, 1)
  await expect(f.act(f.first, 'wrong-host', 'worker-runtime', 'other-host')).rejects.toThrow('original assignee Host')
  await f.act(f.first, 'claim-a', 'worker-runtime')
  await expect(changeGoalPlanAssignment(f.store, {}, { goalId: 'goal', nodeId: f.second, expectedRevision: 3, operationId: 'self-promotion', assignment: { kind: 'open' } },
    {}, { actor: { kind: 'agent', id: 'worker' }, hostId: 'worker-host', runtimeId: 'worker-runtime' })).rejects.toThrow('current Supervisor')
  await f.open(f.second, 3)
  await expect(f.act(f.second, 'new-runtime', 'different-runtime')).rejects.toThrow('original assignee Host')
  await f.act(f.second, 'claim-b', 'worker-runtime')
})
