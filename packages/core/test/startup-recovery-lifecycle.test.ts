import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionContinuitySupervisor } from '../src/agent-session-recovery/supervisor.js'
import { normalizeAgentContinuityPolicy } from '../src/agent-session-recovery/continuity-contract.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await rpcOwnerFixture(['original'], undefined, () => ({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } }))
  cleanup.push(f.close)
  const before = (await f.store.readMetadata('original'))!
  const operation: any = { operationId: 'previous-boot', agentSessionId: 'original', trigger: 'startup',
    policy: normalizeAgentContinuityPolicy({ recheckMaxAttempts: 0 }), previousRun: { runId: 'previous-run' }, newRun: before.run,
    kind: 'resumed', reason: 'interrupted-working', nativeTarget: before.nativeHandle, admittedAt: 1, observedAt: 1, rechecks: 0,
    evidence: { kind: 'run-ended', state: 'interrupted', observedAt: 1 },
    supervision: { phase: 'paused', reason: 'exit-outcome-unverified', activeAttemptOperationId: 'previous-boot', attemptCount: 1, attemptLimit: 4, observedAt: 1 } }
  const session = { ...before, continuity: operation, continuityOperations: { [operation.operationId]: operation } }
  await f.store.compareAndSwap(before, session)
  await f.inner.registry.load('local')
  const unexpected = async (): Promise<never> => { throw Error('Unexpected supervisor side effect') }
  const supervisor = new AgentSessionContinuitySupervisor({ read: unexpected, lifecycle: unexpected, status: unexpected,
    watch: unexpected, update: unexpected, perform: unexpected, failed: unexpected })
  cleanup.push(() => supervisor.dispose())
  const request = { agentSessionId: 'original', expectedRun: before.run, operationId: 'this-boot', trigger: 'startup' }
  const observed = { ...f.run(before.run.runId), state: { type: 'interrupted' as const, reason: 'daemon_restart' } }
  return { ...f, session, operation, supervisor, request, observed }
}
it('releases a completed prior resume only on the exact Runtime restart receipt and leaves its durable budget intact', async () => {
  const f = await fixture(), before = structuredClone(f.operation)
  expect(f.supervisor.retainedAutomaticIntent(f.session, f.request)).toBe(f.operation)
  expect(f.supervisor.retainedAutomaticIntent(f.session, f.request, f.observed)).toBeUndefined()
  expect(f.operation).toEqual(before)
})
it.each(['cancelled', 'unknown-start', 'unknown-input', 'foreign-native', 'foreign-root', 'foreign-provider', 'foreign-run', 'foreign-workspace',
  'ordinary-exit', 'unknown-interruption', 'running', 'custom-trigger', 'explicit-input'])('retains the original %s intent instead of granting another Start', async scenario => {
  const f = await fixture()
  if (scenario === 'cancelled') f.operation.supervision.phase = 'cancelled'
  if (scenario === 'unknown-start') f.operation.kind = 'pending'
  if (scenario === 'unknown-input') f.operation.launchInput = { state: 'unknown' }
  if (scenario === 'foreign-root') { f.session.continuityOperations = { ...f.session.continuityOperations, 'previous-boot': { ...f.operation, nativeTarget: { ...f.operation.nativeTarget, sessionId: 'another-root' } } }; f.session.continuity = f.session.continuityOperations['previous-boot'] }
  if (scenario === 'foreign-native') f.operation.nativeTarget = { ...f.operation.nativeTarget, sessionId: 'another-native' }
  if (scenario === 'foreign-provider') f.operation.nativeTarget = { ...f.operation.nativeTarget, providerId: 'claude' }
  if (scenario === 'foreign-run') f.observed.runId = 'another-run'
  if (scenario === 'foreign-workspace') f.observed.workspacePath = '/another-workspace'
  if (scenario === 'ordinary-exit') (f.observed as any).state = { type: 'exited', code: 23, signal: null }
  if (scenario === 'unknown-interruption') f.observed.state.reason = 'unknown'
  if (scenario === 'running') (f.observed as any).state = { type: 'running' }
  if (scenario === 'custom-trigger') f.request.trigger = 'workspace-startup'
  if (scenario === 'explicit-input') { (f.request as any).input = { prompt: 'new input' }; f.request.trigger = 'input' }
  const retained = f.supervisor.retainedAutomaticIntent(f.session, f.request, f.observed)
  if (scenario === 'explicit-input') expect(retained).toBeUndefined()
  else expect(retained).toBe(f.session.continuityOperations['previous-boot'])
})
it('public continuity consumes the exact restart before initialization recursion, then reapplies the current policy', async () => {
  const f = await fixture()
  await (f.client as any).registry.update('original', f.session.run, (value: any) => {
    const operation = { ...value.continuityOperations['previous-boot'], initializationRecovery: {
      actorId: 'original-actor', lifecycleOperationId: 'original-lifecycle', run: value.run, previousFrontendId: 'original-frontend', outputAfterByte: 0,
      observation: { frontendId: 'original-frontend', state: 'attached', backendState: 'running', source: 'managed-process', observedAt: 1,
        initialization: { lifecycleOperationId: 'original-lifecycle', phase: 'ready', native: { state: 'confirmed', sessionId: 'original-native' } } }
    } }
    return { ...value, continuity: operation, continuityOperations: { ...value.continuityOperations, 'previous-boot': operation } }
  })
  f.inner.kernel.status = vi.fn(async () => f.observed)
  f.inner.kernel.start = vi.fn()
  const result = await f.client.ensureAgentContinuity({ ...f.request, policy: { resumeAfterExit: false } })
  expect(result).toMatchObject({ kind: 'pending', reason: 'resume-disabled', continuity: { operationId: 'this-boot' } })
  expect((await f.store.readMetadata('original'))!.continuityOperations!['previous-boot']!.supervision!.attemptCount).toBe(1)
  expect(f.inner.kernel.start).not.toHaveBeenCalled()
})
it('a failed exact Runtime observation keeps the original operation and permits no replacement', async () => {
  const f = await fixture()
  f.inner.kernel.status = vi.fn(async () => { throw Error('private Runtime temporarily unavailable') })
  f.inner.kernel.start = vi.fn()
  await expect(f.client.ensureAgentContinuity(f.request)).resolves.toMatchObject({ kind: 'pending', reason: 'recovery-supervised', continuity: { operationId: 'previous-boot' } })
  expect(f.inner.kernel.start).not.toHaveBeenCalled()
})
it.each(['cancelled', 'active-changed', 'settled', 'operation-collision'])('rechecks concurrent %s at the admission CAS before any Start', async change => {
  const f = await fixture(), core = f.client as any, provider = f.client.providers.get('codex')
  await core.registry.update('original', f.session.run, (value: any) => ({ ...value, updatedAt: Date.now(),
    semanticStatus: { state: 'working', source: 'native-transcript', observedAt: Date.now() } }))
  core.kernel.status = vi.fn(async () => f.observed)
  core.kernel.start = vi.fn()
  core.hookServer.isRunning = () => true
  core.probePreparedAgent = vi.fn(async () => {
    await core.registry.update('original', f.session.run, (value: any) => {
      const root = structuredClone(value.continuityOperations['previous-boot'])
      if (change === 'cancelled' || change === 'settled') root.supervision.phase = change
      if (change === 'active-changed') root.supervision.activeAttemptOperationId = 'another-attempt'
      return { ...value, continuity: root, continuityOperations: { ...value.continuityOperations, 'previous-boot': root,
        ...(change === 'operation-collision' ? { 'this-boot': { ...root, operationId: 'this-boot' } } : {}) } }
    })
    return { providerId: 'codex', executable: provider.executable, installed: true, capabilities: provider.catalog.capabilities }
  })
  await expect(f.client.ensureAgentContinuity(f.request)).rejects.toMatchObject({ code: 'AGENT_CONTINUITY_SUPERSEDED' })
  expect(core.probePreparedAgent).toHaveBeenCalledOnce()
  expect(core.kernel.start).not.toHaveBeenCalled()
  expect((await f.store.readMetadata('original'))!.run).toEqual(f.session.run)
})
