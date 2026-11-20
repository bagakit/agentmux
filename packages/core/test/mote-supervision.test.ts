import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createMoteWorkThreadFixture, openMoteWorkThread } from './helpers/mote-work-thread.js'
import { serializeMoteQuickMode } from '../../../apps/host/src/mote-model.js'
import { parseMoteDialogueResult, MOTE_SUPERVISION_GUIDANCE } from '../src/mote/dialogue.js'
import { MOTE_INPUT_GUIDANCE } from '../src/mote/input-source.js'
import { MOTE_COORDINATION_ROLE } from '../../../apps/host/src/mote-topic-model.js'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentMuxCreationAuthority } from '../src/agent-creation-authority.js'
import { issueAgentCapability, hashAgentCapability } from '../src/agent-capability.js'
import { MoteDialogueStore } from '../src/mote/dialogue-store.js'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture() { const f = await createMoteWorkThreadFixture(); cleanup.push(f.close); return f }
const read = (f: Awaited<ReturnType<typeof fixture>>, extra = {}) => f.cli(['space','mote','dialogue','supervision','read','--input','-'], { target: f.target, ...extra })

it('actual source CLI reads the original first-task report without another launch, message or native input', async () => {
  const f = await fixture(), work = await openMoteWorkThread(f)
  const writes = f.writes.length, launches = f.launches.length
  const page = await read(f, { limit: 1 })
  expect(page.links).toEqual(work.page.links)
  expect(page.observations).toEqual([{ sequence: work.linked.links[0].sequence, communication: {
    originAwaits: false, events: [{ kind: 'worker_done', replyMessageId: 'first-work-result' }], replyMessageIds: ['first-work-result'], identityDiagnostics: [], goal: null }, issue: null }])
  expect(f.launches).toHaveLength(launches); expect(f.writes).toHaveLength(writes)
  expect((await f.client.readMessage({ messageId: work.messageId }))!.envelope.body).toBe('Research the original scoped outcome')
})

it('each source failure and a substituted original Dispatch remain unknown without hiding other readable sources', async () => {
  const f = await fixture(), work = await openMoteWorkThread(f)
  const before = await read(f), originalRead = f.client.readDispatch.bind(f.client)
  const failed = vi.spyOn(f.client, 'readDispatch').mockRejectedValueOnce(new Error('Original source is unavailable\nInspect the retained source'))
  const unavailable = await read(f)
  expect(unavailable.links).toEqual(before.links)
  expect(unavailable.observations[0]).toMatchObject({ communication: null, issue: 'Original source is unavailable\nInspect the retained source' })
  failed.mockRestore()
  const emptyFailure = vi.spyOn(f.client, 'readDispatch').mockRejectedValueOnce(new Error(''))
  expect((await read(f)).observations[0]).toMatchObject({ communication: null, issue: expect.stringContaining('original work source observation is unavailable') })
  emptyFailure.mockRestore()
  const replaced = vi.spyOn(f.client, 'readDispatch').mockImplementation(async input => {
    const original = await originalRead(input)
    return { ...original, dispatch: { ...original.dispatch, threadId: 'another-original-thread' } }
  })
  expect((await read(f)).observations[0].communication).toBeNull()
  replaced.mockRestore()
  expect((await read(f)).observations).toEqual(before.observations)
  expect((await f.client.readDispatch({ sourceMessageId: work.messageId })).dispatch.threadId).toBe(work.source!.envelope.threadId)
})

it('a later Main can read saved links but cannot inherit the original Dispatch participant authority', async () => {
  const f = await fixture(), work = await openMoteWorkThread(f)
  await writeFile(f.motePath, serializeMoteQuickMode('', { conversation: { hostId: 'local', sessionId: 'member',
    displayWorkspaceId: '__scratch__', groupId: 'group', tabId: 'tab-member', regionId: 'region-member' } }))
  const reads = vi.spyOn(f.client, 'readDispatch')
  const page = await f.cli(['space','mote','dialogue','supervision','read','--input','-'], { target: f.target }, 'member')
  expect(page.links).toEqual(work.page.links)
  expect(page.observations[0]).toMatchObject({ communication: null, issue: expect.stringContaining('Dispatch participant') })
  expect(reads).toHaveBeenCalledWith(expect.objectContaining({ sourceMessageId: work.messageId,
    caller: { agentSessionId: 'member', capability: expect.any(String) } }))
  // A person retains their original read capability; role selection grants no Agent privilege.
  expect((await f.rpc.call('space.mote.dialogue.supervision.read', { target: f.target })).observations[0]!.communication).not.toBeNull()
})

