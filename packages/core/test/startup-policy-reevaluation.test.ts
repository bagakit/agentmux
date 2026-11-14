import { appendFile, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, agentLifecycleOperationIdentity } from '../src/agent-session-store.js'
import { normalizeAgentContinuityPolicy } from '../src/agent-session-recovery/continuity-contract.js'
import { headlessFixture, until } from './helpers/headless-runtime-fixture.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { frontendRecoveryFixture } from './helpers/frontend-recovery-fixture.js'

const closes: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Private startup policy cleanup failed')
})
const policy = { retryMaxAttempts: 0, continuationEnabled: false, reminderMode: 'off' as const }
const rows = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
const executedOwner = async (pid: number | undefined, consumer: string) => {
  if (process.env.STARTUP_POLICY_EXECUTIONS) await appendFile(process.env.STARTUP_POLICY_EXECUTIONS,
    JSON.stringify({ pid, consumer }) + '\n')
}

it('a healthy original frontend can record its new startup more than once after the policy fence is committed', async () => {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/agent-session-recovery/owner.mjs'))
  vi.stubEnv('NODE_OPTIONS', [process.env.NODE_OPTIONS, '--import', JSON.stringify(resolve(import.meta.dirname, 'fixtures/startup-policy-register.mjs'))].filter(Boolean).join(' '))
  const f = await frontendRecoveryFixture(closes)
  await executedOwner(f.scope.ownerProcess.pid, 'frontend-reattach')
  await f.configure([], false)
  const original = (await f.store.readMetadata(f.original.agentSessionId))!, now = Date.now()
  const old = { operationId: 'old-policy', agentSessionId: original.agentSessionId, trigger: 'startup' as const, previousRun: original.run,
    nativeTarget: original.nativeHandle as NonNullable<typeof original.continuity>['nativeTarget'], policy: normalizeAgentContinuityPolicy(policy),
    admittedAt: now, observedAt: now, rechecks: 0, kind: 'pending' as const, reason: 'not-active', evidence: { kind: 'run-missing' as const, observedAt: now },
    supervision: { phase: 'paused' as const, reason: 'not-active', activeAttemptOperationId: 'old-policy', attemptCount: 0, attemptLimit: 1, observedAt: now } }
  // Native observations may update metadata while this exact historical receipt is seeded.
  // Retry only the Store's confirmed-not-applied stale CAS; preserve every concurrent observation.
  for (let attempt = 0; ; attempt++) {
    const current = (await f.store.readMetadata(original.agentSessionId))!
    expect(current.run).toEqual(original.run); expect(current.nativeHandle).toEqual(original.nativeHandle)
    try {
      await f.store.compareAndSwapMetadata(current, { ...current, continuity: old,
        continuityOperations: { ...current.continuityOperations, 'old-policy': old } })
      break
    } catch (error) {
      if ((error as { code?: string }).code !== 'STALE_AGENT_SESSION' || attempt === 9) throw error
    }
  }
  const result = await f.sdk.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    operationId: 'fresh-frontend-startup', trigger: 'startup', commandOverride: f.command, policy })
  expect(result.kind, JSON.stringify(result)).toBe('reattachable')
  const after = await until(() => f.sdk.statusAgent(original.agentSessionId), value => value.session.terminalFrontend?.state === 'attached', 'the original frontend reconnect')
  expect(after.run).toMatchObject({ runId: f.before.run.runId, pid: f.before.run.pid, state: 'running' })
  const saved = (await f.store.readMetadata(original.agentSessionId))!
  expect(saved.nativeActor?.actorId).toBe(original.nativeActor?.actorId)
  expect(saved.continuityOperations!['old-policy']).toEqual(old)
  expect(saved.continuity?.operationId).toBe('fresh-frontend-startup')
  expect(saved.continuity?.kind).toBe('reattachable')
  expect(await f.starts()).toHaveLength(2)
  expect(await rows(f.native)).toHaveLength(1)
}, 60_000)

