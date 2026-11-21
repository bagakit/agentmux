import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'
import type { AgentMuxSignedMessage } from '../../../packages/core/src/agent-message-federation.js'
import { normalizeAgentContinuityPolicy } from '../../../packages/core/src/agent-session-recovery/continuity-contract.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { AgentMuxControlServer, AgentMuxSpatialStateStore } from '@agentmux/core'
import { createWorkbenchViewLayout, createWorkspaceLayout } from '@agentmux/core/spatial-layout'
import { desktopRunInputOccupation } from '../../desktop/src/renderer/src/lib/agent-closeout-input.js'

// Each case drives real Hosts through separate public CLI processes.
vi.setConfig({ testTimeout: 60_000 })
const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Owner = Awaited<ReturnType<typeof crossHostOwner>>
async function trust(source: Owner, target: Owner, purpose: 'message' | 'creation' = 'message') {
  const a = await source.call(null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  const b = await target.call(null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  return await target.call(null, ['settings', 'hosts', purpose === 'message' ? 'trust-message-source' : 'trust-source', '--host', 'local', '--input', '-'], {
    sourceRuntimeId: a.authority.runtimeId, publicKey: a.authority.publicKey,
    targetRuntimeId: b.authority.runtimeId, targetKeyFingerprint: b.authority.fingerprint
  })
}

it('uses the real public CLI against two independent semantic Hosts without copying Sessions or configuring a reverse route', async () => {
  const a = await crossHostOwner(cleanup, 'owner-a', ['same-session', 'independent-reviewer'])
  const b = await crossHostOwner(cleanup, 'worker-b', ['same-session'])
  a.routes([{ hostId: 'worker-b', client: b.reader }])
  b.routes([])
  const owner = await a.call(null, ['runtime', 'owner', 'identity'])
  const worker = await b.call(null, ['runtime', 'owner', 'identity'])
  expect(owner.owner.runtimeId).toBe(a.identity.runtimeId)
  expect(worker.owner.runtimeId).toBe(b.identity.runtimeId)
  expect(a.identity.runtimeId).not.toBe(b.identity.runtimeId)
  expect(a.client().agentSession('same-session').run).toEqual(b.client().agentSession('same-session').run)
  expect(await b.original.store.readMetadata('independent-reviewer')).toBeNull()
})

it('requires message-purpose pins and pulls the original signed reply over the single A to B route despite equal Session and Run IDs', async () => {
  const a = await crossHostOwner(cleanup, 'owner-a', ['same-session'])
  const b = await crossHostOwner(cleanup, 'worker-b', ['same-session'])
  a.routes([{ hostId: 'worker-b', client: b.reader }]); b.routes([])
  const request = { target: { kind: 'agent-session', agentSessionId: 'same-session', hostId: 'worker-b' }, text: 'Original task\nkept byte-for-byte.',
    operationId: 'original-task-operation', messageId: 'original-task-message', threadId: 'original-task-thread', expectedRun: { runId: 'run-same-session' },
    application: { schema: 'agentmux.test-task.v1', data: { original: true } } }
  await trust(a, b, 'creation')
  const untrusted = await a.cli('same-session', ['agent', 'send', '--input', '-'], request)
  expect(untrusted.code).toBe(1)
  expect(untrusted.stderr).toContain('TRUST')
  expect((await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', request.messageId])).message).toBeNull()
  const originalPacket = (b.forwarded.find(value => value.method === 'message.federation.intake')!.params as { packet: AgentMuxSignedMessage }).packet
  await trust(a, b); await trust(b, a)
  // These challenge first admission, not the exact-receipt reconciliation path.
  const forgedSignature = structuredClone(originalPacket); forgedSignature.provenance.signature = 'A'.repeat(86)
  const refusedSignature = await b.cli(null, ['message', 'federation', 'intake', '--input', '-'], { packet: forgedSignature })
  expect(refusedSignature.code).toBe(1); expect(refusedSignature.stderr, refusedSignature.stderr).toContain('AGENT_MESSAGE_AUTHORITY_INVALID')
  for (const field of ['sourceKeyFingerprint', 'targetKeyFingerprint'] as const) {
    const changed = structuredClone(originalPacket); changed.provenance[field] = '0'.repeat(64)
    const refused = await b.cli(null, ['message', 'federation', 'intake', '--input', '-'], { packet: changed })
    expect(refused.code).toBe(1)
    expect(refused.stderr, refused.stderr).toContain(field === 'targetKeyFingerprint' ? 'AGENT_MESSAGE_TARGET_MISMATCH' : 'AGENT_MESSAGE_AUTHORITY_INVALID')
  }
  const sent = await a.call('same-session', ['agent', 'send', '--input', '-'], request)
  expect(sent).toMatchObject({ messageId: request.messageId })
  const incoming = await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', request.messageId])
  expect(incoming.message.envelope).toMatchObject({ body: request.text, senderRuntimeId: a.identity.runtimeId, recipientRuntimeId: b.identity.runtimeId, application: request.application })
  await a.call('same-session', ['message', 'dispatch', 'open', '--source-message', request.messageId])
  const response = { target: { kind: 'reply', sourceMessageId: request.messageId }, text: 'Original worker evidence.', operationId: 'original-report-operation', messageId: 'original-report-message',
    application: { schema: 'agentmux.test-report.v1', data: { evidence: ['checks/original.log:1'] } } }
  const reply = await b.call('same-session', ['agent', 'send', '--input', '-'], response)
  expect(reply).toMatchObject({ messageId: response.messageId, transport: { state: 'outbox', targetRuntimeId: a.identity.runtimeId } })
  expect((await a.call('same-session', ['message', 'read', '--host', 'local', '--message-id', response.messageId])).message).toBeNull()
  const synced = await a.call('same-session', ['message', 'dispatch', 'sync', '--source-message', request.messageId, '--host', 'worker-b'])
  expect(synced).toMatchObject({ source: { envelope: { messageId: request.messageId } }, replies: [{ envelope: { messageId: response.messageId } }] })
  const collected = await a.call('same-session', ['message', 'read', '--host', 'local', '--message-id', response.messageId])
  expect(collected.message.envelope).toMatchObject({ body: response.text, threadId: request.threadId, replyTo: request.messageId, senderRuntimeId: b.identity.runtimeId, recipientRuntimeId: a.identity.runtimeId, application: response.application })
  expect(synced.source.provenance).toEqual(originalPacket.provenance)
  expect(incoming.message.provenance).toEqual(originalPacket.provenance)
  const savedReply = await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', response.messageId])
  expect(collected.message.provenance).toEqual(savedReply.message.provenance)
  for (const [field, value] of [['body', 'Altered original body'], ['recipientRuntimeId', a.identity.runtimeId], ['recipientSessionId', 'other-session'], ['recipientRunId', 'other-run'], ['threadId', 'other-thread']] as const) {
    const changed = structuredClone(originalPacket); changed.envelope[field] = value
    const refused = await b.cli(null, ['message', 'federation', 'intake', '--input', '-'], { packet: changed })
    expect(refused.code, field + ': ' + refused.stdout + refused.stderr).toBe(1)
    expect(refused.stderr).toContain('AGENT_MESSAGE_AUTHORITY_INVALID')
  }
  expect(a.native.stop).not.toHaveBeenCalled(); expect(b.native.stop).not.toHaveBeenCalled()
})

it('reconciles a committed intake with a lost ACK and retains the exact signed thread through unavailable routes and both Host restarts', async () => {
  const a = await crossHostOwner(cleanup, 'owner-a', ['same-session'])
  const b = await crossHostOwner(cleanup, 'worker-b', ['same-session'])
  a.routes([{ hostId: 'worker-b', client: b.reader }]); b.routes([])
  await trust(a, b); await trust(b, a)
  const request = { target: { kind: 'agent-session', agentSessionId: 'same-session', hostId: 'worker-b' }, text: 'Preserve this original task after an unknown receipt.',
    operationId: 'lost-ack-operation', messageId: 'lost-ack-source', threadId: 'lost-ack-thread', expectedRun: { runId: 'run-same-session' } }
  b.loseNextIntakeAck()
  const unknown = await a.cli('same-session', ['agent', 'send', '--input', '-'], request)
  expect(unknown.code).toBe(1); expect(unknown.stderr).toContain('CONTROL_UNAVAILABLE')
  const sourceAtB = await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', request.messageId])
  expect(sourceAtB.message.envelope).toMatchObject({ operationId: request.operationId, messageId: request.messageId, body: request.text })
  await a.call('same-session', ['message', 'dispatch', 'open', '--source-message', request.messageId])
  const replyInput = { target: { kind: 'reply', sourceMessageId: request.messageId }, operationId: 'lost-ack-report-operation', messageId: 'lost-ack-reply', text: 'The original worker report stays signed.' }
  await b.call('same-session', ['agent', 'send', '--input', '-'], replyInput)
  a.routes([])
  const unavailable = await a.cli('same-session', ['message', 'dispatch', 'sync', '--source-message', request.messageId, '--host', 'worker-b'])
  expect(unavailable.code).toBe(1); expect(unavailable.stderr).toContain('CONTROL_UNAVAILABLE')
  const preserved = await a.call('same-session', ['message', 'read', '--host', 'local', '--message-id', request.messageId])
  expect(preserved.message.provenance).toEqual(sourceAtB.message.provenance)
  const originalIdentityA = a.identity, originalIdentityB = b.identity
  await a.stop(); await b.stop(); await b.start(); await a.start()
  a.routes([{ hostId: 'worker-b', client: b.reader }]); b.routes([])
  expect(a.identity.runtimeId).toBe(originalIdentityA.runtimeId); expect(b.identity.runtimeId).toBe(originalIdentityB.runtimeId)
  expect(a.identity.ownerInstanceId).not.toBe(originalIdentityA.ownerInstanceId); expect(b.identity.ownerInstanceId).not.toBe(originalIdentityB.ownerInstanceId)
  const recovered = await a.call('same-session', ['message', 'dispatch', 'sync', '--source-message', request.messageId, '--host', 'worker-b'])
  expect(recovered.source.provenance).toEqual(sourceAtB.message.provenance)
  expect(recovered.replies.map((reply: { envelope: { messageId: string } }) => reply.envelope.messageId)).toEqual([replyInput.messageId])
  const replayedRead = await a.call('same-session', ['message', 'dispatch', 'sync', '--source-message', request.messageId, '--host', 'worker-b'])
  expect(replayedRead.replies).toEqual(recovered.replies)
  expect(b.forwarded.filter(row => row.method === 'message.federation.intake')).toHaveLength(1)
  expect(a.native.stop).not.toHaveBeenCalled(); expect(b.native.stop).not.toHaveBeenCalled()
})

it('takes a remote worker source report through the public Goal owner, signed pull, collection and independent review before unlocking its dependent node', async () => {
  const a = await crossHostOwner(cleanup, 'goal-owner', ['same-session', 'current-supervisor', 'independent-reviewer'])
  const b = await crossHostOwner(cleanup, 'goal-worker', ['same-session'])
  // The original Goal predates connecting another same-SID Runtime. The saved
  // local Supervisor must retain its identity when the remote route is added.
  a.routes([]); b.routes([])
  await trust(a, b); await trust(b, a)
  const goalId = (await a.call('same-session', ['goal', 'create', '--title', 'Ship the original result', '--description', 'Preserve the original human intent.',
    '--status', 'in_progress', '--session', 'same-session', '--assignees', JSON.stringify(['same-session', 'current-supervisor', 'independent-reviewer']), '--supervisor', 'same-session', '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-original-goal'])).goal.id
  const alignment = { summary: 'Deliver and independently verify the original result.', criteria: [{ id: 'original-criterion', text: 'The original result is independently checked.' }], openQuestions: [] }
  const aligned = await a.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify(alignment)])
  const alignmentRevision = aligned.goal.alignment.revision
  a.routes([{ hostId: 'worker-b', client: b.reader }])
  const ambiguous = await a.cli(null, ['goal', 'create', '--title', 'An ambiguous relation is refused', '--session', 'same-session',
    '--assignees', JSON.stringify(['same-session', 'independent-reviewer']), '--supervisor', 'same-session', '--risk', 'low', '--confirm', 'user', '--operation-id', 'ambiguous-create-operation'])
  expect(ambiguous.code).toBe(1); expect(ambiguous.stderr, ambiguous.stderr + ambiguous.stdout).toContain('AMBIGUOUS_AGENT_SESSION')
  const nodes = ['first', 'dependent'].map(id => ({ id, title: 'Deliver ' + id, outcome: 'Original ' + id + ' outcome', dependsOn: id === 'dependent' ? ['first'] : [],
    criterionIds: ['original-criterion'], check: 'node --test checks/' + id + '.test.mjs', executor: { hostId: 'worker-b', agentSessionId: 'same-session' } }))
  const published = await a.call('same-session', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: { operationId: 'original-plan-revision', expectedRevision: 0, alignmentRevision, nodes } })
  const ids = new Map(nodes.map((node, index) => [node.id, published.plan.nodes[index].id as string]))
  const intent = (nodeId: string, ownerAgentSessionId = 'same-session') => ({ operationId: 'delegate-' + nodeId, sourceMessageId: 'source-' + nodeId, hostId: 'local', workerHostId: 'worker-b', ownerAgentSessionId, workerAgentSessionId: 'same-session',
    ownerRunId: 'run-' + ownerAgentSessionId, workerRunId: 'run-same-session', threadId: 'thread-' + nodeId, text: 'Deliver the original ' + nodeId + ' task.', alignmentRevision, criterionIds: ['original-criterion'], planNodeId: ids.get(nodeId)! })
  const blocked = await a.cli('same-session', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent') })
  expect(blocked.code).toBe(1); expect(blocked.stderr).toContain('only a ready node')
  const delegated = await a.call('same-session', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('first') })
  expect(delegated.delegations[0]).toMatchObject({ operationId: 'delegate-first', sourceMessageId: 'source-first', hostId: 'local', workerHostId: 'worker-b', linkedAt: expect.any(Number),
    runtimeIdentity: { ownerRuntimeId: a.identity.runtimeId, workerRuntimeId: b.identity.runtimeId } })
  const source = await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'source-first'])
  expect(source.message.envelope.body).toContain('At the start of each work turn')
  expect(source.message.envelope.body).toContain('Check your current responsibility across authorized work')
  expect((await b.call(null, ['goal', 'ls', '--all'])).goals).toEqual([])
  const report = { operationId: 'report-first', replyMessageId: 'reply-first', authorAgentSessionId: 'same-session', grounding: { alignmentRevision, summary: 'The worker reports the original criterion with evidence.',
    checks: [{ criterionId: 'original-criterion', outcome: 'met', evidence: ['checks/first.log:1'], note: '' }] } }
  const reportInput = { goalId, operationId: 'delegate-first', sourceMessageId: 'source-first', report }
  const replacement = await a.call(null, ['goal', 'update', '--goal', goalId, '--supervisor', 'current-supervisor'])
  expect(replacement.goal.supervisorSessionId).toBe('current-supervisor')
  const collect = { goalId, operationId: 'delegate-first', collection: { operationId: 'collect-first', replyMessageId: 'reply-first' } }
  a.routes([])
  const unavailable = await a.cli('current-supervisor', ['goal', 'collect', '--input', '-'], collect)
  expect(unavailable.code).toBe(1)
  expect((await a.call('current-supervisor', ['goal', 'plan', '--goal', goalId])).delegations[0].collection).toBeUndefined()
  expect(b.native.stop).not.toHaveBeenCalled()
  a.routes([{ hostId: 'worker-b', client: b.reader }])
  const reported = await b.cli('same-session', ['goal', 'report', '--input', '-'], reportInput)
  expect(reported.code, reported.stderr).toBe(0)
  const submitted = JSON.parse(reported.stdout)
  expect(submitted.result).toMatchObject({ kind: 'report-submission', goalId, delegationOperationId: 'delegate-first', sourceMessageId: 'source-first', submission: { messageId: 'reply-first', transport: { state: 'outbox', targetRuntimeId: a.identity.runtimeId } } })
  expect(submitted.guidance).toContain('Read back the handoff')
  expect(submitted.guidance).toContain('The Goal owner’s receipt and collection still need confirmation.')
  expect(submitted.guidance).toContain('"replyMessageId":"reply-first"')
  expect(b.native.stop).not.toHaveBeenCalled()
  expect((await b.call(null, ['goal', 'ls', '--all'])).goals).toEqual([])
  const originalReply = await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'reply-first'])
  const collectedCli = await a.cli('current-supervisor', ['goal', 'collect', '--input', '-'], collect)
  expect(collectedCli.code, collectedCli.stderr).toBe(0)
  const collectionReceipt = JSON.parse(collectedCli.stdout)
  const collected = collectionReceipt.result
  expect(collected.delegations[0]).toMatchObject({ ownerAgentSessionId: 'same-session', report: { ...report, submittedAt: expect.any(Number) },
    collection: { operationId: 'collect-first', replyMessageId: 'reply-first', collector: { kind: 'agent', id: 'current-supervisor' } } })
  expect(collectionReceipt.guidance).toContain('"collectionOperationId":"collect-first"')
  expect(collectionReceipt.guidance).toContain(collected.delegations[0].report.delivery.hash)
  const received = await a.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'reply-first'])
  expect(received.message.provenance).toEqual(originalReply.message.provenance)
  const stillBlocked = await a.cli('current-supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent', 'current-supervisor') })
  expect(stillBlocked.code).toBe(1); expect(stillBlocked.stderr).toContain('only a ready node')
  const checks = join(a.original.root, 'checks'); await mkdir(checks)
  await writeFile(join(checks, 'worker.json'), JSON.stringify(originalReply.message))
  await writeFile(join(checks, 'received.json'), JSON.stringify(received.message))
  await writeFile(join(checks, 'first.test.mjs'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
test('the received original report retains its worker signature and exact Goal criterion',()=>{const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8')); const worker=read('./worker.json'),received=read('./received.json'); assert.deepEqual(received.provenance,worker.provenance); assert.deepEqual(received.envelope.application,worker.envelope.application); assert.equal(received.envelope.replyTo,'source-first'); assert.equal(received.envelope.operationId,'report-first');});\n`)
  const checked = await promisify(execFile)(process.execPath, ['--test', 'checks/first.test.mjs'], { cwd: a.original.root })
  await writeFile(join(checks, 'review-first.log'), checked.stdout + checked.stderr)
  expect(checked.stdout).toContain('pass 1')
  const review = { operationId: 'review-first', nodeId: ids.get('first')!, delegationOperationId: 'delegate-first', deliveryHash: collected.delegations[0].report.delivery.hash, verdict: 'pass',
    check: { command: nodes[0]!.check, result: checked.stdout, evidence: ['checks/review-first.log:1'] }, note: '' }
  const foreignWorker = await a.cli('same-session', ['goal', 'plan', 'review', '--input', '-'], { goalId, review: { ...review, operationId: 'foreign-worker-review' } }, b.original.capability)
  expect(foreignWorker.code).toBe(1); expect(foreignWorker.stderr).toContain('AGENT_CAPABILITY_INVALID')
  await a.call('independent-reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId, review })
  const unlocked = await a.call('current-supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent', 'current-supervisor') })
  expect(unlocked.plan.reviews[0]).toMatchObject({ ...review, reviewer: { kind: 'agent', id: 'independent-reviewer', hostId: 'local', runtimeId: a.identity.runtimeId } })
  const completion = unlocked.plan.reviews[0].completion
  const fingerprint = (await a.client().agentCreationAuthority()).fingerprint
  expect((await b.cli(null, ['goal', 'plan', 'verify', '--input', '-', '--goal', goalId, '--hash', completion.hash, '--fingerprint', fingerprint], completion)).code).toBe(0)
  expect(unlocked.delegations[1].dispatchProof.record).toMatchObject({ executor: { runtimeId: b.identity.runtimeId }, predecessors: [{ ticketId: ids.get('first'), completionHash: completion.hash }] })
  expect(unlocked.delegations.map((item: { operationId: string }) => item.operationId)).toEqual(['delegate-first', 'delegate-dependent'])
  expect(unlocked.planState.nodes).toMatchObject([{ id: ids.get('first'), state: 'done' }, { id: ids.get('dependent'), state: 'working' }])
  const dependentInput = await b.call('same-session', ['message', 'read', '--message-id', 'source-dependent'])
  expect(dependentInput.message).toMatchObject({ envelope: { recipientRunId: 'run-same-session' }, delivery: { state: 'queued' } })
  const final = await a.call(null, ['goal', 'inspect', '--goal', goalId])
  expect(final.goal).toMatchObject({ status: 'in_progress', description: 'Preserve the original human intent.', alignment: { confirmedAt: null }, grounding: { acceptedAt: null } })
  expect(await a.original.store.readMetadata('independent-reviewer')).not.toBeNull()
  expect(await b.original.store.readMetadata('independent-reviewer')).toBeNull()
  expect(b.native.stop).not.toHaveBeenCalled()
})

it.each(['active original Supervisor', 'retired original Supervisor', 'active original Supervisor unmounted', 'active original Supervisor with queued Core input', 'reassignment after collection', 'input saved during final Desktop check', 'new Goal duty before Stop admission', 'lost original Native Stop ACK', 'Desktop draft before admission', 'Desktop draft after admission', 'lost Desktop admission ACK',
  'explicit Supervisor stop', 'explicit Supervisor stop after startup resume', 'read saved receipts without Core messaging'] as const)('retains the original report through current Supervisor collection with %s', async scenario => {
  const host = await crossHostOwner(cleanup, 'worker-closeout', ['supervisor', 'worker', 'reviewer', 'successor'])
  const managed = scenario.startsWith('explicit Supervisor stop')
  const resumed = scenario === 'explicit Supervisor stop after startup resume'
  const { goal } = await host.call(null, ['goal', 'create', '--title', 'Verify worker closeout',
    '--status', 'in_progress', '--assignees', '["supervisor","worker","successor"]', '--supervisor', 'supervisor', '--risk', 'low', '--confirm', 'user'])
  const goalId = goal.id
  const alignment = { summary: 'Save the original delivery', criteria: [{ id: 'saved', text: 'Read the original evidence' }], openQuestions: [] }
  const proposal = await host.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify(alignment)])
  const alignmentRevision = proposal.goal.alignment.revision
  const plan = await host.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: {
    operationId: 'closeout-plan', expectedRevision: 0, alignmentRevision,
    nodes: [{ id: 'deliver', title: 'Deliver', outcome: 'A verified delivery', criterionIds: ['saved'], dependsOn: [],
      check: 'Read the artifact', executor: { hostId: 'local', agentSessionId: 'worker' } }],
  } })
  const nodeId = plan.plan.nodes[0].id
  const operationId = 'closeout-dispatch', sourceMessageId = 'closeout-source', replyMessageId = 'closeout-reply'
  const intent = {
    operationId, sourceMessageId, threadId: 'closeout-thread', hostId: 'local', ownerAgentSessionId: 'supervisor',
    ownerRunId: 'run-supervisor', workerAgentSessionId: 'worker', workerRunId: 'run-worker', text: 'Deliver the original artifact.',
    alignmentRevision, criterionIds: ['saved'], planNodeId: nodeId,
  }
  await host.call('supervisor', ['goal', 'delegate', '--input', '-'], { goalId, intent })
  const report = { operationId: 'closeout-report', replyMessageId, authorAgentSessionId: 'worker', grounding: {
    alignmentRevision, summary: 'Original delivery saved', checks: [{ criterionId: 'saved', outcome: 'met', evidence: ['artifact.log'], note: '' }],
  } }
  const retired = scenario === 'retired original Supervisor'
  if (retired) {
    await host.call(null, ['goal', 'update', '--goal', goalId, '--supervisor', 'successor'])
    await host.call(null, ['agent', 'stop', '--session', 'supervisor', '--run', 'run-supervisor', '--operation-id', 'retire-original-supervisor'])
    const impostor = await host.cli('reviewer', ['goal', 'report', '--input', '-'], { goalId, operationId, report })
    expect(impostor.code).toBe(1)
    expect(impostor.stderr).toContain('CONTROL_PERMISSION_DENIED')
  }
  const supervisor = retired ? 'successor' : 'supervisor'
  const delivered = await host.cli('worker', ['goal', 'report', '--input', '-'], { goalId, operationId, report })
  expect(delivered.code, delivered.stderr).toBe(0)
  expect(JSON.parse(delivered.stdout)).toMatchObject({ guidance: expect.stringContaining('"sourceMessageId":"closeout-source"') })
  const waiting = await host.call('worker', ['goal', 'plan', '--goal', goalId])
  expect(waiting.delegations[0].collection).toBeUndefined()
  expect(waiting.planState.nodes[0].state).toBe('review')
  expect(host.native.stop).toHaveBeenCalledTimes(retired ? 1 : 0)

  const signed = waiting.delegations[0].report
  const collected = await host.call(supervisor, ['goal', 'collect', '--input', '-'], { goalId, operationId, collection: {
    operationId: 'closeout-collection', replyMessageId,
  } })
  expect(collected.delegations[0]).toMatchObject({ report: signed, collection: { collector: { kind: 'agent', id: supervisor }, replyMessageId } })
  expect(collected.goalState.supervisorSessionId).toBe(supervisor)
  if (scenario === 'read saved receipts without Core messaging') {
    const read = vi.spyOn(host.client(), 'readMessage').mockRejectedValue(Error('Private original message source unavailable'))
    const dispatch = vi.spyOn(host.client(), 'readDispatch').mockRejectedValue(Error('Private original dispatch reader unavailable'))
    const replay = await host.call(supervisor, ['goal', 'delegate', '--input', '-'], { goalId, intent })
    expect(replay.delegations[0]).toEqual(collected.delegations[0])
    const bound = await host.call(supervisor, ['goal', 'delegation', 'bind', '--input', '-'], { goalId, intent })
    expect(bound.delegations[0]).toEqual(collected.delegations[0])
    const repeatedReport = await host.call('worker', ['goal', 'report', '--input', '-'], { goalId, operationId, report })
    expect(repeatedReport.delegations[0]).toEqual(collected.delegations[0])
    const collection = { operationId: 'closeout-collection', replyMessageId }
    const reread = await host.call(supervisor, ['goal', 'collect', '--input', '-'], { goalId, operationId, collection })
    expect(reread.delegations[0]).toEqual(collected.delegations[0])
    const changed = await host.cli(supervisor, ['goal', 'collect', '--input', '-'], { goalId, operationId, collection: { ...collection, replyMessageId: 'another-reply' } })
    expect(changed.code).toBe(1)
    const changedIntent = await host.cli(supervisor, ['goal', 'delegate', '--input', '-'], { goalId, intent: { ...intent, text: 'Changed original body' } })
    expect(changedIntent.code).toBe(1)
    const changedReport = await host.cli('worker', ['goal', 'report', '--input', '-'], { goalId, operationId, report: { ...report, grounding: { ...report.grounding, summary: 'Changed original report' } } })
    expect(changedReport.code).toBe(1)
    expect(read).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
    expect(host.native.stop).not.toHaveBeenCalled()
    return
  }
  if (retired) {
    const reply = (await host.call('worker', ['message', 'read', '--message-id', replyMessageId])).message
    expect(reply).toMatchObject({ envelope: { messageId: replyMessageId, replyTo: sourceMessageId, operationId: report.operationId,
      threadId: 'closeout-thread', recipientSessionId: 'supervisor', recipientRunId: 'run-supervisor',
      senderSessionId: 'worker', senderRunId: 'run-worker' }, provenance: { signature: expect.any(String) }, notification: { state: 'inbox-only' } })
    const original = await host.call('worker', ['goal', 'report', '--input', '-'], { goalId, operationId, report })
    expect(original.delegations[0].report).toEqual(signed)
    expect(host.native.stop).toHaveBeenCalledTimes(1)
    expect(await host.original.store.readMetadata('supervisor')).toBeNull()
    return
  }
  const mailbox = await host.call('worker', ['agent', 'input', 'ls', '--host-id', 'local', '--session', 'worker'])
  expect(mailbox).toMatchObject({ hostId: 'local', agentSessionId: 'worker', items: [], nextCursor: null,
    coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' } })
  const originalRun = await host.call('worker', ['agent', 'inspect', '--session', 'worker'])
  expect(originalRun.session).toMatchObject({ agentSessionId: 'worker', run: { runId: 'run-worker' } })
  expect(host.native.stop).not.toHaveBeenCalled()

  const closeout = (runId: string, stopOperationId: string) => ['goal', 'closeout', '--goal', goalId, '--attempt', operationId,
    '--session', 'worker', '--run', runId, '--operation-id', stopOperationId]
  const workerRun = resumed ? 'resumed-worker' : 'run-worker'
  const args = closeout(workerRun, 'closeout-stop')
  if (resumed) {
    await host.call('reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId, review: {
      operationId: 'review-closeout-delivery', nodeId, delegationOperationId: operationId, deliveryHash: signed.delivery.hash,
      verdict: 'pass', note: '', check: { command: 'Read the artifact', result: 'Passed', evidence: ['artifact.log'] },
    } })
  }
  if (!managed) expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'unknown' })
  const spatial = new AgentMuxSpatialStateStore(), directory = host.original.root
  const mounted = scenario === 'active original Supervisor' || scenario === 'Desktop draft after admission'
  await spatial.commit({ expectedRevision: 0, graph: {
    spaces: [], bindings: [],
    zones: mounted ? [{ zoneId: 'zone', workspaceId: 'original-project', kind: 'home', hostId: 'local', directoryPath: directory, branch: null }] : [],
    tabs: mounted ? [{ tabId: 'work-tab', zoneId: 'zone', workspaceId: 'original-project', name: 'Original Agent', regionIds: ['work-region'] }] : [],
    regions: mounted ? [{ tabId: 'work-tab', regionId: 'work-region', kind: 'agent', agentSessionId: 'worker', runId: 'run-worker', execution: { hostId: 'local', cwd: directory } }] : [],
    layouts: mounted ? { 'original-project': createWorkspaceLayout('group', ['work-tab']) } : {},
    tabLayouts: mounted ? { 'work-tab': createWorkbenchViewLayout('work-region') } : {}, resources: {},
  } })
  const metadata = (await host.original.store.readMetadata('worker'))!, now = Date.now()
  const idle = { ...metadata, semanticStatus: { state: 'done', source: 'native-hook',
    observedAt: now, stateEnteredAt: now, nativeTurnId: 'original-completed-turn' } as const, updatedAt: now }
  if (resumed) {
    const run = { runId: workerRun }
    const nativeTarget = metadata.nativeHandle
    if (nativeTarget?.kind !== 'provider') throw new Error('The original fixture needs its native context to resume')
    await host.original.store.compareAndSwap(metadata, { ...idle, run, retiredRuns: [metadata.run],
      nativeBinding: { run, source: 'semantic-resume-target', observedAt: now },
      continuity: { operationId: 'worker-startup-resume', agentSessionId: 'worker', trigger: 'startup', policy: normalizeAgentContinuityPolicy(),
        previousRun: metadata.run, newRun: run, nativeTarget,
        admittedAt: now, observedAt: now, rechecks: 0, kind: 'resumed', reason: 'Original startup resume', evidence: { kind: 'agent-session-store' } },
    })
  } else await host.original.store.compareAndSwapMetadata(metadata, idle)
  await (host.client() as unknown as { registry: { load(hostId: string): Promise<void> } }).registry.load('local')
  let known = false, pending = false, scheduleInput = false, desktopReads = 0
  const desktopAdmitted = new Set<string>(), desktopReconciled = new Set<string>()
  const drafts: Record<string, string> = {}
  const owners = mounted ? ['worker', 'work-region'] : ['worker']
  const desktop = new AgentMuxControlServer({ socketPath: join(directory, 'absent-desktop.sock'),
    coreClients: () => [{ hostId: 'local', client: host.client() }], execute: async request => {
      if (request.operation !== 'message.pending.ls' || request.closeoutRunId !== workerRun || request.agentSessionId !== 'worker') throw new Error('Unexpected private Desktop request')
      const closeout = request.closeout
      if (closeout?.action === 'reconcile') {
        desktopReconciled.add(closeout.operationId)
        return { operation: request.operation, agentSessionId: 'worker', messages: [],
          occupation: { runId: request.closeoutRunId, operationId: closeout.operationId, state: 'unknown' } }
      }
      if (scheduleInput && ++desktopReads === 2) {
        await host.call('successor', ['agent', 'send', '--to-session', 'worker', '--expect-run', 'run-worker', '--message-id', 'input-saved-after-core-check',
          '--operation-id', 'save-concurrent-original-input', '--text', 'Original work routed while closeout was checking Desktop'])
        const saved = await host.call('successor', ['message', 'read', '--message-id', 'input-saved-after-core-check'])
        expect(saved.message).toMatchObject({ envelope: { recipientSessionId: 'worker', recipientRunId: 'run-worker' }, delivery: { state: 'queued' } })
        expect(host.native.stop).not.toHaveBeenCalled()
      }
      const state = desktopRunInputOccupation({ known, owners, drafts, notes: {}, pending })
      if (closeout?.action === 'admit' && state === 'clear') {
        desktopAdmitted.add(closeout.operationId)
        if (scenario === 'lost Desktop admission ACK') throw new Error('Private Desktop admission ACK lost')
      }
      return { operation: request.operation, agentSessionId: 'worker', messages: [],
        occupation: { runId: request.closeoutRunId, state, ...(closeout ? { operationId: closeout.operationId } : {}) } }
    } })
  await desktop.start()
  cleanup.push(() => desktop.stop())
  if (managed) {
    const before = await host.call('supervisor', [...args, '--inspect'])
    expect(before).toMatchObject({ state: 'observed', stop: { phase: 'not-requested' },
      observations: { handoff: 'collected', ticketState: resumed ? 'done' : 'review' } })
    const unauthorized = await host.cli('reviewer', args)
    expect(unauthorized.code).toBe(1)
    expect(unauthorized.stderr).toContain('CONTROL_PERMISSION_DENIED')
    const anotherWorker = args.map(value => value === 'worker' ? 'successor' : value)
    expect((await host.cli('supervisor', anotherWorker)).code).toBe(1)
    if (resumed) {
      expect(await host.call('supervisor', closeout('run-worker', 'closeout-stale-run')))
        .toMatchObject({ state: 'observed', stop: { phase: 'unconfirmed' }, error: { code: 'STALE_AGENT_SESSION' } })
    }
    expect(host.native.stop).not.toHaveBeenCalled()
    await host.call(null, ['goal', 'create', '--title', 'Another active duty', '--status', 'in_progress',
      '--assignees', '["worker"]', '--risk', 'low', '--confirm', 'user'])
    known = resumed
    drafts.worker = 'original unsent draft'
    const stopped = await host.call('supervisor', args)
    expect(stopped).toMatchObject({ state: 'stopped', receipt: { operationId: 'closeout-stop', agentSessionId: 'worker', expectedRun: { runId: workerRun } },
      observations: { sourceMessageId, ticketId: nodeId, reportReplyMessageId: replyMessageId, collectionOperationId: 'closeout-collection',
        handoff: 'collected', ticketState: resumed ? 'done' : 'review', otherGoalWork: true, desktopInput: resumed ? 'draft' : 'unknown' } })
    expect(drafts.worker).toBe('original unsent draft')
    expect(desktopAdmitted.size).toBe(0)
    expect(await host.call('supervisor', [...args, '--inspect'])).toMatchObject({ state: 'observed', stop: { phase: 'retired', operationIdMatched: true } })
    expect(host.native.stop).toHaveBeenCalledTimes(1)
    expect(host.native.stop).toHaveBeenCalledWith(expect.objectContaining({ runId: workerRun }))
    const historical = await host.call('supervisor', ['goal', 'plan', '--goal', goalId])
    expect(historical.delegations[0]).toMatchObject({ report: signed, collection: { operationId: 'closeout-collection' } })
    await host.stop(); await host.start()
    expect(await host.call('supervisor', [...args, '--inspect'])).toMatchObject({ state: 'observed', stop: { phase: 'retired', operationIdMatched: true } })
    expect(await host.original.store.readMetadata('worker')).toBeNull()
    return
  }
  expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'unknown' })
  known = true
  drafts[owners.at(-1)!] = 'original unsent draft'
  expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'draft' })
  delete drafts[owners.at(-1)!]
  pending = true
  expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'pending' })
  pending = false
  if (scenario === 'reassignment after collection') {
    const revised = await host.call('supervisor', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: {
      operationId: 'closeout-reassign', expectedRevision: collected.plan.revision, alignmentRevision,
      nodes: [{ ...plan.plan.nodes[0], executor: { hostId: 'local', agentSessionId: 'successor' } }],
    } })
    expect(revised.planState.nodes[0]).toMatchObject({ state: 'ready', attempt: null })
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'handoff' })
    expect(host.native.stop).not.toHaveBeenCalled()
    return
  }
  if (mounted) {
    const another = await host.call(null, ['goal', 'create', '--title', 'Other worker responsibility', '--status', 'in_progress',
      '--assignees', '["worker"]', '--risk', 'low', '--confirm', 'user'])
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'other-work' })
    await host.call(null, ['goal', 'update', '--goal', another.goal.id, '--status', 'cancelled'])
  }
  if (scenario === 'active original Supervisor with queued Core input') {
    await host.call('successor', ['agent', 'send', '--to-session', 'worker', '--expect-run', 'run-worker', '--message-id', 'another-original-input',
      '--operation-id', 'queue-another-input', '--text', 'An unrelated original input'])
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'pending' })
    expect(host.native.stop).not.toHaveBeenCalled()
    return
  }
  if (scenario === 'input saved during final Desktop check') {
    scheduleInput = true
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'pending' })
    expect(desktopReads).toBe(2)
    expect(host.native.stop).not.toHaveBeenCalled()
    const original = await host.call('worker', ['agent', 'inspect', '--session', 'worker'])
    expect(original.session.run.runId).toBe('run-worker')
    return
  }
  if (scenario === 'new Goal duty before Stop admission') {
    const prepare = host.native.prepareStop as ReturnType<typeof vi.fn<(runId: string, operationKey: string) => Promise<unknown>>>
    const original = prepare.getMockImplementation()!
    prepare.mockImplementationOnce(async (runId, operationKey) => {
      await host.call(null, ['goal', 'create', '--title', 'Another original duty before Stop admission', '--status', 'in_progress',
        '--assignees', '["worker"]', '--risk', 'low', '--confirm', 'user'])
      return await original(runId, operationKey)
    })
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'other-work' })
    expect(host.native.stop).not.toHaveBeenCalled()
    return
  }
  if (scenario === 'Desktop draft before admission') {
    const prepare = host.native.prepareStop as ReturnType<typeof vi.fn<(runId: string, operationKey: string) => Promise<unknown>>>
    const original = prepare.getMockImplementation()!
    prepare.mockImplementationOnce(async (runId, operationKey) => {
      drafts[owners.at(-1)!] = 'draft after initial observation, before Desktop admission'
      return await original(runId, operationKey)
    })
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'draft' })
    expect(desktopAdmitted.size).toBe(0)
    expect(host.native.stop).not.toHaveBeenCalled()
    return
  }
  if (scenario === 'lost Desktop admission ACK') {
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'unknown', operationId: 'closeout-stop' })
    expect(desktopAdmitted.has('closeout-stop')).toBe(true)
    await vi.waitFor(() => expect(desktopReconciled.has('closeout-stop')).toBe(true))
    expect(host.native.stop).not.toHaveBeenCalled()
    expect(await host.call(null, ['agent', 'stop', 'inspect', '--session', 'worker', '--run', 'run-worker', '--operation-id', 'closeout-stop']))
      .toMatchObject({ phase: 'not-requested', operationIdMatched: false })
    return
  }
  if (scenario === 'Desktop draft after admission') {
    const stop = host.native.stop as ReturnType<typeof vi.fn<(operation: { runId: string }) => Promise<unknown>>>
    const original = stop.getMockImplementation()!
    stop.mockImplementationOnce(async operation => {
      expect(desktopAdmitted.has('closeout-stop')).toBe(true)
      drafts[owners.at(-1)!] = 'new mounted draft after Desktop admission'
      return await original(operation)
    })
  }
  if (scenario === 'lost original Native Stop ACK') {
    const stop = host.native.stop as ReturnType<typeof vi.fn<(operation: { runId: string }) => Promise<unknown>>>
    const status = host.native.status as ReturnType<typeof vi.fn<(runId: string) => Promise<ReturnType<typeof host.original.run>>>>
    const originalStop = stop.getMockImplementation()!, originalStatus = status.getMockImplementation()!
    const inspectStop = ['agent', 'stop', 'inspect', '--session', 'worker', '--run', 'run-worker', '--operation-id', 'closeout-stop']
    stop.mockImplementationOnce(async operation => {
      const refused = await host.cli('successor', ['agent', 'send', '--to-session', 'worker', '--expect-run', 'run-worker',
        '--message-id', 'input-after-stop-admission', '--operation-id', 'input-after-stop-operation', '--text', 'Keep this request if it cannot be submitted.'])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('AGENT_INPUT_RUN_STOPPING')
      expect((await host.call('successor', ['message', 'read', '--message-id', 'input-after-stop-admission'])).message).toBeNull()
      const local = await host.cli(null, ['agent', 'send', '--to-session', 'worker', '--expect-run', 'run-worker',
        '--message-id', 'local-input-after-stop-admission', '--operation-id', 'local-input-after-stop-operation', '--text', 'Keep this local request.'])
      expect(local.code).toBe(1)
      expect(local.stderr).toContain('AGENT_INPUT_RUN_STOPPING')
      expect((await host.call(null, ['message', 'read', '--host', 'local', '--message-id', 'local-input-after-stop-admission'])).message).toBeNull()
      await originalStop(operation)
      status.mockImplementation(async id => id === operation.runId
        ? { ...await originalStatus(id), state: { type: 'exited', code: 0, signal: null } } : originalStatus(id))
      throw new Error('Private original Native Stop ACK lost')
    })
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'unknown', operationId: 'closeout-stop' })
    expect(await host.call(null, inspectStop)).toMatchObject({ phase: 'stopping', operationIdMatched: true,
      failure: { stage: 'runtime-stop', message: 'Private original Native Stop ACK lost' } })
    expect(await host.call('worker', args)).toMatchObject({ state: 'retained', reason: 'unknown', operationId: 'closeout-stop' })
    await host.call(null, ['agent', 'stop', '--session', 'worker', '--run', 'run-worker', '--operation-id', 'closeout-stop'])
    expect(await host.call(null, inspectStop)).toMatchObject({ phase: 'retired', operationIdMatched: true })
    expect(host.native.prepareStop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    return
  }
  const incorrect = await host.cli('worker', closeout('different-run', 'closeout-wrong-run'))
  expect(incorrect.code).toBe(1)
  expect(host.native.stop).not.toHaveBeenCalled()
  const stopped = await host.call('worker', args)
  expect(stopped).toMatchObject({ state: 'stopped', receipt: { operationId: 'closeout-stop', agentSessionId: 'worker', expectedRun: { runId: workerRun } } })
  if (scenario === 'Desktop draft after admission') {
    expect(drafts[owners.at(-1)!]).toBe('new mounted draft after Desktop admission')
    await vi.waitFor(() => expect(desktopReconciled.has('closeout-stop')).toBe(true))
  }
  expect(host.native.stop).toHaveBeenCalledTimes(1)
  expect(host.native.stop).toHaveBeenCalledWith(expect.objectContaining({ runId: workerRun }))
  const retained = await host.call(null, ['agent', 'stop', 'inspect', '--session', 'worker', '--run', workerRun, '--operation-id', 'closeout-stop'])
  expect(retained).toMatchObject({ phase: 'retired', operationIdMatched: true })
  await host.stop(); await host.start()
  const historical = await host.call('supervisor', ['goal', 'plan', '--goal', goalId])
  expect(historical.delegations[0]).toMatchObject({ report: signed, collection: { operationId: 'closeout-collection' } })
  expect(historical.planState.nodes[0].state).toBe('review')
  expect(historical.grounding.acceptedAt).toBeNull()
})
