import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { messageObservationQuery } from '../src/agent-message-journal.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amux-notice-observation-')); roots.push(root)
  return new DurableAgentMuxMessageQueue(join(root, 'messages.sqlite'))
}
function message(id: string, recipient = 'recipient') {
  return { messageId: id, operationId: 'operation-' + id, createdAt: _tailFixtureEpoch(0, 0, 10),
    sender: { kind: 'agent-session' as const, agentSessionId: 'sender' }, recipient: { kind: 'agent-session' as const, agentSessionId: recipient },
    senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: recipient, recipientRunId: 'recipient-run',
    threadId: "thread", correlationId: "correlation", replyTo: null, workspaceId: null, body: 'Private original body ' + id }
}
const input = (notificationId: string) => ({ notificationId, agentSessionId: 'recipient',
  condition: { expectedRun: { runId: 'recipient-run' }, afterSubmissionId: null }, idle: { completionId: 'completion', inputByte: 0 } })

it('observes every original reference at an expanded notification sequence page boundary', async () => {
  const queue = await fixture()
  for (let index = 0; index < 100; index++) await queue.append(message('selected-' + index), { deliveryMode: 'reference' })
  const initial = await queue.messageChanges()
  const notice = (await queue.prepareNotification(input('original-notice')))!
  expect(notice.messageIds).toHaveLength(100)
  for (let index = 0; index < 99; index++) await queue.append(message('unrelated-' + index, 'other-recipient'))
  await queue.recordNotificationResult(notice.notificationId, 'submitted')
  const first = await queue.messageChanges(initial.cut)
  expect(first.hasMore).toBe(true)
  expect(first.changes.filter(change => change.messageId.startsWith('selected-'))).toHaveLength(100)
  expect(first.changes.filter(change => change.messageId.startsWith('unrelated-'))).toHaveLength(99)
  const next = await queue.messageChanges(first.cut)
  expect(next.hasMore).toBe(false)
  expect(next.changes.map(change => change.messageId).sort()).toEqual(notice.messageIds.slice().sort())
  expect(next.changes.every(change => change.sequence > first.cut.throughSequence)).toBe(true)
  expect((await queue.messageChanges(next.cut)).changes).toEqual([])
  const db = new DatabaseSync(queue.path, { readOnly: true })
  try {
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + messageObservationQuery).all(initial.cut.throughSequence, next.cut.throughSequence).map(row => String(row.detail))
    expect(plan).toContainEqual(expect.stringMatching(/SEARCH m USING INDEX .*\(message_id=\?\)/u))
    expect(plan).not.toContainEqual(expect.stringMatching(/SCAN (?:m|original|r|position)(?:$|\s)/u))
  } finally { db.close() }
}, 15_000)

it('bounds notification bytes without trimming valid original identities', async () => {
  const queue = await fixture()
  for (let index = 0; index < 100; index++) await queue.append(message('&'.repeat(480) + index), { deliveryMode: 'reference' })
  const first = (await queue.prepareNotification(input('first-bounded-notice')))!
  expect(Buffer.byteLength(first.wire)).toBeLessThanOrEqual(64 * 1024)
  expect(first.messageIds.length).toBeGreaterThan(1); expect(first.messageIds.length).toBeLessThan(100)
  await queue.recordNotificationResult(first.notificationId, 'submitted')
  const second = (await queue.prepareNotification(input('second-bounded-notice')))!
  expect(second.messageIds.some(id => first.messageIds.includes(id))).toBe(false)
  expect(second.messageIds[0]).toBe('&'.repeat(480) + first.messageIds.length)
}, 15_000)
