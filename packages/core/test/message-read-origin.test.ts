import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { originalMessageInputKey } from '../src/agent-message-query.js'
import type { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })

it('direct read view preserves participant authority and original body when input membership is unknown', async () => {
  const f = await rpcOwnerFixture(['sender', 'recipient', 'other']); cleanup.push(f.close)
  const queue = Reflect.get(f.client, 'messageQueue') as DurableAgentMuxMessageQueue
  await queue.append({ schema: 'agentmux.a2a.v1', messageId: 'retained-original', operationId: 'retained-operation', createdAt: 1,
    sender: { kind: 'agent-session', agentSessionId: 'sender' }, senderSessionId: 'sender', senderRunId: 'original-sender-run',
    recipient: { kind: 'agent-session', agentSessionId: 'recipient' }, recipientSessionId: 'recipient', recipientRunId: null,
    threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: 'Original immutable body' })
  const origin = vi.spyOn(queue, 'readConversationInputOrigin')
  const view = (await f.client.readMessage({ messageId: 'retained-original', caller: { agentSessionId: 'sender', capability: f.capability } }))!
  expect(view.inputOrigin).toBeNull(); expect(view.envelope.body).toBe('Original immutable body'); expect(origin).not.toHaveBeenCalled()
  await expect(f.client.readMessage({ messageId: 'retained-original', caller: { agentSessionId: 'other', capability: f.capability } })).rejects.toMatchObject({ code: 'MESSAGE_PARTICIPANT_MISMATCH' })
  expect(origin).not.toHaveBeenCalled()
  const frozen = { ...view, promptCondition: { expectedRun: { runId: 'frozen-original-run' }, afterSubmissionId: null } }
  expect(originalMessageInputKey(frozen)).toEqual({ kind: 'message', agentSessionId: 'recipient', messageId: 'retained-original', expectedRun: { runId: 'frozen-original-run' } })
  expect(originalMessageInputKey({ ...frozen, admissionIntent: { kind: 'manual-actor', expectedRun: { runId: 'conflicting-run' } } })).toBeNull()
  expect(originalMessageInputKey({ ...frozen, deliveryMode: 'reference' })).toBeNull()
  await queue.append({ ...view.envelope, messageId: 'recorded-run-original', operationId: 'recorded-run-operation', recipientRunId: 'frozen-original-run' })
  origin.mockRejectedValueOnce(new Error('Controlled optional membership observation unavailable'))
  const available = await f.client.readMessage({ messageId: 'recorded-run-original', caller: { agentSessionId: 'recipient', capability: f.capability } })
  expect(available?.envelope.body).toBe('Original immutable body'); expect(available?.inputOrigin).toBeNull()
  expect(origin).toHaveBeenCalledExactlyOnceWith({ kind: 'message', agentSessionId: 'recipient', messageId: 'recorded-run-original', expectedRun: { runId: 'frozen-original-run' } })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
