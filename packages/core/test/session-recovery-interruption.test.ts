import { fixtureEpoch as _lateFixtureEpoch, fixturePath as _lateFixturePath } from "../../../test/fixture-values.mjs"
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { inspectAgentSessionInterruption } from '../src/agent-session-recovery/interruption.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import { agentContinuityAdmission } from '../src/agent-session-recovery/continuity-policy.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const now = _lateFixtureEpoch(2)
const policy = { ...DEFAULT_AGENT_CONTINUITY_POLICY }
function session(providerId = 'claude'): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: 'original', providerId, executorId: providerId, hostId: 'local', workspacePath: _lateFixturePath("original"),
    run: { runId: 'original-run' }, retiredRuns: [], createdAt: now - 1000, updatedAt: now,
    nativeHandle: { kind: 'provider', providerId, sessionId: 'original-native' },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: now - 1000 },
    recoveryActivity: { run: { runId: 'original-run' }, nativeSessionId: 'original-native', nativeTurnId: 'original-turn',
      sourceId: 'original-source', sequence: 2, state: 'idle', interruption: 'interrupted', hookReceiptId: 'original-end', observedAt: now - 500 } }
}

describe('frozen original native interruption', () => {
  it.each(['interrupted', 'not-interrupted'] as const)('uses the exact Claude native %s result ahead of active fallback', async interruption => {
    const original = session(); original.recoveryActivity!.interruption = interruption
    const result = await inspectAgentSessionInterruption(original, new AgentProviderRegistry().get('claude'), { ...policy, activeInterruptionFallback: true }, [], now)
    expect(result).toMatchObject({ support: 'provider', state: interruption, source: 'native-protocol', previousRun: original.run,
      nativeTarget: original.nativeHandle, evidenceId: 'original-end', nativeTurnId: 'original-turn' })
  })
  it.each(['active', 'unknown', 'absent', 'different-turn-input'] as const)('keeps supported %s evidence unknown even with fallback enabled', async state => {
    const original = session()
    if (state === 'absent') delete original.recoveryActivity
    else if (state === 'different-turn-input') original.recoveryActivity!.promptSubmissionId = 'previous-input'
    else { original.recoveryActivity!.state = state; delete original.recoveryActivity!.interruption }
    expect(await inspectAgentSessionInterruption(original, new AgentProviderRegistry().get('claude'), { ...policy, activeInterruptionFallback: true }, [], now))
      .toMatchObject({ support: 'provider', state: 'unknown', source: 'native-protocol' })
  })
  it.each(['foreign-run', 'foreign-native', 'source-changed'] as const)('does not adopt %s native recovery evidence', async change => {
    const original = session()
    if (change === 'foreign-run') original.recoveryActivity!.run = { runId: 'foreign' }
    if (change === 'foreign-native') original.recoveryActivity!.nativeSessionId = 'foreign'
    if (change === 'source-changed') original.nativeSourceObservation = { state: 'changed', run: original.run, observedAt: now, reason: 'foreign-source' }
    expect((await inspectAgentSessionInterruption(original, new AgentProviderRegistry().get('claude'), policy, [], now)).state).toBe('unknown')
  })
  it.each(['interrupted', 'completed', 'failed', 'working', 'unavailable', 'failed-read'] as const)('consumes Codex %s protocol independently of display activity', async outcome => {
    const provider = new AgentProviderRegistry().get('codex')
    vi.spyOn(provider, 'readPromptExecutionEvidence').mockImplementation(async () => {
      if (outcome === 'failed-read') throw new Error('source unavailable')
      if (outcome === 'unavailable') return null
      return { sourceId: 'exact-source', id: 'exact-record', nativeTurnId: 'exact-turn',
        state: outcome === 'working' ? 'working' : 'ended', ...(outcome === 'working' ? {} : { endReason: outcome }), observedAt: now - 5 }
    })
    const original = session('codex'); delete original.recoveryActivity
    const result = await inspectAgentSessionInterruption(original, provider, { ...policy, activeInterruptionFallback: true }, [], now)
    expect(result).toMatchObject({ support: 'provider', state: outcome === 'interrupted' ? 'interrupted' :
      ['completed', 'failed'].includes(outcome) ? 'not-interrupted' : 'unknown', source: 'native-protocol' })
  })
  it('defaults unsupported active fallback off and requires an explicit fresh original main activity', async () => {
    const original = session('gemini'), provider = new AgentProviderRegistry().get('gemini')
    expect(policy.activeInterruptionFallback).toBe(false)
    expect(await inspectAgentSessionInterruption(original, provider, policy, [], now)).toMatchObject({ support: 'unsupported', state: 'unknown', source: 'none' })
    expect(await inspectAgentSessionInterruption(original, provider, { ...policy, activeInterruptionFallback: true }, [], now))
      .toMatchObject({ support: 'unsupported', state: 'interrupted', source: 'active-fallback' })
    original.semanticStatus!.observedAt = now - policy.confirmedIdleWindowMs - 1
    original.semanticStatus!.aggregateActivityAt = now
    expect((await inspectAgentSessionInterruption(original, provider, { ...policy, activeInterruptionFallback: true }, [], now)).state).toBe('unknown')
  })
})

