import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'
import { writeFile } from 'node:fs/promises'

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Owner = Awaited<ReturnType<typeof crossHostOwner>>
async function approve(source: Owner, target: Owner) {
  const a = await source.call(null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  const b = await target.call(null, ['settings', 'hosts', 'message-trusted-sources', '--host', 'local'])
  await target.call(null, ['settings', 'hosts', 'trust-message-source', '--host', 'local', '--input', '-'], {
    sourceRuntimeId: a.authority.runtimeId, publicKey: a.authority.publicKey, targetRuntimeId: b.authority.runtimeId, targetKeyFingerprint: b.authority.fingerprint
  })
}

it('carries typed questions and the owner answer through the original one-way connection', async () => {
  const a = await crossHostOwner(cleanup, 'dialogue-owner', ['same-session'])
  const b = await crossHostOwner(cleanup, 'dialogue-worker', ['same-session'])
  a.routes([{ hostId: 'worker', client: b.reader }]); b.routes([])
  await approve(a, b); await approve(b, a)
  await a.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'agent-session', hostId: 'worker', agentSessionId: 'same-session' },
    operationId: 'dialogue-source-operation', messageId: 'dialogue-source', threadId: 'dialogue-thread', text: 'Original authorized work.' })
  await a.call('same-session', ['message', 'dispatch', 'open', '--source-message', 'dialogue-source'])
  a.routes([])
  const retained = await a.call(null, ['message', 'read', '--host', 'local', '--message-id', 'dialogue-source'])
  expect(retained.message).toMatchObject({ envelope: { body: 'Original authorized work.' }, transport: { state: 'outbox' }, peerInbox: { runtimeId: b.identity.runtimeId, deliveryMode: 'reference' } })
  a.routes([{ hostId: 'worker', client: b.reader }])
  const questionReply = await b.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId: 'dialogue-source' },
    operationId: 'dialogue-question-operation', messageId: 'dialogue-question', text: 'Which original criterion should I check?' })
  const wrongActor = await b.cli('same-session', ['message', 'dispatch', 'report', '--source-message', 'dialogue-source', '--reply-message', 'dialogue-question', '--kind', 'cleanup'])
  expect(wrongActor.code).toBe(1); expect(wrongActor.stderr).toContain('DISPATCH_PARTICIPANT_MISMATCH')
  const question = await b.call('same-session', ['message', 'dispatch', 'report', '--source-message', 'dialogue-source', '--reply-message', 'dialogue-question', '--kind', 'question'])
  expect(question).toMatchObject({ kind: 'dispatch-event-submission', diskDurability: 'confirmed', event: { kind: 'question' } })
  // The valid original reply already exists, so a missing-message guard cannot
  // hide removal of the event's cryptographic author check.
  await a.call(null, ['message', 'federation', 'intake', '--input', '-'], { packet: { envelope: questionReply.envelope, execution: 'default', sourceChannel: questionReply.sourceChannel, provenance: questionReply.provenance } })
  for (const event of [{ ...question.event, kind: 'worker_done' }, { ...question.event, provenance: { ...question.event.provenance, signature: 'A'.repeat(86) } }]) {
    const forged = await a.cli(null, ['message', 'federation', 'dispatch-intake', '--input', '-'], { event })
    expect(forged.code).toBe(1); expect(forged.stderr).toContain('AGENT_MESSAGE_AUTHORITY_INVALID')
  }
  const synchronized = await a.call('same-session', ['message', 'dispatch', 'sync', '--source-message', 'dialogue-source', '--host', 'worker'])
  expect(synchronized.dispatch.events).toContainEqual(expect.objectContaining({ kind: 'question', replyMessageId: 'dialogue-question', authority: question.event }))
  expect(synchronized.dispatch.originAwaits).toBe(true)
  expect(synchronized.remoteSource).toMatchObject({ kind: 'recipient-inbox', runtimeId: b.identity.runtimeId, messageId: 'dialogue-source',
    operationId: 'dialogue-source-operation', intentDigest: synchronized.source.provenance.intentDigest, deliveryMode: 'reference', diskDurability: 'confirmed' })
  await a.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId: 'dialogue-question' },
    operationId: 'dialogue-answer-operation', messageId: 'dialogue-answer', text: 'Check the exact original criterion and keep its evidence.' })
  expect((await a.call(null, ['message', 'read', '--host', 'local', '--message-id', 'dialogue-answer'])).message.peerInbox).toBeUndefined()
  b.loseNextIntakeAck()
  const unknown = await a.cli('same-session', ['message', 'dispatch', 'sync', '--source-message', 'dialogue-source', '--host', 'worker'])
  expect([0, 1]).toContain(unknown.code)
  if (unknown.code === 1) {
    expect(unknown.stderr).toContain('CONTROL_UNAVAILABLE')
    expect((await a.call(null, ['message', 'read', '--host', 'local', '--message-id', 'dialogue-answer'])).message.peerInbox).toBeUndefined()
  }
  const answer = await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'dialogue-answer'])
  expect(answer.message).toMatchObject({ envelope: { replyTo: 'dialogue-question', threadId: 'dialogue-thread', senderRuntimeId: a.identity.runtimeId, recipientRuntimeId: b.identity.runtimeId }, transport: { state: 'received' } })
  const beforeReconcile = b.forwarded.filter(row => row.method === 'message.federation.intake' && (row.params as { packet: { envelope: { messageId: string } } }).packet.envelope.messageId === 'dialogue-answer').length
  const reconciled = await a.call('same-session', ['message', 'dispatch', 'sync', '--source-message', 'dialogue-source', '--host', 'worker'])
  expect(reconciled.replies.map((reply: { envelope: { messageId: string } }) => reply.envelope.messageId)).toContain('dialogue-answer')
  expect(b.forwarded.filter(row => row.method === 'message.federation.intake' && (row.params as { packet: { envelope: { messageId: string } } }).packet.envelope.messageId === 'dialogue-answer')).toHaveLength(beforeReconcile)
  expect(beforeReconcile).toBe(1)
  const confirmed = await a.call(null, ['message', 'read', '--host', 'local', '--message-id', 'dialogue-answer'])
  expect(confirmed.message).toMatchObject({ peerInbox: { runtimeId: b.identity.runtimeId, messageId: 'dialogue-answer', sequence: answer.message.sequence },
    deliveryMode: 'outbox', delivery: { state: 'queued' }, transport: { state: 'outbox' } })
  await b.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId: 'dialogue-source' },
    operationId: 'dialogue-escalation-operation', messageId: 'dialogue-escalation', text: 'The original dependency remains blocked.' })
  await b.call('same-session', ['message', 'dispatch', 'report', '--source-message', 'dialogue-source', '--reply-message', 'dialogue-escalation', '--kind', 'escalation'])
  const blocked = await a.call('same-session', ['message', 'dispatch', 'sync', '--source-message', 'dialogue-source', '--host', 'worker'])
  expect(blocked.dispatch.events.at(-1)).toMatchObject({ kind: 'escalation', replyMessageId: 'dialogue-escalation' })
  expect(blocked.dispatch.originAwaits).toBe(true)
  await a.stop(); await a.start(); a.routes([])
  const reopened = await a.call(null, ['message', 'read', '--host', 'local', '--message-id', 'dialogue-answer'])
  expect(reopened.message.peerInbox).toEqual(confirmed.message.peerInbox)
  expect(a.native.stop).not.toHaveBeenCalled(); expect(b.native.stop).not.toHaveBeenCalled()
  if (process.env.AGENTMUX_TEST_DIALOGUE_RECEIPTS) await writeFile(process.env.AGENTMUX_TEST_DIALOGUE_RECEIPTS, JSON.stringify({
    schema: 'agentmux.cross-host-dialogue-consumers.v1', runtimes: { owner: a.identity.runtimeId, worker: b.identity.runtimeId },
    owner: a.cliReceipts, worker: b.cliReceipts, nativeStops: { owner: a.native.stop.mock.calls.length, worker: b.native.stop.mock.calls.length }
  }, null, 2) + '\n', { mode: 0o600 })
})
