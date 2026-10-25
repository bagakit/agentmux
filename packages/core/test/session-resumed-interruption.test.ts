import { fixturePath as _batchFixturePath } from "../../../test/fixture-values.mjs"
import { afterEach, expect, it, vi } from 'vitest'
import { observeResumedTurnInterruption } from '../src/agent-session-recovery/resumed-interruption.js'
import { AgentSessionContinuityInputs, createContinuityInputDelivery } from '../src/agent-session-recovery/input.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY, normalizeAgentContinuityOperation, type AgentMuxContinuityOperation } from '../src/agent-session-recovery/continuity-contract.js'
import { AgentProviderRegistry, type AgentProvider } from '../src/agent-provider.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const now = Date.now() - 1000
function fixture() {
  const nativeTarget = { kind: 'provider' as const, providerId: 'gemini', sessionId: 'original-native' }
  const root: AgentMuxContinuityOperation = { operationId: 'root', agentSessionId: 'recipient', trigger: 'startup', previousRun: { runId: 'original-run' }, nativeTarget,
    kind: 'resumed', newRun: { runId: 'failed-attempt' }, reason: 'resumed', evidence: { kind: 'run-ended', observedAt: now, state: 'exited' },
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, admittedAt: now, observedAt: now, rechecks: 0, interruptedWorking: false,
    interruption: { support: 'provider', state: 'unknown', source: 'native-protocol', previousRun: { runId: 'original-run' }, nativeTarget,
      observedAt: now, nativeObservedAt: now - 1000, nativeSourceId: 'original-source', nativeTurnId: 'original-turn', evidenceId: 'old-record', reason: 'native-turn-end-unconfirmed' } }
  const child: AgentMuxContinuityOperation = { ...structuredClone(root), operationId: 'retry', intentOperationId: 'root', previousRun: { runId: 'failed-attempt' }, newRun: { runId: 'successful-attempt' }, resumedInputBoundary: { initialInputByte: 0 } }
  delete child.interruption
  let session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'recipient', providerId: 'gemini', executorId: 'gemini', hostId: 'local', workspacePath: _batchFixturePath("tmp"),
    run: child.newRun!, retiredRuns: [root.previousRun, root.newRun!], nativeHandle: nativeTarget, hookBindingId: 'fixture', hookToken: 'fixture', createdAt: now, updatedAt: now,
    nativeActor: { protocolId: 'private-test-protocol', actorId: 'actor', lifecycleOperationId: 'resume-retry', token: 'a'.repeat(64), launch: { command: 'gemini', args: [] } },
    continuity: child, continuityOperations: { root, retry: child } }
  let bytes = 0, pid = 1234
  const provider = { ...new AgentProviderRegistry().get('gemini'), readResumedTurnInterruption: vi.fn<NonNullable<AgentProvider['readResumedTurnInterruption']>>(async () => ({ sourceId: 'original-source', id: 'native-rpc-record', nativeTurnId: 'original-turn',
    state: 'ended' as const, endReason: 'interrupted' as const, observedAt: now - 1000 })) }
  const deps = { provider, signal: new AbortController().signal, status: vi.fn(async () => ({ runId: 'successful-attempt', pid, state: { type: 'running' as const }, acceptedInputBytes: bytes }) as any),
    save: async (change: (value: AgentMuxStoredAgentSession) => AgentMuxStoredAgentSession) => session = change(session) }
  return { get session() { return session }, root, child, provider, deps, read: () => observeResumedTurnInterruption(session, deps), setBytes: (value: number) => { bytes = value }, setPid: (value: number) => { pid = value } }
}
it('freezes the old unknown observation and records exact later evidence on the successful retry only', async () => {
  const h = fixture(), frozen = structuredClone(h.root.interruption)
  await h.read()
  expect(h.session.continuityOperations!.root!.interruption).toEqual(frozen)
  const op = h.session.continuityOperations!.retry!
  expect(op.resumedInterruption).toMatchObject({ state: 'interrupted', rootOperationId: 'root', run: h.session.run, previousRun: h.root.previousRun,
    nativeObservedAt: now - 1000, evidenceId: 'native-rpc-record', nativeSourceId: 'original-source' })
  expect(op.recoveryDelivery).toMatchObject({ phase: 'waiting', initialInputByte: 0, reminder: { selected: false }, continuation: { text: '<amux:continue />' } })
  expect(normalizeAgentContinuityOperation(op)).toEqual(op)
  await h.read(); expect(h.provider.readResumedTurnInterruption).toHaveBeenCalledTimes(1)
})
it.each(['completed', 'failed', 'unknown', 'foreign-source', 'foreign-turn'] as const)('does not send an interrupted marker for %s', async outcome => {
  const h = fixture()
  h.provider.readResumedTurnInterruption.mockResolvedValue({ sourceId: outcome === 'foreign-source' ? 'foreign' : 'original-source',
    id: 'native-rpc-record', nativeTurnId: outcome === 'foreign-turn' ? 'foreign' : 'original-turn', state: 'ended', endReason: (outcome.startsWith('foreign-') ? 'interrupted' : outcome) as any })
  await h.read()
  expect(h.session.continuityOperations!.retry!.recoveryDelivery).toBeUndefined()
  if (outcome === 'completed' || outcome === 'failed') expect(h.session.continuityOperations!.retry!.resumedInterruption?.state).toBe('not-interrupted')
  else expect(h.session.continuityOperations!.retry!.resumedInterruption).toBeUndefined()
})
it.each(['typed', 'unknown-bytes', 'new-turn', 'changed-target', 'changed-source', 'no-start-boundary', 'cancelled', 'fallback-disabled-provider', 'no-actor', 'input-trigger'] as const)('preserves the newer or unknown input boundary (%s)', async change => {
  const h = fixture(), op = h.session.continuityOperations!.retry!
  if (change === 'typed') h.session.promptCompletionAdmission = { submissionId: 'human' } as any
  if (change === 'unknown-bytes') h.setBytes(1)
  if (change === 'new-turn') h.session.semanticStatus = { state: 'done', source: 'native-transcript', nativeTurnId: 'new-human-turn', observedAt: Date.now() }
  if (change === 'changed-target') h.session.nativeHandle = { kind: 'provider', providerId: 'gemini', sessionId: 'foreign' }
  if (change === 'changed-source') h.session.nativeSourceObservation = { state: 'unknown', run: h.session.run, observedAt: Date.now(), reason: 'unknown' }
  if (change === 'no-start-boundary') delete op.resumedInputBoundary
  if (change === 'cancelled') h.root.supervision = { phase: 'cancelled' } as any
  if (change === 'fallback-disabled-provider') h.root.interruption!.support = 'unsupported'
  if (change === 'no-actor') delete h.session.nativeActor
  if (change === 'input-trigger') h.root.trigger = 'input'
  await h.read(); expect(op.recoveryDelivery).toBeUndefined(); expect(h.session.continuityOperations!.retry!.resumedInterruption).toBeUndefined()
})
it.each(['accepted', 'unknown', 'dispatch-owned', 'waiting-unclaimed'] as const)('never duplicates same-root %s input', async phase => {
  const h = fixture()
  const prior = { ...h.root, interruptedWorking: true, recoveryInputs: { reminder: '', continuation: '<amux:continue />' } }
  prior.recoveryDelivery = createContinuityInputDelivery(prior, 0)!
  if (phase === 'dispatch-owned') prior.recoveryDelivery.dispatchOwner = { ownerId: 'other-owner', claimedAt: now } as any
  else if (phase !== 'waiting-unclaimed') prior.recoveryDelivery.phase = phase
  h.session.continuityOperations!.root = prior
  await h.read()
  expect(Boolean(h.session.continuityOperations!.retry!.recoveryDelivery)).toBe(phase === 'waiting-unclaimed')
  expect(h.session.continuityOperations!.root!.recoveryDelivery!.phase).toBe(phase === 'waiting-unclaimed' ? 'superseded' : phase === 'dispatch-owned' ? 'waiting' : phase)
})
it.each(['unknown', 'interrupted', 'active-fallback'] as const)('can select the third attempt after two earlier packets ended without ever claiming input (%s)', async original => {
  const h = fixture(), prior = { ...h.root, interruptedWorking: true, recoveryInputs: { reminder: '', continuation: '<amux:continue />' } }
  if (original !== 'unknown') {
    prior.interruption = { ...prior.interruption!, state: 'interrupted',
      ...(original === 'active-fallback' ? { support: 'unsupported', source: 'active-fallback', reason: 'explicit-active-fallback' } : {}) }
    if (original === 'active-fallback') {
      delete prior.interruption.nativeSourceId
      delete prior.interruption.nativeTurnId
      delete prior.interruption.evidenceId
    }
    delete h.session.nativeActor
  }
  const frozen = structuredClone(prior.interruption)
  prior.recoveryDelivery = createContinuityInputDelivery(prior, 0)!
  h.session.continuityOperations!.root = prior
  await h.read()
  expect(h.session.continuityOperations!.root!.recoveryDelivery).toMatchObject({ phase: 'superseded', reason: 'original-run-ended-before-input-claim' })
  expect(h.session.continuityOperations!.retry!.recoveryDelivery?.phase).toBe('waiting')
  const third = { ...structuredClone(h.child), operationId: 'third', previousRun: { ...h.session.run }, newRun: { runId: 'third-attempt' } }
  h.session.run = third.newRun
  h.session.continuity = third
  h.session.continuityOperations!.third = third
  h.deps.status.mockResolvedValue({ runId: 'third-attempt', pid: 1234, state: { type: 'running' }, acceptedInputBytes: 0 } as any)
  await h.read()
  expect(h.session.continuityOperations!.retry!.recoveryDelivery).toMatchObject({ phase: 'superseded', reason: 'original-run-ended-before-input-claim' })
  expect(h.session.continuityOperations!.third!.recoveryDelivery).toMatchObject({ phase: 'waiting', key: { expectedRun: third.newRun }, continuation: { text: '<amux:continue />' } })
  expect(h.session.continuityOperations!.root!.interruption).toEqual(frozen)
  expect(h.session.continuityOperations!.third!.resumedInterruption).toMatchObject({
    support: frozen!.support, source: frozen!.source, state: 'interrupted', previousRun: prior.previousRun, rootOperationId: 'root', run: third.newRun })
  expect(normalizeAgentContinuityOperation(h.session.continuityOperations!.third!)).toEqual(h.session.continuityOperations!.third)
  await h.read()
  expect(h.provider.readResumedTurnInterruption).toHaveBeenCalledTimes(original === 'unknown' ? 2 : 0)
})
it('keeps a packet superseded by human input terminal across later attempts', async () => {
  const h = fixture(), prior = { ...h.root, interruptedWorking: true, recoveryInputs: { reminder: '', continuation: '<amux:continue />' } }
  prior.recoveryDelivery = createContinuityInputDelivery(prior, 0)!
  prior.recoveryDelivery.phase = 'superseded'
  prior.recoveryDelivery.reason = 'new-user-input-has-priority'
  h.session.continuityOperations!.root = prior
  await h.read()
  expect(h.provider.readResumedTurnInterruption).not.toHaveBeenCalled()
  expect(h.session.continuityOperations!.retry!.recoveryDelivery).toBeUndefined()
})
it('keeps earlier human input authoritative even when no recovery packet had been selected', async () => {
  const h = fixture()
  h.root.resumedInputBoundary = { initialInputByte: 0, superseded: true }
  expect(h.root.recoveryDelivery).toBeUndefined()
  await h.read()
  expect(h.provider.readResumedTurnInterruption).not.toHaveBeenCalled()
  expect(h.session.continuityOperations!.retry!.resumedInterruption).toBeUndefined()
  expect(h.session.continuityOperations!.retry!.recoveryDelivery).toBeUndefined()
})
it('rechecks older human supersession committed during the native read', async () => {
  const h = fixture(), observed = structuredClone(h.session)
  h.provider.readResumedTurnInterruption.mockImplementation(async () => {
    h.root.resumedInputBoundary = { initialInputByte: 0, superseded: true }
    return { state: 'ended', endReason: 'interrupted', sourceId: 'original-source', nativeTurnId: 'original-turn', id: 'record' }
  })
  await observeResumedTurnInterruption(observed, h.deps)
  expect(h.session.continuityOperations!.retry!.resumedInterruption).toBeUndefined()
  expect(h.session.continuityOperations!.retry!.recoveryDelivery).toBeUndefined()
})
it('rejects a different native actor committed while the original actor read was pending', async () => {
  const h = fixture(), observed = structuredClone(h.session)
  h.provider.readResumedTurnInterruption.mockImplementation(async () => {
    h.session.nativeActor = { ...h.session.nativeActor!, actorId: 'replacement-actor' }
    return { state: 'ended', endReason: 'interrupted', sourceId: 'original-source', nativeTurnId: 'original-turn', id: 'record' }
  })
  await observeResumedTurnInterruption(observed, h.deps)
  expect(h.session.continuityOperations!.retry!.resumedInterruption).toBeUndefined()
  expect(h.session.continuityOperations!.retry!.recoveryDelivery).toBeUndefined()
})
it('rechecks actor generation and CAS input scope after asynchronous protocol observation', async () => {
  const h = fixture()
  h.provider.readResumedTurnInterruption.mockImplementation(async () => { h.setPid(9876); return { state: 'ended', endReason: 'interrupted', sourceId: 'original-source', nativeTurnId: 'original-turn', id: 'record' } })
  await h.read(); expect(h.session.continuityOperations!.retry!.resumedInterruption).toBeUndefined()
  h.provider.readResumedTurnInterruption.mockImplementation(async () => { h.session.promptCompletionAdmission = { submissionId: 'new-human' } as any; return { state: 'ended', endReason: 'interrupted', sourceId: 'original-source', nativeTurnId: 'original-turn', id: 'record' } })
  await h.read(); expect(h.session.continuityOperations!.retry!.resumedInterruption).toBeUndefined()
})
it('credits only confirmed contiguous protocol ACKs before the later decision; ordinary input supersedes it', async () => {
  const h = fixture(), inputs = new AgentSessionContinuityInputs({ providers: new AgentProviderRegistry(), read: () => h.session,
    updateOperation: async (_id, operationId, update) => { update(h.session.continuityOperations![operationId]!) },
    update: async () => {}, status: h.deps.status, inspect: async () => null, submit: async () => {}, failed: () => {} })
  try {
    await inputs.protocolAccepted('recipient', h.session.run.runId, 'foreign-gap', { startByte: 3, endByte: 5 })
    expect(h.child.resumedInputBoundary!.protocolInput).toBeUndefined()
    await inputs.protocolAccepted('recipient', h.session.run.runId, 'ack-protocol', { startByte: 0, endByte: 5 })
    h.setBytes(5); await h.read()
    expect(h.session.continuityOperations!.retry!.recoveryDelivery?.protocolInput).toEqual({ operationId: 'ack-protocol', startByte: 0, endByte: 5 })
  } finally { inputs.dispose() }
  const second = fixture(), other = new AgentSessionContinuityInputs({ providers: new AgentProviderRegistry(), read: () => second.session, updateOperation: async (_id, id, update) => update(second.session.continuityOperations![id]!),
    update: async () => {}, status: second.deps.status, inspect: async () => null, submit: async () => {}, failed: () => {} })
  try { await other.userInput('recipient', second.session.run.runId); await second.read(); expect(second.session.continuityOperations!.retry!.recoveryDelivery).toBeUndefined() }
  finally { other.dispose() }
})

