import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import { DeliveryAttemptStore } from '../src/delivery-attempt-store.js'
import { deliveryFailure, newDeliveryLogId, validateDeliveryLogId, type DeliveryAttempt } from '../src/delivery-attempt.js'
import { ContinuousProgressScheduler } from '../src/continuous-progress-scheduler.js'
import { openDemandStore } from '../../demand/src/demand-store.js'

const execute = promisify(execFile)
const roots: string[] = []
const canonical = /^[1-9A-HJ-NP-Za-km-z]{12}$/u
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'amux-object-ids-')); roots.push(root); return root
}

it('mints a durable message identity once and keeps original operation and explicit legacy identity', async () => {
  const path = join(await directory(), 'messages.ndjson'), queue = new DurableAgentMuxMessageQueue(path)
  const input = { operationId: 'unchanged-control-request', createdAt: 1,
    sender: { kind: 'agent-session' as const, agentSessionId: 'original-sender' },
    recipient: { kind: 'agent-session' as const, agentSessionId: 'original-recipient' },
    senderSessionId: 'original-sender', senderRunId: 'original-run', recipientSessionId: 'original-recipient', recipientRunId: null,
    threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: 'original body' }
  const first = await queue.append(input)
  expect(first.messageId).toMatch(canonical)
  expect(first.envelope.operationId).toBe(input.operationId)
  const reopened = new DurableAgentMuxMessageQueue(path)
  expect((await reopened.append({ ...input, messageId: first.messageId })).messageId).toBe(first.messageId)
  const legacyId = '765ae7ef-b886-4681-b9b5-0bbc561e8f1a'
  const legacy = await reopened.append({ ...input, operationId: 'legacy-operation', messageId: legacyId })
  expect(legacy.messageId).toBe(legacyId)
  expect((await new DurableAgentMuxMessageQueue(path).readByOperationId('legacy-operation'))?.envelope.messageId).toBe(legacyId)
})

it('persists and reads new and legacy delivery IDs without weakening path qualification or dropping nested IDs', async () => {
  const root = await directory(), logId = newDeliveryLogId()
  expect(logId).toMatch(canonical)
  const legacyId = 'delivery-765ae7ef-b886-4681-b9b5-0bbc561e8f1a'
  for (const id of [logId, legacyId]) {
    await expect(Promise.resolve().then(() => validateDeliveryLogId(id))).resolves.toBe(id)
    expect(deliveryFailure({ name: 'Error', message: 'original failure', logId: id }).logId).toBe(id)
    const record: DeliveryAttempt = { logId: id, source: 'core', agentSessionId: 'original-session', operationId: 'original-operation',
      hostId: 'local', expectedRunId: 'original-run', afterSubmissionId: null, conditionAvailable: false, promptDigest: null,
      execution: null, startedAt: 1, failedAt: 2, stage: 'input', error: { name: 'Error', message: 'original failure' } }
    expect((await new DeliveryAttemptStore(root).record(record)).record).toEqual(record)
    expect((await new DeliveryAttemptStore(root).read(id)).record).toEqual(record)
  }
  for (const id of ['../outside', fixturePath("absolute"), 'delivery-../../outside', 'O00000000000', logId + '.json']) {
    expect(() => validateDeliveryLogId(id)).toThrowError(expect.objectContaining({ code: 'INVALID_CONTROL_REQUEST' }))
    expect(deliveryFailure({ logId: id }).logId).toBeUndefined()
  }
})

it('allocates loop and tick product identities while restoring exact preexisting loop records', () => {
  let now = 100
  const clock = new ContinuousProgressScheduler({ now: () => now })
  const loop = clock.create({ hostId: 'local', agentSessionId: 'original-session', providerId: 'codex', workspacePath: fixturePath("private"), intervalMs: 10, prompt: 'Continue', operationId: 'original-operation' })
  expect(loop.loopId).toMatch(canonical)
  expect(loop.creationOperationId).toBe('original-operation')
  now = 110
  const tick = clock.claimTick(loop.loopId)!
  expect(tick.tickId).toMatch(canonical)
  expect(tick.tickId).not.toBe(loop.loopId)
  const restored = new ContinuousProgressScheduler({ now: () => now })
  const legacy = { ...loop, loopId: 'original-legacy-loop' }
  restored.restore([legacy])
  expect(restored.list()).toEqual([legacy])
  expect(restored.claimTick(legacy.loopId)!.tickId).toMatch(canonical)
})

it('creates and reopens Goal, activity, decision and submission IDs through the durable Demand owner and compiled CLI', async () => {
  const root = await directory(), store = openDemandStore({ root })
  const created = await store.create({ title: 'Preserve identities' }), id = created.demand.id
  expect(id).toMatch(canonical)
  expect(created.operationId).not.toMatch(canonical)
  await store.addActivity(id, { kind: 'note', message: 'original note', actorId: null })
  await store.addDecision(id, { question: 'Which owner?', decision: 'Original store', rationale: 'One fact', actorId: null })
  await store.proposeAlignment(id, { summary: 'Keep original facts', criteria: [{ id: 'explicit-criterion', text: 'Read original IDs' }], openQuestions: [] })
  await store.confirmAlignment(id, 1)
  const grounded = await store.proposeGrounding(id, { alignmentRevision: 1, summary: 'Original records read', checks: [{ criterionId: 'explicit-criterion', outcome: 'met', evidence: ['verification.log'], note: '' }] })
  expect(grounded.demand.grounding!.submissionId).toMatch(canonical)
  await store.acceptGrounding(id, 1, grounded.demand.grounding!.submissionId)
  await store.update(id, { title: 'Same identity, new name' })
  const saved = (await openDemandStore({ root }).get(id))!
  expect(saved.activities.length).toBeGreaterThanOrEqual(4)
  for (const activity of saved.activities) expect(activity.id).toMatch(canonical)
  expect(saved.decisions[0]!.id).toMatch(canonical)
  const legacyId = 'demand_765ae7ef-b886-4681-b9b5-0bbc561e8f1a'
  await store.create({ id: legacyId, title: 'Original durable goal' })
  await store.addActivity(legacyId, { id: 'activity_original', kind: 'note', message: 'Original', actorId: null })
  expect((await openDemandStore({ root }).get(legacyId))!.activities[0]!.id).toBe('activity_original')
  const cli = new URL('../../demand/dist/bin/agentmux-demand.js', import.meta.url).pathname
  for (const exactId of [id, legacyId]) {
    const output = await execute(process.execPath, [cli, '--root', root, 'show', '--id', exactId])
    expect(JSON.parse(output.stdout).demand.id).toBe(exactId)
  }
}, 30_000)
