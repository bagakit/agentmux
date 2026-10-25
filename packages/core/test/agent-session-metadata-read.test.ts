import { afterEach, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxFileAgentSessionStore, agentLifecycleOperationIdentity, type AgentMuxLifecycleReservation } from '../src/agent-session-store.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession, AgentNativePromptInputPlan, AgentPromptSubmissionRecord } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const plan: AgentNativePromptInputPlan = { kind: 'native-rpc', protocolId: 'controlled-native-contract', operation: 'start-or-steer',
  sourceId: 'original-source', actorId: 'original-peer', threadId: 'original-thread' }

async function fixture() {
  const h = await rpcOwnerFixture(['reader', 'writer'])
  const original = (await h.store.readMetadata('reader'))!
  const key = { kind: 'prompt' as const, agentSessionId: original.agentSessionId, expectedRun: original.run, submissionId: 'original-input' }
  const session: AgentMuxStoredAgentSession = { ...original,
    nativeHandle: { kind: 'provider', providerId: original.providerId, sessionId: 'original-native' }, promptCompletionAdmission: {
    transport: 'native', operationId: key.submissionId, submissionId: key.submissionId, inputKey: key,
    native: { plan, outcome: 'unknown' }, intent: { run: original.run, ownerInstanceId: 'original-runtime',
      prompt: 'Original input', plan, execution: 'immediate', message: { userContent: 'Original input', authorHuman: true } }
  } }
  await h.store.compareAndSwapMetadata(original, session)
  const receipt = (await h.store.readPromptAdmission(session.agentSessionId, session.run, key.submissionId))!
  return { ...h, session, receipt, key }
}

type StoreOwner = {
  commit(signal?: AbortSignal): Promise<void>
  database: DatabaseSync | undefined
  sessionWriteTails: Map<string, Promise<void>>
  sessionMetadata(db: DatabaseSync, id: string): AgentMuxStoredAgentSession | null
  promptAdmission(db: DatabaseSync, id: string, run: { runId: string }, submissionId: string): AgentPromptSubmissionRecord | null
}
function pauseCommits(store: AgentMuxFileAgentSessionStore, count = 1, failure?: 'before' | 'after') {
  const gates = Array.from({ length: count }, () => ({ entered: deferred(), release: deferred() }))
  const owner = store as unknown as StoreOwner
  const original = owner.commit.bind(owner)
  let next = 0
  vi.spyOn(owner, 'commit').mockImplementation(async signal => {
    const gate = gates[next++]
    if (gate) { gate.entered.resolve(); await gate.release.promise }
    if (gate && failure === 'before') throw new Error('Private commit rejected')
    await original(signal)
    if (gate && failure === 'after') throw new Error('Private commit ACK lost')
  })
  return gates.map(gate => ({ entered: gate.entered.promise, release: gate.release.resolve }))
}

it.each(['metadata', 'lifecycle-reservation'] as const)('Core exact metadata and original input reads finish before an unrelated %s writer', async kind => {
  const h = await fixture(), writer = (await h.store.readMetadata('writer'))!, [pause] = pauseCommits(h.store)
  const pending: Promise<unknown>[] = []
  try {
    const writing = kind === 'metadata' ? h.store.compareAndSwapMetadata(writer, { ...writer, updatedAt: writer.updatedAt + 1 })
      : h.store.reserveLifecycle({ kind: 'resume', agentSessionId: writer.agentSessionId, expectedRun: writer.run,
        reservationId: 'unrelated-reservation', operationId: 'unrelated-resume', ownerId: 'unrelated-owner',
        ownerPid: process.pid, expiresAt: Date.now() + 60_000 })
    pending.push(writing); await pause!.entered
    const owner = h.store as unknown as StoreOwner, writerDb = owner.database!
    expect(writerDb.isTransaction).toBe(true)
    const metadataConnections: DatabaseSync[] = [], receiptConnections: DatabaseSync[] = []
    const metadataRead = owner.sessionMetadata.bind(owner), receiptRead = owner.promptAdmission.bind(owner)
    vi.spyOn(owner, 'sessionMetadata').mockImplementation((db, id) => {
      if (id === h.session.agentSessionId) metadataConnections.push(db)
      return metadataRead(db, id)
    })
    vi.spyOn(owner, 'promptAdmission').mockImplementation((db, id, run, submissionId) => {
      if (id === h.session.agentSessionId) receiptConnections.push(db)
      return receiptRead(db, id, run, submissionId)
    })
    let metadata: AgentMuxAgentSession | undefined, receipt: typeof h.receipt | null | undefined
    pending.push(h.client.refreshAgentSession(h.session.agentSessionId, h.session.run).then(value => { metadata = value }))
    pending.push(h.client.inspectAgentPromptSubmission(h.key).then(value => { receipt = value }))
    await vi.waitFor(() => {
      expect(metadata?.run).toEqual(h.session.run)
      expect(receipt).toEqual(h.receipt)
    }, { timeout: 1000, interval: 10 })
    for (const connections of [metadataConnections, receiptConnections]) {
      expect(connections.length).toBeGreaterThan(0)
      expect(connections.every(db => db !== writerDb), 'A public read must own a committed connection').toBe(true)
    }
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally {
    pause!.release(); await Promise.allSettled(pending); await h.close()
  }
})

function restartReservation(session: AgentMuxStoredAgentSession): Extract<AgentMuxLifecycleReservation, { kind: 'resume' }> {
  if (session.nativeHandle?.kind !== 'provider') throw new Error('Fixture requires its native target')
  const request = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'original-restart' }
  return { kind: 'resume', agentSessionId: session.agentSessionId, expectedRun: session.run,
    reservationId: 'original-reservation', operationId: agentLifecycleOperationIdentity('restart', session.agentSessionId, request.operationId),
    ownerId: 'original-owner', ownerPid: process.pid, expiresAt: Date.now() + 60_000,
    restart: { requestDigest: 'original-request-digest', request, nativeTarget: session.nativeHandle,
      stopOperation: { daemonInstance: 'fixture-runtime', operationKey: 'original-stop', runId: session.run.runId } } }
}