async function legacyHost(state: 'working' | 'done' = 'working') {
  vi.stubEnv('AGENTMUX_TEST_OWNER_ENTRY', resolve(import.meta.dirname, 'fixtures/startup-policy-owner.mjs'))
  const scope = await headlessFixture({ ownerNodeArgs: ['--import', resolve(import.meta.dirname, 'fixtures/startup-policy-register.mjs')] })
  closes.push(scope.cleanup)
  const durable = scope.env.AGENTMUX_STATE_DIRECTORY!, activity = join(durable, 'native-activity.json')
  await writeFile(activity, JSON.stringify({ state }))
  let sdk = await scope.client()
  const original = await sdk.createAgent({ agentSessionId: 'policy-original', providerId: 'startup-policy', executorId: 'startup-policy',
    createOperationId: 'original-create', workspacePath: scope.root, prompt: 'ORIGINAL_PROMPT_DO_NOT_REPLAY', injectAgentMuxGuide: false })
  const store = new AgentMuxFileAgentSessionStore(scope.env.AGENTMUX_AGENT_SESSION_STORE!)
  await sdk.statusAgent(original.agentSessionId)
  await until(() => store.readMetadata(original.agentSessionId), value => value?.semanticStatus?.state === state, 'original native activity')
  const launches = join(durable, 'native-launches.ndjson')
  await until(() => rows(launches), value => value.length === 1, 'original Native launch')
  // Produce the old policy receipt through its actual former admission path,
  // then discard that owner and load the candidate from unchanged source.
  await sdk.dispose(); await scope.stopOwner(); await scope.restartNativeDaemon()
  await writeFile(join(durable, 'legacy-projection'), '')
  await scope.restart(); sdk = await scope.client()
  const old = await sdk.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: original.run,
    operationId: 'legacy-startup', trigger: 'startup', policy })
  expect(old).toMatchObject({ kind: 'pending', reason: 'not-active', continuity: { operationId: 'legacy-startup',
    supervision: { phase: 'paused', attemptCount: 0 } } })
  const journal = (await store.readMetadata(original.agentSessionId))!.continuityOperations!['legacy-startup']!
  await sdk.dispose(); await scope.stopOwner(); await rm(join(durable, 'legacy-projection'))
  await scope.restart(); sdk = await scope.client()
  await executedOwner(scope.ownerProcess.pid, 'fresh-startup')
  closes.push(async () => {
    for (const name of ['probe-hold', 'lifecycle-hold', 'lifecycle-unavailable']) await rm(join(durable, name), { force: true })
    const owner = await scope.client(), current = await owner.statusAgent(original.agentSessionId)
    if (current.run.state === 'running') await owner.stopAgent(original.agentSessionId, current.session.run)
  })
  const before = await sdk.statusAgent(original.agentSessionId)
  expect(before.run).toMatchObject({ runId: original.run.runId, state: 'interrupted' })
  expect((await store.readMetadata(original.agentSessionId))!.continuityOperations!['legacy-startup']).toEqual(journal)
  expect(await rows(launches)).toHaveLength(1)
  const request = { agentSessionId: original.agentSessionId, expectedRun: original.run, operationId: 'fresh-startup', trigger: 'startup' as const, policy }
  return { scope, durable, sdk, store, original, journal, launches, request }
}