it.each(['interrupted', 'completed', 'unknown'] as const)('public Core lifecycle consumes post-resume original-turn %s and retains it through Store reload', async outcome => {
  const h = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'gemini', executorId: 'gemini', nativeHandle: { kind: 'provider', providerId: 'gemini', sessionId: 'native-original' } }))
  const core = h.client as any, original = h.client.providers.get('gemini'), started: any[] = []
  const post = vi.fn(async () => outcome === 'unknown' ? null : { sourceId: 'exact-source', id: 'post-native-record', nativeTurnId: 'original-turn', state: 'ended', endReason: outcome })
  const provider = { ...original, catalog: { ...original.catalog, capabilities: { ...original.catalog.capabilities, nativeInterruption: true } },
    readPromptExecutionEvidence: async () => started.length ? { sourceId: 'exact-source', id: 'idle-new-run', state: 'idle' } : { sourceId: 'exact-source', id: 'old-working-record', nativeTurnId: 'original-turn', state: 'working', observedAt: now },
    readResumedTurnInterruption: post,
    prepareManagedLaunch: async (plan: any, lifecycleOperationId: string) => ({ plan, nativeActor: { protocolId: 'private-test-protocol', actorId: 'actor', lifecycleOperationId,
      token: 'a'.repeat(64), launch: { command: 'gemini', args: [] } } }) }
  h.client.providers.replace(provider as any)
  const currentRun = () => ({ ...h.run('resumed-run'), pid: process.pid, program: started[0]?.program ?? 'gemini', args: started[0]?.args ?? [], lifecycleOperationId: started[0]?.operationKey ?? null })
  core.kernel.status = vi.fn(async (id: string) => id === 'run-recipient' ? { ...h.run(id), state: { type: 'exited', code: 143, signal: null } } : currentRun())
  core.kernel.list = vi.fn(async () => started.length ? [currentRun()] : [])
  core.kernel.start = vi.fn(async (spec: any) => { started.push(spec); return currentRun() })
  core.probePreparedAgent = async () => ({ providerId: 'gemini', executable: 'gemini', installed: true, capabilities: provider.catalog.capabilities })
  core.ensureTerminalHandshakeOrDegrade = async (session: any) => session
  core.hookServer.isRunning = () => true
  core.hookServer.createBinding = () => ({ bindingId: 'binding'.padEnd(43, 'B'), endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 'T') }, bindRun: async () => {}, close: async () => {} })
  await core.registry.update('recipient', { runId: 'run-recipient' }, (session: any) => ({ ...session, updatedAt: Date.now(), semanticStatus: { state: 'working', source: 'native-hook', observedAt: now } }))
  try {
    const request = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'root', trigger: 'manual' as const }
    const result = await h.client.ensureAgentContinuity(request)
    expect(result.kind).toBe('resumed'); expect(started).toHaveLength(1); expect(post).toHaveBeenCalled()
    await vi.waitFor(() => expect(h.client.agentSession('recipient').continuityOperations!.root!.recoveryDelivery?.phase).toBe(outcome === 'interrupted' ? 'accepted' : undefined))
    const persisted = await h.store.readMetadata('recipient'), op = persisted!.continuityOperations!.root!
    expect(op.interruption).toMatchObject({ state: 'unknown', nativeSourceId: 'exact-source', nativeTurnId: 'original-turn' })
    expect(op.resumedInputBoundary).toEqual({ initialInputByte: 0 })
    if (outcome === 'unknown') expect(op.resumedInterruption).toBeUndefined()
    else expect(op.resumedInterruption?.state).toBe(outcome === 'interrupted' ? 'interrupted' : 'not-interrupted')
    expect(core.kernel.input).toHaveBeenCalledTimes(outcome === 'interrupted' ? 1 : 0)
    if (outcome === 'interrupted') {
      expect(core.kernel.input.mock.calls[0][1].data).toContain('<amux:continue />')
      await h.client.ensureAgentContinuity(request); expect(core.kernel.input).toHaveBeenCalledTimes(1)
    }
  } finally { await h.close() }
})
