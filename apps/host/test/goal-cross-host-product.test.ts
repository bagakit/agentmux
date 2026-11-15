import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'
import type { AgentMuxSignedMessage } from '../../../packages/core/src/agent-message-federation.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

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
  const a = await crossHostOwner(cleanup, 'goal-owner', ['same-session', 'independent-reviewer'])
  const b = await crossHostOwner(cleanup, 'goal-worker', ['same-session'])
  // The original Goal predates connecting another same-SID Runtime. The saved
  // local Supervisor must retain its identity when the remote route is added.
  a.routes([]); b.routes([])
  await trust(a, b); await trust(b, a)
  const goalId = 'original-cross-host-goal'
  await a.call('same-session', ['goal', 'create', '--goal', goalId, '--title', 'Ship the original result', '--description', 'Preserve the original human intent.',
    '--status', 'in_progress', '--session', 'same-session', '--assignees', JSON.stringify(['same-session', 'independent-reviewer']), '--supervisor', 'same-session', '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-original-goal'])
  const alignment = { summary: 'Deliver and independently verify the original result.', criteria: [{ id: 'original-criterion', text: 'The original result is independently checked.' }], openQuestions: [] }
  const aligned = await a.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify(alignment)])
  const alignmentRevision = aligned.goal.alignment.revision
  a.routes([{ hostId: 'worker-b', client: b.reader }])
  const ambiguous = await a.cli(null, ['goal', 'create', '--goal', 'ambiguous-goal', '--title', 'An ambiguous relation is refused', '--session', 'same-session',
    '--assignees', JSON.stringify(['same-session', 'independent-reviewer']), '--supervisor', 'same-session', '--risk', 'low', '--confirm', 'user', '--operation-id', 'ambiguous-create-operation'])
  expect(ambiguous.code).toBe(1); expect(ambiguous.stderr, ambiguous.stderr + ambiguous.stdout).toContain('AMBIGUOUS_AGENT_SESSION')
  const nodes = ['first', 'dependent'].map(id => ({ id, title: 'Deliver ' + id, outcome: 'Original ' + id + ' outcome', dependsOn: id === 'dependent' ? ['first'] : [],
    criterionIds: ['original-criterion'], check: 'node --test checks/' + id + '.test.mjs', executor: { hostId: 'worker-b', agentSessionId: 'same-session' } }))
  await a.call('same-session', ['goal', 'plan', 'revise', '--input', '-'], { goalId, revision: { operationId: 'original-plan-revision', expectedRevision: 0, alignmentRevision, nodes } })
  const intent = (nodeId: string) => ({ operationId: 'delegate-' + nodeId, sourceMessageId: 'source-' + nodeId, hostId: 'local', workerHostId: 'worker-b', ownerAgentSessionId: 'same-session', workerAgentSessionId: 'same-session',
    ownerRunId: 'run-same-session', workerRunId: 'run-same-session', threadId: 'thread-' + nodeId, text: 'Deliver the original ' + nodeId + ' task.', alignmentRevision, criterionIds: ['original-criterion'], planNodeId: nodeId })
  const blocked = await a.cli('same-session', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent') })
  expect(blocked.code).toBe(1); expect(blocked.stderr).toContain('only a ready node')
  const delegated = await a.call('same-session', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('first') })
  expect(delegated.delegations[0]).toMatchObject({ operationId: 'delegate-first', sourceMessageId: 'source-first', hostId: 'local', workerHostId: 'worker-b', linkedAt: expect.any(Number),
    runtimeIdentity: { ownerRuntimeId: a.identity.runtimeId, workerRuntimeId: b.identity.runtimeId } })
  expect((await b.call(null, ['goal', 'ls', '--all'])).goals).toEqual([])
  const report = { operationId: 'report-first', replyMessageId: 'reply-first', authorAgentSessionId: 'same-session', grounding: { alignmentRevision, summary: 'The worker reports the original criterion with evidence.',
    checks: [{ criterionId: 'original-criterion', outcome: 'met', evidence: ['checks/first.log:1'], note: '' }] } }
  const reportInput = { goalId, operationId: 'delegate-first', sourceMessageId: 'source-first', report }
  const submitted = await b.call('same-session', ['goal', 'report', '--input', '-'], reportInput)
  expect(submitted).toMatchObject({ kind: 'report-submission', goalId, delegationOperationId: 'delegate-first', sourceMessageId: 'source-first', submission: { messageId: 'reply-first', transport: { state: 'outbox', targetRuntimeId: a.identity.runtimeId } } })
  expect((await b.call(null, ['goal', 'ls', '--all'])).goals).toEqual([])
  const originalReply = await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'reply-first'])
  const collected = await a.call('same-session', ['goal', 'collect', '--input', '-'], { goalId, operationId: 'delegate-first', collection: { operationId: 'collect-first', replyMessageId: 'reply-first' } })
  expect(collected.delegations[0]).toMatchObject({ report: { ...report, submittedAt: expect.any(Number) }, collection: { operationId: 'collect-first', replyMessageId: 'reply-first' } })
  const received = await a.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'reply-first'])
  expect(received.message.provenance).toEqual(originalReply.message.provenance)
  const stillBlocked = await a.cli('same-session', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent') })
  expect(stillBlocked.code).toBe(1); expect(stillBlocked.stderr).toContain('only a ready node')
  const checks = join(a.original.root, 'checks'); await mkdir(checks)
  await writeFile(join(checks, 'worker.json'), JSON.stringify(originalReply.message))
  await writeFile(join(checks, 'received.json'), JSON.stringify(received.message))
  await writeFile(join(checks, 'first.test.mjs'), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
test('the received original report retains its worker signature and exact Goal criterion',()=>{const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8')); const worker=read('./worker.json'),received=read('./received.json'); assert.deepEqual(received.provenance,worker.provenance); assert.deepEqual(received.envelope.application,worker.envelope.application); assert.equal(received.envelope.replyTo,'source-first'); assert.equal(received.envelope.operationId,'report-first');});\n`)
  const checked = await promisify(execFile)(process.execPath, ['--test', 'checks/first.test.mjs'], { cwd: a.original.root })
  await writeFile(join(checks, 'review-first.log'), checked.stdout + checked.stderr)
  expect(checked.stdout).toContain('pass 1')
  const review = { operationId: 'review-first', nodeId: 'first', delegationOperationId: 'delegate-first', deliveryHash: collected.delegations[0].report.delivery.hash, verdict: 'pass',
    check: { command: nodes[0]!.check, result: checked.stdout, evidence: ['checks/review-first.log:1'] }, note: '' }
  const foreignWorker = await a.cli('same-session', ['goal', 'plan', 'review', '--input', '-'], { goalId, review: { ...review, operationId: 'foreign-worker-review' } }, b.original.capability)
  expect(foreignWorker.code).toBe(1); expect(foreignWorker.stderr).toContain('AGENT_CAPABILITY_INVALID')
  await a.call('independent-reviewer', ['goal', 'plan', 'review', '--input', '-'], { goalId, review })
  const unlocked = await a.call('same-session', ['goal', 'delegate', '--input', '-'], { goalId, intent: intent('dependent') })
  expect(unlocked.plan.reviews[0]).toMatchObject({ ...review, reviewer: { kind: 'agent', id: 'independent-reviewer', hostId: 'local', runtimeId: a.identity.runtimeId } })
  expect(unlocked.delegations.map((item: { operationId: string }) => item.operationId)).toEqual(['delegate-first', 'delegate-dependent'])
  const final = await a.call(null, ['goal', 'inspect', '--goal', goalId])
  expect(final.goal).toMatchObject({ status: 'in_progress', description: 'Preserve the original human intent.', alignment: { confirmedAt: null }, grounding: { acceptedAt: null } })
  expect(await a.original.store.readMetadata('independent-reviewer')).not.toBeNull()
  expect(await b.original.store.readMetadata('independent-reviewer')).toBeNull()
})