it.each(['working', 'done'] as const)('a fresh %s startup consumes the retained native facts after a real Host restart and preserves the old policy journal', async state => {
  const f = await legacyHost(state), result = await f.sdk.ensureAgentContinuity(f.request)
  expect(result.kind, JSON.stringify(result)).toBe('resumed')
  const current = await f.sdk.statusAgent(f.original.agentSessionId)
  expect(current.session.nativeHandle).toEqual(f.original.nativeHandle)
  expect(current.run).toMatchObject({ state: 'running' }); expect(current.run.runId).not.toBe(f.original.run.runId)
  const stored = (await f.store.readMetadata(f.original.agentSessionId))!
  expect(stored.continuityOperations!['legacy-startup']).toEqual(f.journal)
  expect(stored.continuityOperations!['fresh-startup']).toMatchObject({ kind: 'resumed', previousRun: f.original.run,
    newRun: stored.run, supervision: { attemptCount: 1, attemptLimit: 1 }, recoveryInputs: { reminder: '', continuation: '' } })
  await until(() => rows(f.launches), value => value.length === 2, 'one candidate resume')
  expect(await rows(f.launches)).toEqual([['original-native', 'ORIGINAL_PROMPT_DO_NOT_REPLAY'], ['original-native']])
  await f.sdk.writeAgent({ agentSessionId: f.original.agentSessionId, expectedRun: stored.run, source: 'user', data: 'same-original-context' })
  await until(() => f.sdk.readRunReplay(stored.run), value => value.replay.some(chunk => chunk.data.includes('LIVE:same-original-context')), 'usable original resumed TUI')
  await expect(f.sdk.ensureAgentContinuity(f.request)).resolves.toMatchObject({ kind: 'resumed' })
  expect(await rows(f.launches)).toHaveLength(2)
  if (process.env.STARTUP_POLICY_PRODUCT) await appendFile(process.env.STARTUP_POLICY_PRODUCT, JSON.stringify({
    state, ownerPid: f.scope.ownerProcess.pid, originalOperation: 'legacy-startup', currentOperation: 'fresh-startup',
    originalSession: f.original.agentSessionId, nativeSessionId: stored.nativeHandle?.sessionId,
    originalRun: f.original.run.runId, resumedRun: stored.run.runId, preservedLegacyJournal: true,
    originalPromptCount: 1, actualNativeLaunches: 2, originalContextInputAcknowledged: true }) + '\n')
}, 40_000)

it.each(['manual', 'expired'] as const)('a fresh startup retains the current %s policy boundary without launching', async boundary => {
  const f = await legacyHost()
  const result = await f.sdk.ensureAgentContinuity({ ...f.request, policy: { ...policy,
    ...(boundary === 'manual' ? { activeRecovery: 'manual' as const } : { confirmedIdleWindowMs: 0 }) } })
  expect(result).toMatchObject({ kind: 'pending', reason: boundary === 'manual' ? 'active-manual' : 'idle-window-expired' })
  expect((await f.store.readMetadata(f.original.agentSessionId))!.continuityOperations!['legacy-startup']).toEqual(f.journal)
  expect(await rows(f.launches)).toHaveLength(1)
}, 40_000)

it.each(['cancelled', 'target-changed', 'lifecycle-admitted', 'lifecycle-unavailable'] as const)('a fresh startup rechecks concurrent %s at the admission CAS before Native Start', async change => {
  const f = await legacyHost()
  const hold = join(f.durable, 'probe-hold'); await writeFile(hold, '')
  const pending = f.sdk.ensureAgentContinuity(f.request).then(value => ({ value }), error => ({ error }))
  await until(() => readFile(join(f.durable, 'probe-entered'), 'utf8').catch(() => ''), value => Boolean(value), 'original asynchronous probe')
  const original = (await f.store.readMetadata(f.original.agentSessionId))!, root = structuredClone(original.continuityOperations!['legacy-startup']!)
  if (change === 'cancelled' || change === 'target-changed') {
    if (change === 'cancelled') root.supervision!.phase = 'cancelled'
    else root.nativeTarget = { ...root.nativeTarget!, sessionId: 'different-original-target' }
    await f.store.compareAndSwapMetadata(original, { ...original, continuity: root,
      continuityOperations: { ...original.continuityOperations, 'legacy-startup': root } })
  } else if (change === 'lifecycle-admitted') await f.store.reserveLifecycle({ reservationId: 'concurrent-original-lifecycle',
    kind: 'resume', ownerId: 'original-owner', ownerPid: process.pid, agentSessionId: original.agentSessionId,
    operationId: agentLifecycleOperationIdentity('resume', original.agentSessionId, root.operationId), expectedRun: original.run, expiresAt: Date.now() + 60_000 })
  else await writeFile(join(f.durable, 'lifecycle-unavailable'), '')
  await rm(hold)
  expect(await pending).toMatchObject({ error: { code: change === 'lifecycle-unavailable' ? 'CONTROL_UNAVAILABLE' : 'AGENT_CONTINUITY_SUPERSEDED' } })
  expect(await rows(f.launches)).toHaveLength(1)
  const saved = (await f.store.readMetadata(f.original.agentSessionId))!
  expect(saved.run).toEqual(f.original.run); expect(saved.continuityOperations!['legacy-startup']).toEqual(root)
  expect(saved.continuityOperations!['fresh-startup']).toBeUndefined()
}, 40_000)

