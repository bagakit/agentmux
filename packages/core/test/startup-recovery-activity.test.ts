import { join } from 'node:path'
import { fixtureEpoch } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentContinuityLastActivityAt } from '../src/agent-session-recovery/continuity-activity.js'
import { agentContinuityAdmission } from '../src/agent-session-recovery/continuity-policy.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import { invalidateAgentIdleEvidence } from '../src/agent-semantic-state.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'

const now = fixtureEpoch(2)
const policy = { ...DEFAULT_AGENT_CONTINUITY_POLICY }
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

function session(age = 1000): AgentMuxStoredAgentSession {
  const nativeHandle = { kind: 'provider' as const, providerId: 'codex', sessionId: 'original-native', transcriptPath: '/original.jsonl' }
  return { kind: 'agent', agentSessionId: 'original', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: '/original', run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: now,
    hookBindingId: 'original-binding', hookToken: 'original-token', nativeHandle,
    semanticStatus: { state: 'done', source: 'native-transcript', observedAt: now - age, nativeTurnId: 'original-turn' },
    nativeTurnEnds: { run: { runId: 'original-run' }, providerId: 'codex', nativeHandle,
      turns: { 'original-turn': { recordId: 'original-end', nativeObservedAt: now - age, observedAt: now } } } }
}

function admission(original: AgentMuxStoredAgentSession, at = now) {
  return agentContinuityAdmission({ session: original, trigger: 'startup', policy, admittedAt: at, now: at,
    lastActivityAt: agentContinuityLastActivityAt(original) })
}

describe('original native activity age for startup recovery', () => {
  it('uses the exact original native end without changing an unknown semantic entry time', () => {
    const original = session(), before = structuredClone(original)
    expect(agentContinuityLastActivityAt(original)).toBe(now - 1000)
    expect(admission(original)).toEqual({ kind: 'resume', reason: 'confirmed-idle', interruptedWorking: false })
    expect(original).toEqual(before)
    expect(original.semanticStatus?.stateEnteredAt).toBeUndefined()
  })

  it('never renews an old native end with its recent observation or a recent metadata/entry clock', () => {
    const original = session(policy.confirmedIdleWindowMs + 1)
    original.semanticStatus!.stateEnteredAt = now
    original.semanticStatus!.observedAt = now
    expect(admission(original)).toEqual({ kind: 'pending', reason: 'idle-window-expired' })
    original.nativeTurnEnds!.turns['original-turn']!.nativeObservedAt = now - policy.confirmedIdleWindowMs
    expect(admission(original).kind).toBe('resume')
    expect(admission(original, now + 1)).toEqual({ kind: 'pending', reason: 'idle-window-expired' })
  })

  it.each(['run', 'provider', 'native-id', 'native-path', 'turn', 'missing-time', 'future-time', 'missing-status', 'predecessor'] as const)
    ('does not inherit original idle age across %s', change => {
      const original = session()
      if (change === 'run' || change === 'predecessor') original.nativeTurnEnds!.run = { runId: 'previous-run' }
      if (change === 'provider') original.nativeTurnEnds!.providerId = 'claude'
      if (change === 'native-id') original.nativeTurnEnds!.nativeHandle = { ...original.nativeTurnEnds!.nativeHandle, sessionId: 'foreign-native' }
      if (change === 'native-path') original.nativeTurnEnds!.nativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: '/foreign.jsonl' }
      if (change === 'turn') original.semanticStatus!.nativeTurnId = 'new-turn'
      if (change === 'missing-time') delete original.nativeTurnEnds!.turns['original-turn']!.nativeObservedAt
      if (change === 'future-time') original.nativeTurnEnds!.turns['original-turn']!.nativeObservedAt = now + 1
      if (change === 'missing-status' || change === 'predecessor') delete original.semanticStatus
      expect(admission(original)).toEqual({ kind: 'pending', reason: 'idle-unknown' })
    })

  it.each(['running', 'error'] as const)('does not turn a newer %s state into an old completed turn', state => {
    const original = session()
    original.semanticStatus = { state, source: 'native-transcript', observedAt: now, nativeTurnId: 'new-turn' }
    expect(agentContinuityLastActivityAt(original)).toBeUndefined()
    expect(admission(original)).toEqual({ kind: 'pending', reason: 'not-active' })
  })

  it('does not reuse an idle epoch consumed by a newer typed input, including a retained recovery activity', () => {
    const original = invalidateAgentIdleEvidence(session())
    original.recoveryActivity = { state: 'idle', nativeSessionId: 'original-native', nativeTurnId: 'original-turn',
      sourceId: 'original-source', sequence: 2, run: original.run, hookReceiptId: 'original-hook', observedAt: now - 1000 }
    expect(original.semanticStatus?.idleEvidenceConsumed).toBe(true)
    expect(admission(original)).toEqual({ kind: 'pending', reason: 'idle-unknown' })
    for (const trigger of ['manual', 'input']) {
      expect(agentContinuityAdmission({ session: original, trigger, policy, admittedAt: now, now,
        lastActivityAt: now - 1000 })).toMatchObject({ kind: 'resume', reason: 'explicit-request' })
    }
  })

  it('uses accepted durable Hook activity through the same done policy without inventing entry time', () => {
    const original = session()
    original.semanticStatus!.source = 'native-hook'
    delete original.nativeTurnEnds
    original.recoveryActivity = { state: 'idle', nativeSessionId: 'original-native', nativeTurnId: 'original-turn',
      sourceId: 'original-source', sequence: 2, run: original.run, hookReceiptId: 'original-hook', observedAt: now - 1000 }
    expect(admission(original)).toMatchObject({ kind: 'resume', reason: 'confirmed-idle' })
    original.recoveryActivity.observedAt = now - policy.confirmedIdleWindowMs - 1
    expect(admission(original)).toEqual({ kind: 'pending', reason: 'idle-window-expired' })
  })
})

