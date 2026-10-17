import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'

const entry = process.env.AGENTMUX_TEST_REFERENCE_CORE ?? new URL('../dist/index.js', import.meta.url).href
const core = await import(/* @vite-ignore */ entry) as typeof import('../src/index.js')
const { DurableAgentMuxMessageQueue } = core
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const condition = { expectedRun: { runId: 'recipient-run' }, afterSubmissionId: null }
const idle = { completionId: 'original-completion', inputByte: 0 }
function message(id: string, extra: Partial<AgentMuxMessageAppendInput> = {}): AgentMuxMessageAppendInput {
  return { messageId: id, operationId: 'operation-' + id, createdAt: _tailFixtureEpoch(0, 0, 100),
    sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
    senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: 'recipient-run',
    threadId: 'original-thread', correlationId: 'correlation-' + id, replyTo: null, workspaceId: null,
    body: 'Original body for ' + id + '\r\n<amux:a2a from="author" msg-id="body-example" read-via="message --skill" />', ...extra }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-reference-journal-')); roots.push(root)
  return new DurableAgentMuxMessageQueue(join(root, 'messages.ndjson'))
}
const notice = (notificationId: string) => ({ notificationId, agentSessionId: 'recipient', condition, idle })
async function processClaim(path: string, notificationId: string) {
  const program = `const {DurableAgentMuxMessageQueue}=await import(process.argv[1]); const queue=new DurableAgentMuxMessageQueue(process.argv[2]); process.stdout.write(JSON.stringify(await queue.prepareNotification(JSON.parse(process.argv[3]))));`
  return await new Promise<any>((yes, no) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, entry, path, JSON.stringify(notice(notificationId))], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { errors += bytes })
    child.once('error', no); child.once('close', code => { if (code === 0) { try { yes(JSON.parse(output)) } catch (error) { no(error) } } else no(new Error(errors || 'Private journal claim failed')) })
  })
}