describe('automatic native resume window', () => {
  it.each(['working', 'done'] as const)('applies the same exact age boundary to %s', state => {
    const original = session(); original.semanticStatus = { state, source: 'native-hook', observedAt: now - policy.confirmedIdleWindowMs,
      stateEnteredAt: now - policy.confirmedIdleWindowMs }
    const input = { session: original, trigger: 'startup' as const, policy, admittedAt: now, now }
    expect(agentContinuityAdmission(input).kind).toBe('resume')
    expect(agentContinuityAdmission({ ...input, now: now + 1 })).toMatchObject({ kind: 'pending', reason: 'idle-window-expired' })
    expect(agentContinuityAdmission({ ...input, now: now + 1, timingOverride: 'startup' })).toMatchObject({ kind: 'pending', reason: 'idle-window-expired' })
    expect(agentContinuityAdmission({ ...input, now: now + 1, trigger: 'manual' })).toMatchObject({ kind: 'resume', interruptedWorking: false })
  })
  it('does not promote a fresh working observation into an interruption fact', () => {
    expect(agentContinuityAdmission({ session: session(), trigger: 'startup', policy, admittedAt: now, now }))
      .toMatchObject({ kind: 'resume', interruptedWorking: false })
  })
})

async function recoveryFixture(options: { healthy?: boolean; age?: number; interrupted?: boolean; fallback?: boolean } = {}) {
  const h = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'gemini', executorId: 'gemini',
    nativeHandle: { kind: 'provider', providerId: 'gemini', sessionId: 'native-original' } }))
  const core = h.client as any, provider = h.client.providers.get('gemini'), oldRun = { runId: 'run-recipient' }, newRun = { runId: 'resumed-run' }, started: any[] = []
  const currentRun = () => ({ ...h.run(newRun.runId), program: started[0]?.program ?? provider.executable, args: started[0]?.args ?? [], lifecycleOperationId: started[0]?.operationKey ?? null })
  core.kernel.status = vi.fn(async (id: string) => id === oldRun.runId ? { ...h.run(id), state: options.healthy ? { type: 'running' } : { type: 'exited', code: 143, signal: null } } : currentRun())
  core.kernel.list = vi.fn(async () => started.length ? [currentRun()] : [])
  core.kernel.start = vi.fn(async (spec: any) => { started.push(spec); return currentRun() })
  core.probePreparedAgent = vi.fn(async () => ({ providerId: 'gemini', executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities }))
  core.ensureTerminalHandshakeOrDegrade = async (value: any) => value
  core.hookServer.isRunning = () => true
  core.hookServer.createBinding = () => ({ bindingId: 'binding'.padEnd(43, 'B'), endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  await core.registry.update('recipient', oldRun, (value: any) => ({ ...value, updatedAt: Date.now(), semanticStatus: {
    state: options.interrupted === false ? 'done' : 'working', source: 'native-hook', observedAt: Date.now() - (options.age ?? 1000), stateEnteredAt: Date.now() - (options.age ?? 1000) } }))
  const request = { agentSessionId: 'recipient', expectedRun: oldRun, operationId: 'original-continuity', trigger: 'startup' as const,
    policy: { activeInterruptionFallback: options.fallback ?? false } }
  return { ...h, core, provider, oldRun, newRun, started, request }
}

it.each([false, true])('public Core resumes the original conversation and sends only the post-launch marker when fallback=%s', async fallback => {
  const h = await recoveryFixture({ fallback })
  try {
    const result = await h.client.ensureAgentContinuity(h.request)
    expect(result.kind).toBe('resumed'); expect(h.started).toHaveLength(1)
    const operation = h.client.agentSession('recipient').continuity!
    expect(operation.launchInput).toBeUndefined()
    expect(h.started[0].args.some((arg: string) => arg.includes('<amux:continue') || arg.includes('Session recovery context'))).toBe(false)
    if (fallback) {
      await expect.poll(() => h.client.agentSession('recipient').continuity?.recoveryDelivery?.phase).toBe('accepted')
      const delivery = h.client.agentSession('recipient').continuity!.recoveryDelivery!
      expect(delivery.continuation.text).toBe('<amux:continue />'); expect(delivery.reminder.selected).toBe(false)
      expect((await h.client.inspectAgentPromptSubmission(delivery.key))?.admission).toMatchObject({ acknowledged: true,
        intent: { message: { userContent: '<amux:continue />' } } })
      const writes = (h.inner.kernel.input as any).mock.calls
      expect(writes).toHaveLength(1); expect(writes[0][1].data).toContain('<amux:continue />')
      await h.client.ensureAgentContinuity(h.request)
      expect(h.inner.kernel.input).toHaveBeenCalledTimes(1); expect(h.started).toHaveLength(1)
    } else { expect(operation.recoveryDelivery).toBeUndefined(); expect(h.inner.kernel.input).not.toHaveBeenCalled() }
  } finally { await h.close() }
})
it('keeps a healthy original Run attach-only even outside the automatic window', async () => {
  const h = await recoveryFixture({ healthy: true, age: policy.confirmedIdleWindowMs + 1, fallback: true })
  try {
    expect(await h.client.ensureAgentContinuity(h.request)).toMatchObject({ kind: 'reattachable', run: h.oldRun })
    expect(h.started).toHaveLength(0); expect(h.inner.kernel.input).not.toHaveBeenCalled(); expect(h.core.probePreparedAgent).not.toHaveBeenCalled()
  } finally { await h.close() }
})
it('does not resume an ended original Run whose last active observation is outside the window', async () => {
  const h = await recoveryFixture({ age: policy.confirmedIdleWindowMs + 10_000, fallback: true })
  try {
    expect(await h.client.ensureAgentContinuity(h.request)).toMatchObject({ kind: 'pending', reason: 'idle-window-expired' })
    expect(h.started).toHaveLength(0); expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await h.close() }
})
