import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DurableAgentMuxMessageQueue } from '../src/agent-global-message-queue.js'
import type { AgentMuxMessageNotification } from '../src/agent-message-notification.js'
import { MoteInputOwner, type AutomaticInputOpportunity } from '../src/mote-input-owner.js'
import { moteInputObservationId, type MoteInputObservation } from '../src/mote-input.js'

// Opportunity-policy proof only: the production owner, journal and codecs are real.
// The source and native admission ports are finite fixtures, not a live Provider/E2E.
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function settle(owner: MoteInputOwner): Promise<void> {
  // changed() intentionally returns void. Await its actual jobs rather than a time delay,
  // so a missing event or an early-disposed owner cannot make the negative assertions pass.
  for (let pass = 0; pass < 10; pass++) {
    const jobs = Reflect.get(owner, 'jobs') as Map<string, { promise: Promise<void> }>
    if (!jobs.size) return
    await Promise.all([...jobs.values()].map((job) => job.promise))
  }
  throw new Error('The original opportunity reconciliation did not settle.')
}

async function fixture(firstOutcome: 'not-applied' | 'unconfirmed') {
  const root = await mkdtemp(join(tmpdir(), 'mote-opportunity-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const queue = new DurableAgentMuxMessageQueue(join(root, 'messages.jsonl'))
  const source = { spaceId: 'mote', zoneId: 'mote-zone', tabId: 'member-tab', regionId: 'member-region' }
  const origin = {
    kind: 'interaction' as const,
    agentSessionId: 'member',
    runId: 'member-original-run',
    operationId: 'original-permission-response'
  }
  const id = moteInputObservationId(origin)
  const result = {
    kind: 'interaction' as const,
    requestId: 'original-permission',
    responseKind: 'permission' as const,
    delivery: 'hook-written',
    nativeAdoption: 'unknown' as const,
    nativeCompleted: false,
    decision: 'allow-once'
  }
  const observation: MoteInputObservation = {
    id,
    revision: 1,
    origin,
    source,
    binding: {
      source,
      primary: { hostId: 'local', agentSessionId: 'primary' },
      moteRevision: 'original-mote-revision',
      spatialRevision: 1
    },
    sourceStatus: 'confirmed',
    issue: null,
    input: 'interaction-confirmed',
    result,
    notices: {}
  }
  // Start from a confirmed original observation. Source capture and its input budget
  // are outside this test's opportunity-policy boundary.
  await queue.saveMoteInputObservation(observation, 0)
  let runId = 'primary-original-run', idleId = 'native-idle-original'
  const writes: AgentMuxMessageNotification[] = []
  const issues: string[] = []
  const unexpected = async (): Promise<never> => { throw new Error('A result-history port was unexpectedly read.') }
  const opportunity = vi.fn(async (primary: string): Promise<AutomaticInputOpportunity> => {
    expect(primary).toBe('primary')
    return {
      session: {
        kind: 'agent',
        agentSessionId: 'primary',
        hostId: 'local',
        workspacePath: root,
        providerId: 'codex',
        executorId: 'codex',
        run: { runId },
        retiredRuns: [],
        createdAt: 1,
        updatedAt: 1
      },
      inputByte: 0,
      nativeIdle: { state: 'idle', sourceId: 'retained-native-source', id: idleId }
    }
  })
  const owner = new MoteInputOwner({
    queue,
    readSource: async () => ({ input: 'interaction-confirmed', text: null, result }),
    sourceExists: async () => true,
    checkpoint: unexpected,
    changes: unexpected,
    original: unexpected,
    watch: unexpected,
    release: unexpected,
    opportunity,
    submit: async (notice) => {
      // Match the delivery owner's no-replay rule: a retained unknown or terminal
      // attempt can be inspected, but is not another native admission.
      if (notice.state !== 'pending') return
      writes.push(structuredClone(notice))
      await queue.recordNotificationResult(
        notice.notificationId,
        writes.length === 1 ? firstOutcome : 'submitted',
        writes.length === 1 ? 'Finite native admission fixture outcome.' : undefined
      )
    },
    inspectNotice: async (notificationId) => ({ notification: await queue.readNotification(notificationId) }),
    issue: (_member, message) => issues.push(message)
  })
  cleanup.push(() => owner.dispose())
  const restore = async () => { await owner.restore(); await settle(owner) }
  const change = async () => { owner.changed('primary'); await settle(owner) }
  await restore()
  expect(writes).toHaveLength(1)
  expect(issues).toEqual([])
  return {
    owner,
    queue,
    id,
    writes,
    issues,
    opportunity,
    change,
    restore,
    setRun: (value: string) => { runId = value },
    setIdle: (value: string) => { idleId = value }
  }
}

it('a recovered Run is a new opportunity even with the same native idle evidence and input byte', async () => {
  const f = await fixture('not-applied')
  const first = f.writes[0]!
  expect(await f.queue.readNotification(first.notificationId)).toMatchObject({ state: 'not-applied' })
  f.setRun('primary-recovered-run')
  await f.change()
  expect(f.writes).toHaveLength(2)
  const next = f.writes[1]!
  expect(next.notificationId).not.toBe(first.notificationId)
  expect(next.key.expectedRun).toEqual({ runId: 'primary-recovered-run' })
  expect(next.idle).toEqual(first.idle)
  expect(next.moteObservation).toEqual(first.moteObservation)
  expect(await f.queue.readNotification(first.notificationId)).toMatchObject({
    state: 'not-applied', key: first.key, wire: first.wire
  })
  expect(await f.queue.readNotification(next.notificationId)).toMatchObject({ state: 'submitted' })
  await f.change()
  await f.restore()
  expect(f.writes).toHaveLength(2)
  expect(f.issues).toEqual([])
})

it('the same Run and idle opportunity cannot retry a refused notice, including after owner restore', async () => {
  const f = await fixture('not-applied')
  const readCount = f.opportunity.mock.calls.length
  await f.change()
  await f.restore()
  expect(f.opportunity.mock.calls.length).toBeGreaterThan(readCount)
  expect(f.writes).toHaveLength(1)
  expect((await f.queue.readMoteInputObservation(f.id))?.notices.result).toBe(f.writes[0]!.notificationId)
  // A different authoritative idle on that same Run is a real opportunity.
  f.setIdle('native-idle-next')
  await f.change()
  expect(f.writes).toHaveLength(2)
  expect(f.writes[1]!.key.expectedRun).toEqual(f.writes[0]!.key.expectedRun)
  expect(f.writes[1]!.idle).not.toEqual(f.writes[0]!.idle)
  expect(f.issues).toEqual([])
})

it('an unknown notice keeps its original attempt across later idle evidence and a recovered Run', async () => {
  const f = await fixture('unconfirmed')
  const first = f.writes[0]!
  f.setIdle('native-idle-next')
  await f.change()
  f.setRun('primary-recovered-run')
  await f.restore()
  await f.owner.revisit(f.id)
  await settle(f.owner)
  await f.change()
  expect(f.writes).toHaveLength(1)
  expect((await f.queue.readMoteInputObservation(f.id))?.notices.result).toBe(first.notificationId)
  expect(await f.queue.readNotification(first.notificationId)).toMatchObject({
    state: 'unconfirmed', key: first.key, wire: first.wire
  })
  expect(f.issues).toEqual([])
})