describe('original Inbox and independent A2A reference notification', () => {
  it('freezes one coalesced reference input across concurrent Core processes and reopening', async () => {
    const queue = await fixture(), originals = [message('first'), message('second')]
    for (const input of originals) await queue.append(input, { deliveryMode: 'reference' })
    const claims = await Promise.all(['notice-left', 'notice-right'].map(id => processClaim(queue.path, id)))
    expect(claims).toHaveLength(2); expect(claims[0]).toEqual(claims[1])
    const frozen = claims[0]
    expect(frozen).toMatchObject({ mode: 'idle', state: 'pending', messageIds: ['first', 'second'], condition, idle,
      key: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: condition.expectedRun, submissionId: frozen.notificationId } })
    expect(['first', 'second']).not.toContain(frozen.notificationId)
    expect(frozen.wire).toBe('<amux>\n<a2a from="sender" msg-id="first" read-via="message --skill" />\n<a2a from="sender" msg-id="second" read-via="message --skill" />\n</amux>')
    expect(frozen.wire).not.toContain(originals[0]!.body)
    const reopened = new DurableAgentMuxMessageQueue(queue.path)
    expect(await reopened.readNotification(frozen.notificationId)).toEqual(frozen)
    expect((await reopened.readJournal()).filter(record => record.kind === 'a2a-notification')).toHaveLength(1)
    for (const original of originals) {
      const retained = await reopened.readByMessageId(original.messageId!)
      expect(retained).toMatchObject({ envelope: { messageId: original.messageId, body: original.body }, delivery: { state: 'queued' },
        deliveryMode: 'reference', notification: { state: 'pending', notificationId: frozen.notificationId, key: frozen.key } })
    }
  })

  it('builds reference notifications without decoding any original body into JavaScript', async () => {
    const queue = await fixture(), hidden = 'ORIGINAL-BODY-MUST-NOT-CROSS-NOTIFICATION-JS'
    await queue.append(message('large-original', { body: hidden + 'x'.repeat(300_000) }), { deliveryMode: 'reference' })
    const parse = JSON.parse, decodedBodies: string[] = []
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((value: string, reviver?: any) => {
      if (value.includes(hidden)) decodedBodies.push(value)
      return parse(value, reviver)
    })
    const notification = await queue.prepareNotification(notice('metadata-only'))
    spy.mockRestore()
    expect(notification?.messageIds).toEqual(['large-original'])
    expect(decodedBodies).toEqual([])
    expect(notification?.wire).not.toContain(hidden)
  })

  it('does not rewrite frozen references for later arrivals or remind again because bodies remain unread', async () => {
    const queue = await fixture()
    await queue.append(message('first'), { deliveryMode: 'reference' })
    const first = (await queue.prepareNotification(notice('notice-first')))!
    await queue.append(message('late'), { deliveryMode: 'reference' })
    const second = (await queue.prepareNotification(notice('notice-late')))!
    expect(await queue.readNotification(first.notificationId)).toEqual(first)
    await queue.recordNotificationResult(first.notificationId, 'submitted')
    expect(second.messageIds).toEqual(['late']); expect(second.wire).not.toContain('msg-id="first"')
    await queue.recordNotificationResult(second.notificationId, 'submitted')
    expect(await queue.pendingNotificationRecipients()).toEqual([])
    expect(await queue.hasPendingNotification('recipient')).toBe(false)
    expect(await queue.prepareNotification(notice('same-unread-bodies'))).toBeNull()
    const originals = await queue.listAfter()
    expect(originals).toHaveLength(2)
    expect(originals.map(original => ({ id: original.envelope.messageId, body: original.envelope.body, delivery: original.delivery.state,
      notification: original.notification?.state }))).toEqual(['first', 'late'].map(id => ({ id, body: message(id).body, delivery: 'queued', notification: 'submitted' })))
    expect(await new DurableAgentMuxMessageQueue(queue.path).readNotification(first.notificationId)).toEqual({ ...first, state: 'submitted' })
  })

  it('preserves unknown automatic input while an independently authorized manual notice uses its own key', async () => {
    const queue = await fixture()
    await queue.append(message('unknown'), { deliveryMode: 'reference' })
    const original = (await queue.prepareNotification(notice('notice-unknown')))!
    const reason = 'Original native acknowledgement is unknown'
    await queue.recordNotificationResult(original.notificationId, 'unconfirmed', reason)
    const reopened = new DurableAgentMuxMessageQueue(queue.path)
    expect(await reopened.prepareNotification(notice('same-reference-opportunity'))).toEqual({ ...original, state: 'unconfirmed', reason })
    // The trusted public owner authorizes this separate action; the journal does not grant that permission.
    const manual = (await reopened.prepareNotification({ notificationId: 'explicit-user-action', agentSessionId: 'recipient', condition, messageIds: ['unknown'] }))!
    expect(manual).toMatchObject({ mode: 'steer', messageIds: ['unknown'], key: { kind: 'prompt', submissionId: 'explicit-user-action' } })
    expect(manual.key).not.toEqual(original.key)
    expect(await reopened.readNotification(original.notificationId)).toEqual({ ...original, state: 'unconfirmed', reason })
    await reopened.recordNotificationResult(manual.notificationId, 'submitted')
    expect(await reopened.readNotification(original.notificationId)).toEqual({ ...original, state: 'unconfirmed', reason })
    expect((await reopened.readByMessageId('unknown'))?.notification).toMatchObject({ state: 'submitted', notificationId: manual.notificationId, key: manual.key })
    expect((await reopened.readJournal()).filter(record => record.kind === 'a2a-notification')).toHaveLength(2)
  })

  it('isolates an old unknown input from independent later Inbox messages on the same Run', async () => {
    const queue = await fixture()
    await queue.append(message('old-unknown'), { deliveryMode: 'reference' })
    const old = (await queue.prepareNotification(notice('old-notice')))!
    await queue.recordNotificationResult(old.notificationId, 'unconfirmed', 'Original queue ACK is unknown')
    await queue.append(message('independent-new'), { deliveryMode: 'reference' })
    const next = (await queue.prepareNotification(notice('new-opportunity')))!
    expect(next.messageIds).toEqual(['independent-new']); expect(next.key).not.toEqual(old.key)
    expect(next.wire).not.toContain('msg-id="old-unknown"')
    expect(await queue.readNotification(old.notificationId)).toEqual({ ...old, state: 'unconfirmed', reason: 'Original queue ACK is unknown' })
  })

  it('releases an automatic reference only after the exact original input is confirmed not-applied', async () => {
    const queue = await fixture()
    await queue.append(message('not-applied-original'), { deliveryMode: 'reference' })
    const original = (await queue.prepareNotification(notice('notice-not-applied')))!
    await queue.recordNotificationResult(original.notificationId, 'not-applied', 'Exact original native request was rejected')
    const retry = (await queue.prepareNotification(notice('fresh-authorized-opportunity')))!
    expect(retry.messageIds).toEqual(['not-applied-original']); expect(retry.key).not.toEqual(original.key)
    expect(await queue.readNotification(original.notificationId)).toEqual({ ...original, state: 'not-applied', reason: 'Exact original native request was rejected' })
  })

  it('preserves the frozen Run and rejects a reference set belonging to another recipient or Run', async () => {
    const queue = await fixture()
    await queue.append(message('original'), { deliveryMode: 'reference' })
    await queue.append(message('other-recipient', { recipientSessionId: 'other', recipient: { kind: 'agent-session', agentSessionId: 'other' } }), { deliveryMode: 'reference' })
    await queue.append(message('other-run', { recipientRunId: 'retired-run' }), { deliveryMode: 'reference' })
    for (const id of ['other-recipient', 'other-run']) await expect(queue.prepareNotification({ ...notice('bad-' + id), messageIds: [id] })).rejects.toMatchObject({ code: 'A2A_NOTIFICATION_CONFLICT' })
    const original = (await queue.prepareNotification(notice('frozen-target')))!
    expect(original.messageIds).toEqual(['original'])
    await expect(queue.prepareNotification({ ...notice('frozen-target'), condition: { ...condition, expectedRun: { runId: 'replacement-run' } } })).rejects.toMatchObject({ code: 'A2A_NOTIFICATION_CONFLICT' })
    expect(await queue.readNotification(original.notificationId)).toEqual(original)
    expect((await queue.readByMessageId('original'))?.envelope.recipientRunId).toBe('recipient-run')
  })

  it('does not promote an existing full-body message or frozen input to reference mode on retry', async () => {
    const queue = await fixture(), original = message('frozen-full-body')
    await queue.append(original)
    await queue.preparePrompt(original.messageId!, async () => condition)
    const before = await queue.readByMessageId(original.messageId!)
    await queue.append(original, { deliveryMode: 'reference' })
    expect(await queue.readByMessageId(original.messageId!)).toEqual(before)
    expect(await queue.pendingNotificationRecipients()).toEqual([])
    expect(await queue.prepareNotification(notice('must-not-rewrite-original'))).toBeNull()
    expect((await queue.readJournal()).map(record => record.kind)).toEqual(['message', 'prompt-condition'])
  })

  it('keeps a generation-fenced Inbox batch unchanged when notification succeeds and one original body is read', async () => {
    const queue = await fixture()
    for (const id of ['read-one', 'unread-two']) await queue.append(message(id), { deliveryMode: 'reference' })
    const request = { consumerId: 'recipient', readerRun: condition.expectedRun, limit: 2 }
    const batch = await queue.check(request, async () => {})
    const notification = (await queue.prepareNotification(notice('notice-batch')))!
    await queue.recordNotificationResult(notification.notificationId, 'submitted')
    const notifiedBatch = await queue.check(request, async () => {})
    expect(notifiedBatch.generation).toBe(batch.generation); expect(notifiedBatch.readerRun).toEqual(batch.readerRun)
    expect(notifiedBatch.messages.map(message => message.envelope)).toEqual(batch.messages.map(message => message.envelope))
    const beforeRead = await queue.readJournal()
    expect((await queue.readByMessageId('read-one'))?.envelope.body).toBe(message('read-one').body)
    expect(await queue.readJournal()).toEqual(beforeRead)
    expect(await queue.check(request, async () => {})).toEqual(notifiedBatch)
    const acknowledgement = await queue.ack({ consumerId: request.consumerId, readerRun: request.readerRun, generation: batch.generation }, async () => {})
    expect(acknowledgement.acknowledgedMessageIds).toEqual(['read-one', 'unread-two'])
    expect((await queue.readByMessageId('unread-two'))?.delivery.state).toBe('queued')
  })
})