it('the original Core rejects a retained signed source from another Runtime with the same Main SID', async () => {
  const f = await fixture(), work = await openMoteWorkThread(f)
  const localIdentity = await f.client.agentMessageAuthority(), foreignCapability = issueAgentCapability()
  const sessions = new AgentMuxFileAgentSessionStore(join(f.root, 'foreign-sessions.json'))
  await sessions.compareAndSwap(null, { kind: 'agent', agentSessionId: 'primary', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: f.root, run: { runId: 'run-primary' }, retiredRuns: [], capabilityHash: hashAgentCapability(foreignCapability),
    hookBindingId: 'foreign-binding', hookToken: 'foreign-hook-token', createdAt: 1, updatedAt: 1 })
  const foreign = new AgentMuxClient({ store: sessions,
    creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: join(f.root, 'foreign-authority'), runtimeId: 'foreign-main-runtime' }) })
  cleanup.push(() => foreign.dispose())
  const foreignRuntime = foreign as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: { isConnected(): boolean } }
  await foreignRuntime.registry.load('local'); foreignRuntime.connected = true; foreignRuntime.kernel.isConnected = () => true
  // Preserve real signed history under a different current Runtime reader. The original
  // author uses the real Core admission; equality of the SID and Run grants no local role.
  expect(foreign.agentMessageQueuePath()).toBe(f.client.agentMessageQueuePath())
  const original = await foreign.prepareFederatedMessage({ caller: { agentSessionId: 'primary', capability: foreignCapability },
    target: { runtimeId: localIdentity.runtimeId, agentSessionId: 'member', runId: 'run-member' }, targetKeyFingerprint: localIdentity.fingerprint,
    text: 'Original work owned by the foreign Runtime.', operationId: 'foreign-work-operation', messageId: 'foreign-work-source', threadId: 'foreign-work-thread' })
  await foreign.openDispatch({ callerAgentSessionId: 'primary', capability: foreignCapability, sourceMessageId: original.packet.envelope.messageId })
  expect(original.packet.provenance.source).toMatchObject({ runtimeId: 'foreign-main-runtime', agentSessionId: 'primary', runId: 'run-primary' })
  expect((await f.client.readDispatch({ sourceMessageId: 'foreign-work-source' })).dispatch.ownerAgentSessionId).toBe('primary')
  const snapshot = await f.main.readCurrentMoteMain(f.target)
  await new MoteDialogueStore(join(f.root, 'work-dialogue.sqlite')).append(snapshot.identity!, 'retained-foreign-link', 'original retained source', [{
    kind: 'work', eventId: 'retained-foreign-event', mainRoleRevision: snapshot.roleRevision!, main: { hostId: 'local', agentSessionId: 'primary' },
    origin: { hostId: 'local', messageId: 'foreign-work-source', threadId: 'foreign-work-thread', senderSessionId: 'primary', recipientSessionId: 'member',
      createdAt: original.packet.envelope.createdAt! }, associatedAt: 1 }])
  await expect(f.cli(['message','dispatch','read','--host','local','--source-message','foreign-work-source']))
    .rejects.toThrow('Runtime-qualified participant')
  const reads = vi.spyOn(f.client, 'readDispatch'), writes = f.writes.length
  const page = await read(f)
  expect(page.observations[0]).toMatchObject({ communication: null, issue: expect.stringContaining('Runtime-qualified participant') })
  expect(page.observations[1].communication.replyMessageIds).toContain('first-work-result')
  expect(reads).toHaveBeenCalledWith(expect.objectContaining({ sourceMessageId: 'foreign-work-source',
    caller: { agentSessionId: 'primary', capability: expect.any(String) } }))
  expect(page.links[1].origin.messageId).toBe(work.messageId)
  expect(f.writes).toHaveLength(writes)
  expect((await f.rpc.call('space.mote.dialogue.supervision.read', { target: f.target })).observations[0]!.communication).not.toBeNull()
})