it.each(['manual', 'expired'] as const)('a concurrent cancel fences the fresh %s pending policy receipt and later automatic startup', async boundary => {
  const f = await legacyHost(), hold = join(f.durable, 'lifecycle-hold')
  await writeFile(hold, boundary)
  const pending = f.sdk.ensureAgentContinuity({ ...f.request, policy: { ...policy,
    ...(boundary === 'manual' ? { activeRecovery: 'manual' as const } : { confirmedIdleWindowMs: 0 }) } })
    .then(value => ({ value }), error => ({ error }))
  await until(() => readFile(join(f.durable, 'lifecycle-entered'), 'utf8').catch(() => ''), value => Boolean(value), 'the final original lifecycle read')
  expect(JSON.parse(await readFile(join(f.durable, 'lifecycle-entered'), 'utf8'))).toEqual({ read: 2 })
  const cancelled = await f.sdk.controlAgentContinuity({ agentSessionId: f.original.agentSessionId, expectedRun: f.original.run,
    intentOperationId: 'legacy-startup', operationId: 'original-human-cancel', action: 'cancel' })
  expect(cancelled.receipt.outcome).toBe('cancelled')
  const original = (await f.store.readMetadata(f.original.agentSessionId))!.continuityOperations!['legacy-startup']!
  await rm(hold)
  expect(await pending).toMatchObject({ error: { code: 'AGENT_CONTINUITY_SUPERSEDED' } })
  await expect(f.sdk.ensureAgentContinuity({ ...f.request, operationId: 'later-automatic-startup' })).resolves.toMatchObject({ reason: 'intent-cancelled' })
  const saved = (await f.store.readMetadata(f.original.agentSessionId))!
  expect(saved.continuityOperations!['legacy-startup']).toEqual(original)
  expect(saved.continuity?.operationId).toBe('legacy-startup')
  expect(saved.continuityOperations!['fresh-startup']).toBeUndefined()
  expect(saved.continuityOperations!['later-automatic-startup']).toBeUndefined()
  expect(await rows(f.launches)).toHaveLength(1)
}, 40_000)

async function originalDecision() {
  const f = await rpcOwnerFixture(['original'], undefined, () => ({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } }))
  closes.push(f.close)
  const before = (await f.store.readMetadata('original'))!, now = Date.now()
  const root = { operationId: 'old-policy', agentSessionId: 'original', trigger: 'startup' as const, policy: normalizeAgentContinuityPolicy(policy),
    previousRun: before.run, kind: 'pending' as const, reason: 'not-active', nativeTarget: before.nativeHandle,
    admittedAt: now, observedAt: now, rechecks: 0, evidence: { kind: 'run-ended' as const, state: 'interrupted' as const, observedAt: now },
    supervision: { phase: 'paused' as const, reason: 'not-active', activeAttemptOperationId: 'old-policy', attemptCount: 0, attemptLimit: 1, observedAt: now } }
  await f.store.compareAndSwapMetadata(before, { ...before, updatedAt: now, semanticStatus: { state: 'working', source: 'native-hook', observedAt: now },
    continuity: root, continuityOperations: { [root.operationId]: root } })
  await f.inner.registry.load('local')
  const session = (await f.store.readMetadata('original'))!, original = session.continuityOperations!['old-policy']!
  const supervisor = (f.client as any).recovery.continuitySupervisor
  f.inner.kernel.status = vi.fn(async () => ({ ...f.run(before.run.runId), state: { type: 'interrupted', reason: 'daemon_restart' } }))
  f.inner.kernel.start = vi.fn()
  const request = { agentSessionId: session.agentSessionId, expectedRun: session.run, operationId: 'fresh-startup', trigger: 'startup' as const, policy }
  return { ...f, session, original, supervisor, request }
}