const writers = ['metadata-cas', 'complete-cas', 'durability', 'receipt', 'reserve-restart', 'restart-admission', 'lifecycle-commit'] as const
it.each(writers)('waits for the earlier same-Session %s writer and reads its committed facts', async kind => {
  const h = await fixture(), pending: Promise<unknown>[] = []
  let release = () => {}
  try {
    let current = h.session, expected = current, receipt = h.receipt
    const reservation = restartReservation(current)
    if (kind === 'restart-admission') {
      await h.store.reserveLifecycle(reservation)
      current = (await h.store.readMetadata(current.agentSessionId))!
    }
    const { restart: _restart, ...resumeFacts } = reservation
    const resume: AgentMuxLifecycleReservation = { ...resumeFacts, operationId: 'original-resume' }
    if (kind === 'lifecycle-commit') await h.store.reserveLifecycle(resume)
    const [pause] = pauseCommits(h.store); release = pause!.release
    let writing: Promise<unknown>
    if (kind === 'metadata-cas' || kind === 'complete-cas') {
      expected = { ...current, run: { runId: 'replacement-run' }, retiredRuns: [current.run], updatedAt: current.updatedAt + 1 }
      writing = kind === 'metadata-cas' ? h.store.compareAndSwapMetadata(current, expected) : h.store.compareAndSwap(current, expected)
    } else if (kind === 'durability') writing = h.store.confirmDurability(current.agentSessionId, current.run, current)
    else if (kind === 'receipt') {
      if (receipt.admission?.transport !== 'native') throw new Error('Fixture requires Native history')
      receipt = { ...receipt, admission: { ...receipt.admission, acknowledged: true, native: { plan, outcome: 'admitted' as const, turnId: 'original-turn' } } }
      writing = h.store.settlePromptAdmission(h.receipt, receipt)
    } else if (kind === 'reserve-restart') writing = h.store.reserveLifecycle(reservation)
    else if (kind === 'restart-admission') writing = h.store.recordRestartAdmission(reservation)
    else {
      expected = { ...current, run: { runId: 'resumed-run' }, retiredRuns: [current.run], updatedAt: current.updatedAt + 1 }
      writing = h.store.commitLifecycle(resume, expected)
    }
    pending.push(writing); await pause!.entered
    let metadataDone = false, receiptDone = false
    const metadataRead = h.store.readMetadata(current.agentSessionId).then(value => { metadataDone = true; return value })
    const receiptRead = h.client.inspectAgentPromptSubmission(h.key).then(value => { receiptDone = true; return value })
    pending.push(metadataRead, receiptRead)
    expect((await h.store.readMetadata('writer'))?.agentSessionId).toBe('writer')
    // Give an incorrectly ungated asynchronous reader time to return its old value.
    await delay(30)
    expect([metadataDone, receiptDone]).toEqual([false, false])
    release(); await writing
    const actual = await metadataRead
    expect(actual?.run).toEqual(expected.run)
    expect(await receiptRead).toEqual(receipt)
    if (kind === 'reserve-restart' || kind === 'restart-admission') {
      expect(actual?.continuityOperations?.['original-restart']).toMatchObject({ action: 'restart', previousRun: current.run })
    }
    expect((h.store as unknown as StoreOwner).sessionWriteTails.size).toBe(0)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { release(); await Promise.allSettled(pending); await h.close() }
})

it.each(['before', 'after'] as const)('releases exact readers after a failed %s-COMMIT acknowledgement without inventing an input outcome', async failure => {
  const h = await fixture(), [pause] = pauseCommits(h.store, 1, failure), pending: Promise<unknown>[] = []
  const next = { ...h.session, updatedAt: h.session.updatedAt + 1 }
  try {
    const writing = h.store.compareAndSwapMetadata(h.session, next).then(() => null, error => error)
    pending.push(writing); await pause!.entered
    const metadata = h.store.readMetadata(h.session.agentSessionId), receipt = h.client.inspectAgentPromptSubmission(h.key)
    pending.push(metadata, receipt); pause!.release()
    expect(await writing).toBeInstanceOf(Error)
    if (failure === 'after') expect(await writing).toMatchObject({ code: 'AGENT_SESSION_STORE_DURABILITY_UNCONFIRMED', commitOutcome: 'unknown' })
    expect(await metadata).toEqual(failure === 'before' ? h.session : next)
    expect(await receipt).toEqual(h.receipt)
    expect((await receipt)?.admission?.native?.outcome).toBe('unknown')
    expect((h.store as unknown as StoreOwner).sessionWriteTails.size).toBe(0)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { pause!.release(); await Promise.allSettled(pending); await h.close() }
})

it('an earlier settlement cannot remove a later same-Session writer from the read barrier', async () => {
  const h = await fixture(), pauses = pauseCommits(h.store, 2), pending: Promise<unknown>[] = []
  const next = { ...h.session, updatedAt: h.session.updatedAt + 1 }, final = { ...next, updatedAt: next.updatedAt + 1 }
  try {
    const first = h.store.compareAndSwapMetadata(h.session, next); pending.push(first); await pauses[0]!.entered
    const second = h.store.compareAndSwapMetadata(next, final); pending.push(second)
    pauses[0]!.release(); await first; await pauses[1]!.entered
    let returned = false
    const read = h.store.readMetadata(h.session.agentSessionId).then(value => { returned = true; return value }); pending.push(read)
    await h.store.readMetadata('writer'); await delay(30)
    expect(returned).toBe(false)
    pauses[1]!.release(); await second
    expect(await read).toEqual(final)
    expect((h.store as unknown as StoreOwner).sessionWriteTails.size).toBe(0)
  } finally { for (const pause of pauses) pause.release(); await Promise.allSettled(pending); await h.close() }
})

it('a historical receipt settlement stays ordered without replacing the later input', async () => {
  const h = await fixture(), pending: Promise<unknown>[] = []
  let release = () => {}
  try {
    const admission = h.session.promptCompletionAdmission!
    if (admission.transport !== 'native') throw new Error('Fixture requires Native history')
    const latest = { ...h.session, updatedAt: h.session.updatedAt + 1, promptCompletionAdmission: { ...admission,
      operationId: 'later-input', submissionId: 'later-input', inputKey: { ...h.key, submissionId: 'later-input' } } }
    await h.store.compareAndSwapMetadata(h.session, latest)
    const settled = { ...h.receipt, admission: { ...admission, acknowledged: true, native: { plan, outcome: 'admitted' as const, turnId: 'original-turn' } } }
    const [pause] = pauseCommits(h.store); release = pause!.release
    const writing = h.store.settlePromptAdmission(h.receipt, settled); pending.push(writing); await pause!.entered
    let returned = false
    const read = h.client.inspectAgentPromptSubmission(h.key).then(value => { returned = true; return value }); pending.push(read)
    await h.store.readMetadata('writer'); await delay(30); expect(returned).toBe(false)
    release(); await writing
    expect(await read).toEqual(settled)
    expect(await h.store.readMetadata(h.session.agentSessionId)).toEqual(latest)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { release(); await Promise.allSettled(pending); await h.close() }
})

it.each(['recipient-run', 'author-capability', 'author-reservation'] as const)('keeps the original claim fence after another Store changes %s', async change => {
  const h = await fixture(), foreign = new AgentMuxFileAgentSessionStore(h.store.path)
  try {
    const author = (await h.store.readMetadata('writer'))!
    const binding = { agentSessionId: author.agentSessionId, workspacePath: author.workspacePath,
      runId: author.run.runId, capabilityHash: author.capabilityHash! }
    if (change === 'recipient-run') await foreign.compareAndSwapMetadata(h.session, {
      ...h.session, run: { runId: 'foreign-replacement' }, retiredRuns: [h.session.run], updatedAt: h.session.updatedAt + 1
    })
    else if (change === 'author-capability') await foreign.compareAndSwapMetadata(author, {
      ...author, capabilityHash: 'replaced-author-capability', updatedAt: author.updatedAt + 1
    })
    else await foreign.reserveLifecycle({ kind: 'resume', agentSessionId: author.agentSessionId, expectedRun: author.run,
      reservationId: 'foreign-author-reservation', operationId: 'foreign-author-resume', ownerId: 'foreign-owner',
      ownerPid: process.pid, expiresAt: Date.now() + 60_000 })
    await expect(h.store.compareAndSwapMetadata(h.session, { ...h.session, updatedAt: h.session.updatedAt + 1 }, undefined, undefined, binding))
      .rejects.toMatchObject({ code: change === 'recipient-run' ? 'STALE_AGENT_SESSION'
        : change === 'author-capability' ? 'AGENT_CAPABILITY_INVALID' : 'AGENT_SESSION_BUSY' })
    expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(h.receipt)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await h.close() }
})
