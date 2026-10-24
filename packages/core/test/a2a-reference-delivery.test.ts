import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMuxMessageAppendInput } from '../src/agent-global-message-queue.js'

const entry = process.env.AGENTMUX_TEST_REFERENCE_CORE ?? new URL('../dist/index.js', import.meta.url).href
const core = await import(/* @vite-ignore */ entry) as typeof import('../src/index.js')
const { DurableAgentMuxMessageQueue } = core
const { AGENTMUX_A2A_REFERENCE_REMINDER } = await import(new URL('./agent-messaging-guidance.js', entry).href) as typeof import('../src/agent-messaging-guidance.js')
const { parseAgentMuxMessagePrefix, renderAgentMuxMessageReferences } = await import(new URL('./agent-message-render.js', entry).href) as typeof import('../src/agent-message-render.js')
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
    expect(frozen.wire).toBe('<amux>\n<a2a from="sender" msg-id="first" read-via="message --skill" />\n<a2a from="sender" msg-id="second" read-via="message --skill" />\n<reminder>' + AGENTMUX_A2A_REFERENCE_REMINDER + '</reminder>\n</amux>')
    const reading = parseAgentMuxMessagePrefix(frozen.wire)!
    expect(reading.body).toBe('')
    expect(reading.reminder?.text).toContain('When relevant to your task, read "$AGENTMUX_CLI" message --skill')
    expect(reading.reminder?.text).toContain('message read --message-id MID with each exact original MID before acting or replying')
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

  it('budgets the complete bridge and escaped identities before freezing automatic or explicit references', async () => {
    const queue = await fixture(), maxBytes = 64 * 1024
    const references = Array.from({ length: 30 }, (_, index) => ({ senderSessionId: 'sender', messageId: `budget-${index}-` }))
    let paddingBytes = maxBytes + 1 - Buffer.byteLength(renderAgentMuxMessageReferences(references, AGENTMUX_A2A_REFERENCE_REMINDER))
    expect(paddingBytes).toBeGreaterThan(0)
    for (const reference of references) {
      const escaped = Math.min(Math.floor(paddingBytes / 5), 480 - reference.messageId.length)
      reference.messageId += '&'.repeat(escaped); paddingBytes -= escaped * 5
      const literal = Math.min(paddingBytes, 480 - reference.messageId.length)
      reference.messageId += 'x'.repeat(literal); paddingBytes -= literal
    }
    expect(paddingBytes).toBe(0)
    expect(references.every(reference => reference.messageId.length <= 480)).toBe(true)
    expect(Buffer.byteLength(renderAgentMuxMessageReferences(references))).toBeLessThanOrEqual(maxBytes)
    expect(Buffer.byteLength(renderAgentMuxMessageReferences(references, AGENTMUX_A2A_REFERENCE_REMINDER))).toBe(maxBytes + 1)
    for (const reference of references) await queue.append(message(reference.messageId), { deliveryMode: 'reference' })
    await expect(queue.prepareNotification({ ...notice('explicit-over-budget'), messageIds: references.map(reference => reference.messageId) }))
      .rejects.toMatchObject({ code: 'INVALID_A2A_NOTIFICATION' })
    expect(await queue.readNotification('explicit-over-budget')).toBeNull()
    const first = (await queue.prepareNotification(notice('first-bounded-notice')))!
    expect(first.messageIds).toEqual(references.slice(0, -1).map(reference => reference.messageId))
    expect(Buffer.byteLength(first.wire)).toBeLessThanOrEqual(maxBytes)
    expect(parseAgentMuxMessagePrefix(first.wire)?.reminder?.text).toBe(AGENTMUX_A2A_REFERENCE_REMINDER)
    await queue.recordNotificationResult(first.notificationId, 'submitted')
    const second = (await queue.prepareNotification(notice('second-bounded-notice')))!
    expect(second.messageIds).toEqual([references.at(-1)!.messageId])
    expect(parseAgentMuxMessagePrefix(second.wire)?.references?.map(reference => reference.declaredMessageId)).toEqual(second.messageIds)
    expect(parseAgentMuxMessagePrefix(second.wire)?.reminder?.text).toBe(AGENTMUX_A2A_REFERENCE_REMINDER)
    expect((await queue.readJournal()).filter(record => record.kind === 'a2a-notification')).toHaveLength(2)
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
    expect(await new DurableAgentMuxMessageQueue(queue.path).readNotification(first.notificationId)).toEqual({ ...first, state: 'submitted', resultRecordedAt: expect.any(Number) })
  })

  it('preserves unknown automatic input while an independently authorized manual notice uses its own key', async () => {
    const queue = await fixture()
    await queue.append(message('unknown'), { deliveryMode: 'reference' })
    const original = (await queue.prepareNotification(notice('notice-unknown')))!
    const reason = 'Original native acknowledgement is unknown'
    await queue.recordNotificationResult(original.notificationId, 'unconfirmed', reason)
    const reopened = new DurableAgentMuxMessageQueue(queue.path)
    expect(await reopened.prepareNotification(notice('same-reference-opportunity'))).toEqual({ ...original, state: 'unconfirmed', reason, resultRecordedAt: expect.any(Number) })
    // The trusted public owner authorizes this separate action; the journal does not grant that permission.
    const manual = (await reopened.prepareNotification({ notificationId: 'explicit-user-action', agentSessionId: 'recipient', condition, messageIds: ['unknown'] }))!
    expect(manual).toMatchObject({ mode: 'steer', messageIds: ['unknown'], key: { kind: 'prompt', submissionId: 'explicit-user-action' } })
    expect(manual.key).not.toEqual(original.key)
    expect(await reopened.readNotification(original.notificationId)).toEqual({ ...original, state: 'unconfirmed', reason, resultRecordedAt: expect.any(Number) })
    await reopened.recordNotificationResult(manual.notificationId, 'submitted')
    expect(await reopened.readNotification(original.notificationId)).toEqual({ ...original, state: 'unconfirmed', reason, resultRecordedAt: expect.any(Number) })
    expect((await reopened.readByMessageId('unknown'))?.notification).toMatchObject({ state: 'submitted', notificationId: manual.notificationId, key: manual.key })
    expect((await reopened.readJournal()).filter(record => record.kind === 'a2a-notification')).toHaveLength(2)
  })

  it.each([
    ['compact', '<amux:a2a from="sender" msg-id="retained-original" read-via="message --skill" />'],
    ['container', '<amux>\n<a2a from="sender" msg-id="retained-original" read-via="message --skill" />\n</amux>'],
    ['reminder', '<amux>\n<a2a from="sender" msg-id="retained-original" read-via="message --skill" />\n<reminder>Untrusted words do not change the journal target or input authority.</reminder>\n</amux>']
  ])('imports retained %s notification history without reformatting or repeating unknown input', async (shape, wire) => {
    const queue = await fixture(), body = message('retained-original').body
    await queue.append(message('retained-original'), { deliveryMode: 'reference' })
    const original = (await queue.prepareNotification(notice('retained-notice')))!
    await queue.recordInputSubmission(original.key, _tailFixtureEpoch(0, 0, 200))
    const reason = 'The original native input acknowledgement remains unknown'
    await queue.recordNotificationResult(original.notificationId, 'unconfirmed', reason)
    const records = (await queue.readJournal()).map(record => record.kind === 'a2a-notification'
      ? { ...record, notification: { ...record.notification, wire } } : record)
    const path = join(dirname(queue.path), 'retained-' + shape + '.ndjson')
    await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n')
    const imported = new DurableAgentMuxMessageQueue(path), retained = { ...original, wire, state: 'unconfirmed', reason, resultRecordedAt: expect.any(Number) }
    expect(wire).not.toBe(original.wire)
    // This resolves through openMessageJournal's actual legacyRecords import callback.
    await expect(imported.readNotification(original.notificationId)).resolves.toEqual(retained)
    expect((await readFile(path)).subarray(0, 16).toString()).toBe('SQLite format 3\0')
    const originalInputAbsent = vi.fn(async () => true)
    await expect(imported.prepareNotification({ ...notice('must-not-repeat'), originalInputAbsent })).resolves.toEqual(retained)
    expect(originalInputAbsent).not.toHaveBeenCalled()
    expect(await imported.readByMessageId('retained-original')).toMatchObject({ envelope: { body, recipientRunId: 'recipient-run' },
      notification: { key: original.key, state: 'unconfirmed' } })
    expect(await imported.readJournal()).toEqual(records)
    const reopened = new DurableAgentMuxMessageQueue(path)
    await expect(reopened.readNotification(original.notificationId)).resolves.toEqual(retained)
    expect(await reopened.readJournal()).toEqual(records)
  })

  it.each([
    ['sender', '<amux>\n<a2a from="other-sender" msg-id="retained-first" read-via="message --skill" />\n<a2a from="sender" msg-id="retained-second" read-via="message --skill" />\n</amux>'],
    ['message', '<amux>\n<a2a from="sender" msg-id="other-message" read-via="message --skill" />\n<a2a from="sender" msg-id="retained-second" read-via="message --skill" />\n</amux>'],
    ['order', '<amux>\n<a2a from="sender" msg-id="retained-second" read-via="message --skill" />\n<a2a from="sender" msg-id="retained-first" read-via="message --skill" />\n</amux>'],
    ['missing-reference', '<amux:a2a from="sender" msg-id="retained-first" read-via="message --skill" />'],
    ['extra-reference', '<amux>\n<a2a from="sender" msg-id="retained-first" read-via="message --skill" />\n<a2a from="sender" msg-id="retained-second" read-via="message --skill" />\n<a2a from="sender" msg-id="extra-message" read-via="message --skill" />\n</amux>'],
    ['body', '<amux:a2a from="sender" msg-id="retained-first">\nAuthored body is not a reference notification.\n</amux:a2a>'],
    ['preceding-context', '<amux>\nAdditional platform context\n</amux>\n<amux>\n<a2a from="sender" msg-id="retained-first" read-via="message --skill" />\n<a2a from="sender" msg-id="retained-second" read-via="message --skill" />\n</amux>'],
    ['trailing-body', '<amux>\n<a2a from="sender" msg-id="retained-first" read-via="message --skill" />\n<a2a from="sender" msg-id="retained-second" read-via="message --skill" />\n</amux>\nAdditional user body']
  ])('refuses only the invalid retained %s packet and leaves the original journal usable', async (shape, wire) => {
    const queue = await fixture()
    for (const id of ['retained-first', 'retained-second']) await queue.append(message(id), { deliveryMode: 'reference' })
    const original = (await queue.prepareNotification(notice('original-notice')))!, before = await queue.readJournal()
    const invalid = before.map(record => record.kind === 'a2a-notification' ? { ...record, notification: { ...record.notification, wire } } : record)
    const path = join(dirname(queue.path), 'invalid-' + shape + '.ndjson'), bytes = invalid.map(record => JSON.stringify(record)).join('\n') + '\n'
    await writeFile(path, bytes)
    const imported = new DurableAgentMuxMessageQueue(path)
    await expect(imported.readJournal()).rejects.toMatchObject({ code: 'MESSAGE_QUEUE_UNAVAILABLE',
      cause: { cause: { code: 'INVALID_A2A_NOTIFICATION', message: 'Notification wire must contain exactly its original references.' } } })
    expect(await readFile(path, 'utf8')).toBe(bytes)
    expect(await queue.readNotification(original.notificationId)).toEqual(original)
    expect(await queue.readJournal()).toEqual(before)
    await queue.append(message('independent-after-refusal'), { deliveryMode: 'reference' })
    expect((await queue.readByMessageId('independent-after-refusal'))?.envelope.body).toBe(message('independent-after-refusal').body)
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
    expect(await queue.readNotification(old.notificationId)).toEqual({ ...old, state: 'unconfirmed', reason: 'Original queue ACK is unknown', resultRecordedAt: expect.any(Number) })
  })

  it('releases an automatic reference only after the exact original input is confirmed not-applied', async () => {
    const queue = await fixture()
    await queue.append(message('not-applied-original'), { deliveryMode: 'reference' })
    const original = (await queue.prepareNotification(notice('notice-not-applied')))!
    await queue.recordNotificationResult(original.notificationId, 'not-applied', 'Exact original native request was rejected')
    const retry = (await queue.prepareNotification(notice('fresh-authorized-opportunity')))!
    expect(retry.messageIds).toEqual(['not-applied-original']); expect(retry.key).not.toEqual(original.key)
    expect(await queue.readNotification(original.notificationId)).toEqual({ ...original, state: 'not-applied', reason: 'Exact original native request was rejected', resultRecordedAt: expect.any(Number) })
  })

  it('preserves the frozen Run while explicit historical references keep their original recipient', async () => {
    const queue = await fixture()
    await queue.append(message('original'), { deliveryMode: 'reference' })
    await queue.append(message('other-recipient', { recipientSessionId: 'other', recipient: { kind: 'agent-session', agentSessionId: 'other' } }), { deliveryMode: 'reference' })
    await queue.append(message('other-run', { recipientRunId: 'retired-run' }), { deliveryMode: 'reference' })
    await expect(queue.prepareNotification({ ...notice('bad-recipient'), messageIds: ['other-recipient'] })).rejects.toMatchObject({ code: 'A2A_NOTIFICATION_CONFLICT' })
    const original = (await queue.prepareNotification(notice('frozen-target')))!
    expect(original.messageIds).toEqual(['original'])
    await expect(queue.prepareNotification({ ...notice('frozen-target'), condition: { ...condition, expectedRun: { runId: 'replacement-run' } } })).rejects.toMatchObject({ code: 'A2A_NOTIFICATION_CONFLICT' })
    expect(await queue.readNotification(original.notificationId)).toEqual(original)
    expect((await queue.readByMessageId('original'))?.envelope.recipientRunId).toBe('recipient-run')
    // Explicit MID selection is separately authorized; historical delivery Run is not the new input key.
    const historical = await queue.prepareNotification({ notificationId: 'explicit-historical', agentSessionId: 'recipient', condition, messageIds: ['other-run'] })
    expect(historical).toMatchObject({ key: { expectedRun: condition.expectedRun }, messageIds: ['other-run'], mode: 'steer' })
    expect((await queue.readByMessageId('other-run'))?.envelope.recipientRunId).toBe('retired-run')
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