it('current Main collects a formal Goal report and independently checks the original plan without human acceptance', async () => {
  const f = await fixture()
  const work = await openMoteWorkThread(f), worker = work.opened.agent.agentSessionId
  const workerCapability = f.launches[0]!.env.AGENTMUX_AGENT_CAPABILITY
  const { demand: goal } = await f.demands.create({ title: 'Original scoped outcome', status: 'in_progress', supervisorSessionId: 'primary', assigneeSessionIds: ['primary', worker, 'member'] })
  await f.demands.proposeAlignment(goal.id, { summary: 'Original scoped outcome', criteria: [{ id: 'result', text: 'The original work result is checkable.' }], openQuestions: [] })
  const checkPath = join(f.root, 'check-result.mjs')
  await writeFile(checkPath, "import assert from 'node:assert/strict'; assert.equal(process.argv[2], 'Original scoped research result'); console.log('Original result checked');\n")
  const command = 'node check-result.mjs "Original scoped research result"'
  await f.cli(['goal','plan','revise','--input','-'], { goalId: goal.id, revision: { operationId: 'plan', expectedRevision: 0, alignmentRevision: 1,
    nodes: [{ id: 'result-node', title: 'Original result', outcome: 'Checkable original result', dependsOn: [], criterionIds: ['result'], check: command,
      executor: { hostId: 'local', agentSessionId: worker } }] } })
  const intent = { operationId: 'formal-work', sourceMessageId: 'formal-source', hostId: 'local', ownerAgentSessionId: 'primary', workerAgentSessionId: worker,
    ownerRunId: 'run-primary', workerRunId: 'work-run-1', threadId: 'formal-thread', text: 'Check the original scoped result', alignmentRevision: 1,
    criterionIds: ['result'], planNodeId: 'result-node' }
  await f.cli(['goal','delegate','--input','-'], { goalId: goal.id, intent })
  await f.cli(['space','mote','dialogue','link','--input','-'], { target: f.target, operationId: 'link-formal-work', expectedRoleRevision: work.before.main.roleRevision,
    source: { kind: 'work', messageHostId: 'local', messageId: intent.sourceMessageId } })
  const report = { operationId: 'report-formal', replyMessageId: 'formal-result', authorAgentSessionId: worker,
    grounding: { alignmentRevision: 1, summary: 'Original scoped research result', checks: [{ criterionId: 'result', outcome: 'met', evidence: ['Original scoped research result'], note: '' }] } }
  await f.cli(['goal','report','--input','-'], { goalId: goal.id, operationId: intent.operationId, report }, worker, workerCapability)
  const originalRead = f.client.readDispatch.bind(f.client)
  const missing = vi.spyOn(f.client, 'readDispatch').mockImplementation(async input => {
    if (input.sourceMessageId === intent.sourceMessageId) throw new Error('This original source is temporarily unreadable')
    return originalRead(input)
  })
  const partial = await read(f)
  expect(partial.observations[0].communication).toBeNull()
  expect(partial.observations[1].communication.events[0].replyMessageId).toBe('first-work-result')
  missing.mockRestore()
  const page = await read(f, { limit: 1 })
  expect(page.next).not.toBeNull()
  expect(page.observations[0].communication).toMatchObject({ goal: { goalId: goal.id, delegationOperationId: 'formal-work', alignmentRevision: 1, planNodeId: 'result-node' },
    originAwaits: false, events: [{ kind: 'worker_done', replyMessageId: 'formal-result' }] })
  const next = await read(f, { limit: 1, cursor: page.next })
  expect(next.links[0].origin.messageId).toBe(work.messageId)
  const current = await f.cli(['goal','plan','--goal',goal.id])
  expect(current.plan.alignmentRevision).toBe(1)
  await f.cli(['goal','collect','--input','-'], { goalId: goal.id, operationId: 'formal-work', collection: { operationId: 'collect-formal', replyMessageId: 'formal-result' } })
  const checked = await promisify(execFile)(process.execPath, [checkPath, report.grounding.summary], { cwd: f.root })
  const reviewed = await f.cli(['goal','plan','review','--input','-'], { goalId: goal.id, review: { operationId: 'independent-review', nodeId: 'result-node',
    delegationOperationId: 'formal-work', verdict: 'pass', check: { command, result: checked.stdout.trim(), evidence: ['Original scoped research result'] }, note: '' } }, 'member')
  expect(reviewed.planState.done).toBe(1)
  expect(reviewed.grounding.acceptedAt).toBeNull()
  expect((await f.demands.get(goal.id))!.status).toBe('in_progress')
  expect(f.launches).toHaveLength(1)
})

it('wire results reject detached observations and all actual Mote guidance consumers share supervision duties', async () => {
  const f = await fixture(); await openMoteWorkThread(f)
  const page = await read(f)
  expect(() => parseMoteDialogueResult('space.mote.dialogue.supervision.read', { ...page,
    observations: [{ ...page.observations[0], sequence: 0 }] }, { target: f.target })).toThrow()
  expect(MOTE_INPUT_GUIDANCE).toContain(MOTE_SUPERVISION_GUIDANCE)
  expect(MOTE_COORDINATION_ROLE).toContain(MOTE_SUPERVISION_GUIDANCE)
})