async function recoveryFixture(options: { age?: number; consumed?: boolean; unknown?: boolean } = {}) {
  const h = await rpcOwnerFixture(['original'], undefined, root => ({
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native', transcriptPath: join(root, 'original.jsonl') } }))
  cleanups.push(h.close)
  const core = h.client as any, provider = h.client.providers.get('codex'), oldRun = { runId: 'run-original' }
  const started: any[] = []
  const newRun = () => ({ ...h.run('resumed-original'), program: started[0]?.program ?? provider.executable,
    args: started[0]?.args ?? [], lifecycleOperationId: started[0]?.operationKey ?? null })
  core.kernel.status = vi.fn(async (id: string) => id === oldRun.runId
    ? { ...h.run(id), state: { type: 'interrupted', reason: 'daemon_restart' } } : newRun())
  core.kernel.list = vi.fn(async () => started.length ? [newRun()] : [])
  core.kernel.start = vi.fn(async (spec: any) => { started.push(spec); return newRun() })
  core.probePreparedAgent = vi.fn(async () => ({ providerId: 'codex', executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities }))
  core.ensureTerminalHandshakeOrDegrade = async (value: unknown) => value
  core.hookServer.isRunning = () => true
  core.hookServer.createBinding = () => ({ bindingId: 'binding'.padEnd(43, 'B'), endpoint: {
    url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  await core.registry.update('original', oldRun, (value: AgentMuxStoredAgentSession) => {
    const at = Date.now(), original = session(options.age ?? 1000)
    original.semanticStatus!.observedAt = at - (options.age ?? 1000)
    original.nativeTurnEnds = { ...original.nativeTurnEnds!, run: oldRun, nativeHandle: value.nativeHandle!, turns: {
      'original-turn': { recordId: 'original-end', nativeObservedAt: at - (options.age ?? 1000), observedAt: at } } }
    const next = { ...value, updatedAt: at, semanticStatus: original.semanticStatus, nativeTurnEnds: original.nativeTurnEnds }
    if (options.unknown) { delete next.semanticStatus; next.nativeTurnEnds.run = { runId: 'previous-run' } }
    return options.consumed ? invalidateAgentIdleEvidence(next) : next
  })
  const hosted = await hostedTestClient(h.client); cleanups.push(hosted.dispose)
  return { ...h, core, started, hosted, oldRun, request: { agentSessionId: 'original', expectedRun: oldRun,
    operationId: 'startup-original', trigger: 'startup', policy: { reminderMode: 'off' as const, recheckMaxAttempts: 0 } } }
}

it('Hosted SDK continuity resumes the same native conversation from retained original end and emits no old input', async () => {
  const h = await recoveryFixture()
  const result = await h.hosted.sdk.ensureAgentContinuity(h.request)
  expect(result).toMatchObject({ kind: 'resumed', previousRun: h.oldRun,
    session: { agentSessionId: 'original', nativeHandle: { providerId: 'codex', sessionId: 'original-native' } } })
  expect(h.started).toHaveLength(1)
  expect(h.started[0].args).toContain('original-native')
  expect(h.core.kernel.input).not.toHaveBeenCalled()
  expect(h.core.kernel.stop).not.toHaveBeenCalled()
  expect((await h.store.readMetadata('original'))?.run.runId).toBe('resumed-original')
})

it.each([
  { age: policy.confirmedIdleWindowMs + 10_000, reason: 'idle-window-expired' },
  { consumed: true, reason: 'idle-unknown' },
  { unknown: true, reason: 'idle-unknown' }
])('Hosted SDK retains the original Run and explicit recovery path for $reason ($age/$consumed/$unknown)', async options => {
  const h = await recoveryFixture(options)
  expect(await h.hosted.sdk.ensureAgentContinuity(h.request)).toMatchObject({ kind: 'pending', reason: options.reason })
  expect(h.started).toHaveLength(0)
  expect(h.core.kernel.input).not.toHaveBeenCalled()
  expect(h.core.kernel.stop).not.toHaveBeenCalled()
  expect((await h.store.readMetadata('original'))?.run).toEqual(h.oldRun)
  expect(await h.hosted.sdk.ensureAgentContinuity({ ...h.request, operationId: 'manual-original', trigger: 'manual' })).toMatchObject({ kind: 'resumed' })
  expect(h.started).toHaveLength(1)
})
