import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableAgentMuxMessageQueue, type AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'
import { renderAgentMuxMessageReferences } from '../src/agent-message-render.js'
import { AGENTMUX_A2A_REFERENCE_REMINDER } from '../src/agent-messaging-guidance.js'
import { fixtureEpoch } from './helpers/fixture-values.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function location() {
  const root = await mkdtemp(join(tmpdir(), 'amux-reference-budget-')); roots.push(root)
  return join(root, 'messages.ndjson')
}
const condition = { expectedRun: { runId: 'recipient-run' }, afterSubmissionId: null }
const notice = (notificationId: string) => ({ notificationId, agentSessionId: 'recipient', condition, idle: { completionId: 'original-completion', inputByte: 0 } })
function message(messageId: string, senderSessionId = 'sender'): AgentMuxMessageAppendInput {
  return { messageId, operationId: 'operation-' + messageId.slice(0, 32), createdAt: fixtureEpoch(0, 1),
    sender: { kind: 'agent-session', agentSessionId: senderSessionId }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId, senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: 'recipient-run',
    threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: 'Original retained body' }
}

it('preserves an original reader-admitted reference when only optional guidance exceeds its budget', async () => {
  const path = await location(), messageId = 'm'.repeat(65_300), original = { ...message(messageId), schema: 'agentmux.a2a.v1' }
  // This is an accepted original reader input, not a claim that today's Client
  // creates such MIDs or that the record authenticates a historical producer.
  await writeFile(path, JSON.stringify({ kind: 'message', sequence: 1, envelope: original, deliveryMode: 'reference', execution: 'default', promptCondition: null }) + '\n')
  const queue = new DurableAgentMuxMessageQueue(path)
  expect((await queue.readByMessageId(messageId))?.envelope.body).toBe(original.body)
  const prepared = queue.prepareNotification(notice('original-reader-reference'))
  await expect(prepared).resolves.toMatchObject({ messageIds: [messageId] })
  const frozen = (await prepared)!
  expect(frozen.wire).toBe(renderAgentMuxMessageReferences([{ senderSessionId: 'sender', messageId }]))
  expect(Buffer.byteLength(frozen.wire)).toBeLessThanOrEqual(64 * 1024)
  expect((await new DurableAgentMuxMessageQueue(path).readNotification(frozen.notificationId))?.wire).toBe(frozen.wire)
})

it('keeps complete admitted sender identities and leaves the next MID eligible with normal guidance', async () => {
  const queue = new DurableAgentMuxMessageQueue(await location()), senderSessionId = 's'.repeat(65_300)
  await expect(queue.append(message('first', senderSessionId), { deliveryMode: 'reference' })).resolves.toMatchObject({ messageId: 'first' })
  await queue.append(message('second'), { deliveryMode: 'reference' })
  const prepared = queue.prepareNotification(notice('first-notice'))
  await expect(prepared).resolves.toMatchObject({ messageIds: ['first'] })
  const first = (await prepared)!
  expect(first.wire).toBe(renderAgentMuxMessageReferences([{ senderSessionId, messageId: 'first' }]))
  const second = (await queue.prepareNotification(notice('second-notice')))!
  expect(second.messageIds).toEqual(['second']); expect(second.wire).toContain(AGENTMUX_A2A_REFERENCE_REMINDER)
  const explicit = new DurableAgentMuxMessageQueue(await location())
  await explicit.append(message('first', senderSessionId), { deliveryMode: 'reference' })
  await explicit.append(message('second'), { deliveryMode: 'reference' })
  await expect(explicit.prepareNotification({ ...notice('too-many'), messageIds: ['first', 'second'] })).rejects.toMatchObject({ code: 'INVALID_A2A_NOTIFICATION' })
  await expect(explicit.prepareNotification({ ...notice('one-fitting-reference'), messageIds: ['first'] })).resolves.toMatchObject({ wire: first.wire })
})
