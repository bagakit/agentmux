import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDemandStore } from '@agentmux/demand'
import { createGoalParticipationOwner } from '../src/goal-participation-owner.js'
import { goalPmoOperation } from '../src/goal-pmo-origin.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'goal-participation-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const demands = openDemandStore({ root })
  const intent = { goalId: 'original-goal', creationOperationId: 'original-goal-creation' }, operationId = await goalPmoOperation(intent, 'create')
  await demands.create({ id: 'original-goal', title: 'Original Goal' }, { operationId: 'original-goal-creation', discussionOperationId: operationId, creationOrigin: { requesterAsSupervisor: true } })
  const input = { ...intent, hostId: 'original-host', agentSessionId: 'original-session', expectedRun: { runId: 'original-run' }, operationId, evidence: 'creation-input' as const }
  const creation = { createOperationId: operationId, createdRun: input.expectedRun, initialPrompt: 'confirmed' }
  let promptReceipt: unknown, originalMessage: unknown, role = true, beforeSource: (() => Promise<void>) | undefined
  const client = { inspectAgentCreation: async () => ({ kind: 'agent', agentSessionId: input.agentSessionId, workspacePath: root, run: { runId: 'later-run' }, creation }),
    inspectAgentPromptSubmission: async () => promptReceipt, readMessage: async () => originalMessage, authorizeAgentCaller: async () => ({ agentSessionId: input.agentSessionId }) }
  const owner = createGoalParticipationOwner({ demands, client: () => client as never, discussion: async () => role, activeContinuation: async () => false,
    source: async (hostId, agentSessionId) => { await beforeSource?.(); return { kind: 'discussion', hostId, agentSessionId, entryPoint: 'original-source' } } })
  return { demands, owner, input, creation, client, setMessage: (value: unknown) => { originalMessage = value }, role: (value: boolean) => { role = value }, setReceipt: (value: unknown) => { promptReceipt = value }, beforeSource: (value: () => Promise<void>) => { beforeSource = value } }
}
const context = { principal: { kind: 'user' as const, id: 'original-user' } }
it('confirms only the retained creation Run and preserves the same original creation source on repeat', async () => {
  const f = await fixture(), confirmed = await f.owner.confirm(f.input, context)
  expect(confirmed).toMatchObject({ operationId: f.input.operationId, diskDurability: 'confirmed', goal: { id: f.input.goalId, supervisorSessionId: f.input.agentSessionId } })
  expect(confirmed.goal.participations).toHaveLength(1)
  expect((await f.owner.confirm(f.input, context)).goal.participations).toEqual(confirmed.goal.participations)
  await expect(f.owner.confirm({ ...f.input, expectedRun: { runId: 'later-run' } }, context)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
})
it('does not infer a creation Run when Core has not retained its original provenance', async () => {
  const f = await fixture(); delete (f.creation as { createdRun?: unknown }).createdRun
  await expect(f.owner.confirm(f.input, context)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect((await f.demands.get(f.input.goalId))!.participations).toEqual([])
})
it('uses the exact Core input key, Run and acknowledged submission for later prompt provenance', async () => {
  const f = await fixture(), operationId = await goalPmoOperation(f.input, 'discussion')
  const input = { ...f.input, operationId, evidence: 'prompt-input' as const }
  const receipt = { agentSessionId: input.agentSessionId, run: input.expectedRun, admission: { submissionId: operationId, acknowledged: true,
    inputKey: { kind: 'prompt', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, submissionId: operationId }, intent: { run: input.expectedRun } } }
  f.setReceipt({ ...receipt, admission: { ...receipt.admission, inputKey: { ...receipt.admission.inputKey, expectedRun: { runId: 'another-run' } } } })
  await expect(f.owner.confirm(input, context)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect((await f.demands.get(input.goalId))!.participations).toEqual([])
  f.setReceipt(receipt)
  expect((await f.owner.confirm(input, context)).goal.participations).toHaveLength(1)
})
it('rejects another Agent caller and keeps the original Goal unchanged', async () => {
  const f = await fixture()
  await expect(f.owner.confirm(f.input, { caller: { agentSessionId: 'another-session', capability: 'another-capability' } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.demands.get(f.input.goalId))!.participations).toEqual([])
})
it('checks the original Goal version at the actual Store commit after asynchronous provenance work', async () => {
  const f = await fixture()
  f.beforeSource(async () => { await f.demands.update(f.input.goalId, { title: 'Later user edit' }) })
  await expect(f.owner.confirm(f.input, context)).rejects.toThrow('Goal changed')
  expect((await f.demands.get(f.input.goalId))!.participations).toEqual([])
})

it('the actual authenticated original creator records its child discussion without replacing a confirmed requester', async () => {
  const f = await fixture(), creator = { agentSessionId: 'original-parent', run: { runId: 'original-parent-run' } }
  const goal = (await f.demands.get(f.input.goalId))!
  await f.demands.prepareDiscussion(goal.id, f.input.operationId, { requestOperationId: 'original-discussion', mode: 'grill', executorId: 'codex', spaceId: 'original-space', zoneId: 'original-zone', agentMuxNote: 'Original context.', callerAgentSessionId: creator.agentSessionId }, goal.updatedAt)
  await f.demands.resolveCreationOrigin(goal.id, { creationOperationId: goal.creationOrigin!.operationId, sourceOperationId: 'original-parent-input', source: { kind: 'create', agentSessionId: creator.agentSessionId, hostId: f.input.hostId, entryPoint: 'original-create' } }, { expectedUpdatedAt: (await f.demands.get(goal.id))!.updatedAt, allowSupervisorDefault: true })
  Object.assign(f.creation, { createdBy: { ...creator, owner: { kind: 'local' } } })
  f.client.authorizeAgentCaller = async () => creator
  const { creationOperationId: _origin, ...input } = f.input
  const context = { caller: { agentSessionId: creator.agentSessionId, capability: 'original-verified-capability' } }
  const confirmed = await f.owner.confirm(input, context)
  expect(confirmed.goal.supervisorSessionId).toBe(creator.agentSessionId)
  expect(confirmed.goal.creationOrigin!.requesterParticipationId).toBe((await f.demands.get(goal.id))!.creationOrigin!.requesterParticipationId)
  expect(confirmed.goal.participations).toHaveLength(2)
  f.client.authorizeAgentCaller = async () => ({ ...creator, run: { runId: 'later-parent-run' } })
  await expect(f.owner.confirm(input, context)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.demands.get(goal.id))!.participations).toHaveLength(2)
})

it('an authored message needs both its original recipient role and exact native sender/Run receipt', async () => {
  const f = await fixture(), goal = (await f.demands.get(f.input.goalId))!, sender = { agentSessionId: 'actual-message-author', run: { runId: 'actual-author-run' } }
  await f.demands.prepareDiscussion(goal.id, f.input.operationId, { requestOperationId: 'original-discussion', mode: 'grill', executorId: 'codex', spaceId: 'original-space', zoneId: 'original-zone', agentMuxNote: 'Original context.' }, goal.updatedAt)
  const { creationOperationId: _origin, ...original } = f.input
  const input = { ...original, evidence: 'message-input' as const, operationId: 'original-authored-message' }
  f.client.authorizeAgentCaller = async () => sender
  const envelope = { messageId: 'original-native-message', operationId: input.operationId, sender: { kind: 'agent-session', agentSessionId: sender.agentSessionId }, senderSessionId: sender.agentSessionId, senderRunId: sender.run.runId,
    recipient: { kind: 'agent-session', agentSessionId: input.agentSessionId }, recipientSessionId: input.agentSessionId, recipientRunId: input.expectedRun.runId }
  const receipt = { agentSessionId: input.agentSessionId, run: input.expectedRun, admission: { submissionId: envelope.messageId, acknowledged: true,
    inputKey: { kind: 'message', agentSessionId: input.agentSessionId, expectedRun: input.expectedRun, messageId: envelope.messageId }, intent: { run: input.expectedRun, message: { authorAgentSessionId: sender.agentSessionId } } } }
  f.setReceipt(receipt); f.setMessage({ envelope }); f.role(false)
  await expect(f.owner.confirm(input, context)).rejects.toMatchObject({ code: 'CONTROL_UNAVAILABLE' })
  expect((await f.demands.get(goal.id))!.participations).toEqual([])
  f.role(true); f.setMessage({ envelope: { ...envelope, senderRunId: 'another-author-run' } })
  const caller = { caller: { agentSessionId: sender.agentSessionId, capability: 'actual-author-capability' } }
  await expect(f.owner.confirm(input, caller)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  f.setMessage({ envelope })
  expect((await f.owner.confirm(input, caller)).goal.participations).toHaveLength(1)
})
