import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { DurableAgentMuxMessageQueue, type AgentPromptSubmissionRecord, type AgentTimelineItem, type DurableAgentMuxMessage } from '@agentmux/core'
import { renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { consumeConversationWindowPage } from '@agentmux/core/conversation'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { createNativeInputCorrelation } from '../../../../packages/core/src/native-input-correlation'
import { source, turn, user, jsonl } from '../../../../packages/core/test/helpers/codex-paginated'
import { nativeHistoryFixture } from '../../../../packages/core/test/fixtures/native-history-session'

export const messageId = 'original-collaboration-message'
export const senderSessionId = 'original-collaborator'
export const wire = renderAgentMuxMessageReferences([{ senderSessionId, messageId }])
export const body = '### 原始协作消息\n\n请核对 **消息原文与接收者**，保留已有工作面。\n\n- 原文只出现一次\n- 来源进入按需详情\n\n> 原文保持原作者身份。'
export const metadataSentAt = 1
export const metadataPreparedAt = metadataSentAt + 25 * 60_000 + 14_000
export const metadataResultAt = metadataPreparedAt + 1_000
export type MetadataScene = 'idle' | 'steer' | 'legacy' | 'unconfirmed'

/** Real Provider adoption, FileStore and public Reader; no process or model is started. */
export async function a2aPrimaryReadingFixture(multipleSenders = false, metadata?: MetadataScene) {
  // An ambient Agent queue must never become the authority of this explicit private FileStore.
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', undefined)
  const native = await nativeHistoryFixture('codex', root => jsonl([{ type: 'session_meta', payload: {
    id: source.nativeSessionId, cwd: root, history_mode: 'paginated'
  } }]), { nativeSessionId: source.nativeSessionId, agentSessionId: 'paginated-reader-fixture' })
  const f = { ...native, transcriptPath: native.path }
  const connect = vi.spyOn(f.client, 'connect')
  expect(f.client.agentMessageQueuePath()).toBe(join(f.root, 'global-messages.ndjson'))
  let queue = new DurableAgentMuxMessageQueue(metadata === 'legacy' ? join(f.root, 'legacy-seed.ndjson') : f.client.agentMessageQueuePath())
  const reference = { hostId: 'local', agentSessionId: f.session.agentSessionId }
  const key = { kind: 'prompt' as const, agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, submissionId: 'original-notification' }
  const notificationWire = multipleSenders ? renderAgentMuxMessageReferences([
    { senderSessionId, messageId }, { senderSessionId: 'second-collaborator', messageId: 'second-collaboration-message' }
  ]) : wire
  const plan = { kind: 'native-rpc' as const, protocolId: 'original-protocol', actorId: 'original-actor',
    sourceId: JSON.stringify([source.providerId, source.nativeSessionId]), threadId: source.nativeSessionId,
    operation: 'queue-idle' as const, clientCorrelation: createNativeInputCorrelation(key) }
  const admission: NonNullable<AgentPromptSubmissionRecord['admission']> = {
    submissionId: key.submissionId, operationId: key.submissionId, inputKey: key, transport: 'native', acknowledged: true,
    intent: { run: f.session.run, ownerInstanceId: 'original-owner', prompt: notificationWire, plan, execution: 'default',
      message: { systemContext: notificationWire, a2aNotificationId: key.submissionId },
      admissionIntent: { kind: 'exact-condition', condition: { expectedRun: f.session.run, afterSubmissionId: null } } },
    native: { plan, outcome: 'admitted', queuedSubmissionId: 'original-queue-entry' }
  }
  const next = { ...f.session, promptCompletionAdmission: admission }
  if (metadata !== 'unconfirmed') { await f.store.compareAndSwap(f.session, next); Object.assign(f.session, next) }
  const captured: AgentTimelineItem = { id: 'original-captured-notification', agentSessionId: reference.agentSessionId,
    kind: 'system_message', source: 'agentmux', status: 'complete', title: 'AgentMux context', content: notificationWire,
    a2aNotificationId: key.submissionId, inputRef: key, createdAt: 1, updatedAt: 1 }
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: reference.agentSessionId, item: captured })
  const nativeInput = user('original-native-notification', [{ type: 'text', text: notificationWire }])
  nativeInput.payload.item.client_id = plan.clientCorrelation
  if (metadata !== 'unconfirmed') await appendFile(f.transcriptPath, jsonl([nativeInput]))
  const original: DurableAgentMuxMessage = { sequence: 1, delivery: { state: 'queued', at: 1 }, envelope: {
    schema: 'agentmux.a2a.v1', messageId, operationId: 'original-message-operation', createdAt: metadata ? metadataSentAt : 1,
    sender: { kind: 'agent-session', agentSessionId: senderSessionId }, senderSessionId, senderRunId: 'original-sender-run',
    recipient: { kind: 'agent-session', agentSessionId: reference.agentSessionId }, recipientSessionId: reference.agentSessionId,
    recipientRunId: f.session.run.runId, threadId: messageId, correlationId: messageId, replyTo: null, workspaceId: null, body
  } }
  const originals = multipleSenders ? [original, { ...original, sequence: 2, envelope: { ...original.envelope,
    messageId: 'second-collaboration-message', operationId: 'second-message-operation', senderSessionId: 'second-collaborator',
    sender: { kind: 'agent-session' as const, agentSessionId: 'second-collaborator' }, senderRunId: 'second-sender-run',
    body: '第二位 Agent 的原文保持独立。先读原信，再按需查看通知与来源。' } }] : [original]
  for (const message of originals) {
    const { schema: _schema, ...envelope } = message.envelope
    await queue.append(envelope, { deliveryMode: 'reference' })
  }
  if (metadata) {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(metadataPreparedAt)
    try {
      await queue.prepareNotification({ notificationId: key.submissionId, agentSessionId: reference.agentSessionId,
        condition: { expectedRun: f.session.run, afterSubmissionId: null },
        ...(metadata === 'steer' ? { messageIds: originals.map(message => message.envelope.messageId) } : { idle: { completionId: 'original-completion', inputByte: 0 } }) })
      clock.mockReturnValue(metadataResultAt)
      await queue.recordNotificationResult(key.submissionId, metadata === 'unconfirmed' ? 'unconfirmed' : 'submitted')
      // A newer user-authorized notification must never replace this captured notice's facts.
      clock.mockReturnValue(metadataResultAt + 60_000)
      await queue.prepareNotification({ notificationId: 'later-manual-notification', agentSessionId: reference.agentSessionId,
        condition: { expectedRun: f.session.run, afterSubmissionId: null }, messageIds: originals.map(message => message.envelope.messageId) })
      await queue.recordNotificationResult('later-manual-notification', 'submitted')
    } finally { clock.mockRestore() }
    if (metadata === 'legacy') {
      // Import an actual old journal shape, preserving its notice, outcome, body and identities.
      const historical = (await queue.readJournal()).map(record => {
        if (record.kind !== 'a2a-notification' && record.kind !== 'a2a-notification-result') return record
        const { at: _notRecorded, ...retained } = record
        return retained
      })
      await writeFile(f.client.agentMessageQueuePath(), historical.map(record => JSON.stringify(record)).join('\n') + '\n')
      queue = new DurableAgentMuxMessageQueue(f.client.agentMessageQueuePath())
    }
  }
  const saved = await Promise.all(originals.map(message => f.client.readMessage({ messageId: message.envelope.messageId,
    ...(metadata ? { notificationId: key.submissionId } : {}) })))
  expect(saved.every(message => message !== null)).toBe(true)
  const page = await f.client.readAgentConversation({ ...reference, limit: 100 })
  const assembled = consumeConversationWindowPage(page)
  expect(assembled.kind, 'The bounded original notice frame must complete').toBe('complete')
  if (assembled.kind !== 'complete') throw Error('Expected the bounded original notice frame')
  const projection = projectConversationWindow(assembled.snapshot)
  expect(projection.records).toHaveLength(1)
  expect(projection.records[0]!.role).toBe('notice')
  expect(projection.records[0]!.records!.map(record => record.original.kind).sort()).toEqual(metadata === 'unconfirmed' ? ['captured'] : ['captured', 'native'])
  expect(projection.inputs).toHaveLength(0)
  await queue.readMessageRoute(undefined, messageId)
  const journal = await queue.readJournal(), transcriptBytes = await readFile(f.transcriptPath)
  return { ...f, reference, key, captured, page, snapshot: assembled.snapshot, projection,
    original: saved[0]!, originals: saved as DurableAgentMuxMessage[], wire: notificationWire,
    close: async () => {
      try {
        // Hosted observation may initialize a derived SQLite event index; original journal records must stay exact.
        expect(await queue.readJournal()).toEqual(journal)
        expect(await readFile(f.transcriptPath)).toEqual(transcriptBytes)
        expect(connect).not.toHaveBeenCalled()
        for (const control of f.controls.slice(0, -1)) expect(control).not.toHaveBeenCalled()
        const status = f.controls.at(-1)!
        for (const args of status.mock.calls) expect(args).toEqual([f.session.run.runId])
        const current = await f.store.readMetadata(f.session.agentSessionId)
        const { nativeSourceObservation, updatedAt: _observedAt, ...retained } = current!
        const { updatedAt: _seededAt, ...expected } = f.session
        expect(retained).toEqual(expected)
        if (nativeSourceObservation) expect(nativeSourceObservation).toMatchObject({ run: f.session.run, state: 'unknown', reason: 'current-main-unconfirmed' })
      }
      finally { await f.close() }
    } }
}