it.each(['cancelled', 'cancellation', 'used-budget', 'child-attempt', 'new-Run', 'unknown-Start', 'unknown-reason', 'launch-input',
  'message-input', 'input-delivery', 'frontend', 'initialization', 'resolution', 'restart', 'target-changed', 'Run-changed',
  'old-manual', 'non-startup', 'known-operation', 'standing', 'mote-role', 'control-receipt'] as const)(
  'retains the original %s boundary instead of treating it as an unadmitted policy decision', async boundary => {
    const f = await originalDecision(), root: any = f.original, input: any = f.request
    if (boundary === 'cancelled') root.supervision.phase = 'cancelled'
    if (boundary === 'cancellation') root.supervision.cancellation = { operationId: 'original-cancel' }
    if (boundary === 'used-budget') root.supervision.attemptCount = 1
    if (boundary === 'child-attempt') root.supervision.activeAttemptOperationId = 'original-child'
    if (boundary === 'new-Run') root.newRun = { runId: 'original-started-run' }
    if (boundary === 'unknown-Start') root.kind = 'starting'
    if (boundary === 'unknown-reason') root.reason = root.supervision.reason = 'operation-unconfirmed'
    if (boundary === 'launch-input') root.launchInput = { state: 'unknown' }
    if (boundary === 'message-input') root.messageInput = { state: 'unknown' }
    if (boundary === 'input-delivery') root.recoveryDelivery = { continuation: { state: 'unknown' } }
    if (boundary === 'frontend') root.frontendReconnect = { operationId: 'original-frontend' }
    if (boundary === 'initialization') root.initializationRecovery = { lifecycleOperationId: 'original-initialization' }
    if (boundary === 'resolution') root.resolution = { operationId: 'original-resolution' }
    if (boundary === 'restart') root.action = 'restart'
    if (boundary === 'target-changed') root.nativeTarget = { ...root.nativeTarget, sessionId: 'another-native' }
    if (boundary === 'Run-changed') root.previousRun = { runId: 'another-original-run' }
    if (boundary === 'old-manual') root.trigger = 'manual'
    if (boundary === 'non-startup') input.trigger = 'observation'
    if (boundary === 'known-operation') input.operationId = root.operationId
    if (boundary === 'standing') root.standingIntent = { intentId: 'original-standing-intent' }
    if (boundary === 'mote-role') root.moteMainEntry = { roleRevision: 'original-role' }
    if (boundary === 'control-receipt') root.supervision.controlOperations = { original: { outcome: 'observed' } }
    const unchanged = structuredClone(f.session)
    expect(f.supervisor.unadmittedPolicyDecision(f.session, input, root)).toBe(false)
    expect(f.session).toEqual(unchanged)
    expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  })

it.each(['reserved', 'prepared', 'unavailable'] as const)('a startup keeps the original %s lifecycle/correlation and cannot grant a replacement', async state => {
  const f = await originalDecision()
  const operationId = agentLifecycleOperationIdentity('resume', f.session.agentSessionId, f.original.operationId)
  if (state === 'unavailable') vi.spyOn(f.store, 'readLifecycleReservation').mockRejectedValue(Error('Original lifecycle read unavailable'))
  else {
    const reservation = { reservationId: 'original-reservation', kind: 'resume' as const, ownerId: 'original-owner', ownerPid: process.pid,
      agentSessionId: f.session.agentSessionId, operationId, expectedRun: f.session.run, expiresAt: Date.now() + 60_000 }
    // A retained preparation may disagree with an older zero-count observer.
    // Its original durable reservation remains authoritative without another prepare or Start.
    await f.store.reserveLifecycle({ ...reservation, ...(state === 'prepared' ? { preparedSession: f.session } : {}) })
  }
  const correlation = state === 'unavailable' ? null : await f.store.loadResumeCorrelation(f.session.agentSessionId, operationId)
  await expect(f.client.ensureAgentContinuity(f.request)).resolves.toMatchObject({ kind: 'pending', reason: 'recovery-supervised', continuity: { operationId: 'old-policy' } })
  expect((await f.store.readMetadata(f.session.agentSessionId))!.continuityOperations!['old-policy']).toEqual(f.original)
  expect((await f.store.readMetadata(f.session.agentSessionId))!.continuityOperations!['fresh-startup']).toBeUndefined()
  if (state !== 'unavailable') expect(await f.store.loadResumeCorrelation(f.session.agentSessionId, operationId)).toEqual(correlation)
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
})
