import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxHostedRuntimeService } from '../src/hosted-runtime-service.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { connectHostedAgentMux } from '../src/hosted-client.js'
import type { AgentTerminalFrontend } from '../src/agent-terminal-frontend.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation, type AgentMuxAgentContinuityResult } from '../src/agent-session-recovery.js'
import { prepareContinuityLaunchInput, bindContinuityLaunchInput } from '../src/agent-session-recovery/input.js'
import { AgentMuxError } from '../src/errors.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function fixture(options: { resume?: boolean; missing?: boolean; detached?: boolean; capability?: boolean } = {}) {
  const h = await rpcOwnerFixture(['recipient']), inner = h.client as any, provider = h.client.providers.get('codex')
  cleanup.push(h.close)
  const actor = { protocolId: 'managed-initialization-fixture', actorId: 'original-actor', lifecycleOperationId: 'original-create', token: 'a'.repeat(64),
    frontendControl: true as const, ...(options.capability === false ? {} : { initializationControl: true as const }), launch: { command: 'codex', args: [] } }
  await inner.registry.update('recipient', { runId: 'run-recipient' }, (value: AgentMuxStoredAgentSession) => {
    const next = { ...value, nativeActor: actor }
    if (options.resume) next.nativeHandle = { kind: 'provider', providerId: 'codex', sessionId: 'original-native' }
    else delete next.nativeHandle
    return next
  })
  inner.kernel.status = vi.fn(async (id: string) => ({ ...h.run(id), pid: 123 }))
  inner.kernel.start = vi.fn()
  inner.queueNativeIdentityCapture = vi.fn()
  inner.ensureTerminalFrontendObservation = vi.fn(async () => true)
  inner.ensureTerminalHandshakeOrDegrade = vi.fn(async (value: AgentMuxStoredAgentSession) => value)
  const watch: { frontend?: AgentTerminalFrontend; controller: AbortController; key: string; pending: Promise<boolean>; ready: Set<() => void> } = {
    controller: new AbortController(), key: JSON.stringify(['run-recipient', actor]), pending: Promise.resolve(true), ready: new Set()
  }
  const failed: AgentTerminalFrontend = { run: { runId: 'run-recipient' }, frontendId: 'original-frontend', state: 'starting', backendState: 'running',
    source: 'managed-process', observedAt: 1, initialization: { lifecycleOperationId: actor.lifecycleOperationId, phase: 'failed',
      native: { state: options.resume ? 'unknown' : 'not-created' }, failure: { step: 'preflight', code: -32603, message: 'Original account failure' } } }
  if (!options.missing) watch.frontend = failed
  inner.terminalFrontendWatches.set('recipient', watch)
  const requests: any[] = []
  const reconnect = vi.spyOn(provider, 'reconnectTerminalFrontend').mockImplementation(async (_context, request) => {
    requests.push(structuredClone(request))
    const frontend: AgentTerminalFrontend = { ...failed, frontendId: request.target.kind === 'initialization' ? 'first-tui' : 'recovered-tui',
      state: request.target.kind === 'initialization' && options.detached ? 'detached' : 'attached', observedAt: 2,
      ...(request.target.kind === 'initialization' && options.detached ? { exitCode: 1 } : {}),
      initialization: { lifecycleOperationId: actor.lifecycleOperationId, phase: 'ready', native: { state: 'confirmed', sessionId: 'original-native' } } }
    watch.frontend = frontend
    const { run: _run, ...observation } = frontend
    return observation
  })
  const original = { agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, operationId: 'original-recovery', policy: { recheckMaxAttempts: 0 } }
  return { ...h, inner, actor, watch, reconnect, requests, original }
}

function countHistoryEnumeration(service: any, session: AgentMuxStoredAgentSession) {
  const counts = { initial: 0, supervisor: 0 }
  let scope: keyof typeof counts | undefined
  const reconciler = service.reconciler
  const initial = reconciler.observeInitialInput.bind(reconciler)
  vi.spyOn(reconciler, 'observeInitialInput').mockImplementation((value: AgentMuxStoredAgentSession) => {
    const previous = scope; scope = 'initial'
    try { return initial(value) } finally { scope = previous }
  })
  const supervisor = service.continuitySupervisor
  const observe = supervisor.observe.bind(supervisor)
  const supervisorObserve = vi.spyOn(supervisor, 'observe').mockImplementation((value: AgentMuxStoredAgentSession, retry?: boolean) => {
    const previous = scope; scope = 'supervisor'
    try { return observe(value, retry) } finally { scope = previous }
  })
  // Only this Session's history is counted, inside the real consumers' stacks.
  // Its Store/Registry record remains the original plain, durable object.
  const continuityOperations = new Proxy(session.continuityOperations!, {
    ownKeys(target) { if (scope) counts[scope]++; return Reflect.ownKeys(target) }
  })
  return { counts, supervisorObserve, session: { ...session, continuityOperations } }
}

async function retainSupervisedFrontend(f: Awaited<ReturnType<typeof fixture>>) {
  const observedAt = Date.now(), nativeTarget = f.client.agentSession('recipient').nativeHandle!
  const operation: AgentMuxContinuityOperation = { operationId: 'original-observed-frontend', agentSessionId: 'recipient',
    trigger: 'startup', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun: f.original.expectedRun, nativeTarget,
    kind: 'reattachable', reason: 'explicit-request', admittedAt: observedAt, observedAt, rechecks: 0,
    evidence: { kind: 'run-running', observedAt },
    frontendReconnect: { previousFrontendId: 'old-frontend', frontendId: 'original-frontend', outputAfterByte: 0 },
    supervision: { phase: 'observing', activeAttemptOperationId: 'original-observed-frontend', attemptCount: 1,
      attemptLimit: 3, observedAt, reason: 'start-pending' } }
  await f.inner.registry.update('recipient', f.original.expectedRun, (value: AgentMuxStoredAgentSession) => ({ ...value,
    continuity: operation, continuityOperations: { [operation.operationId]: operation } }))
  f.watch.frontend = { ...f.watch.frontend!, state: 'attached' }
  delete f.watch.frontend.initialization
  f.inner.kernel.observeLifecycle = vi.fn(async () => async () => {})
  return operation
}

/** Keep the real public continuity, durable Store, reconciliation and Stop owners;
 * only external Provider/Runtime boundaries are deterministic here. */
async function replacementAfterInitialization(origin: 'initialization' | 'frontend', loseStartReply = false) {
  const f = await fixture({ resume: true, detached: origin === 'frontend' })
  if (origin === 'frontend') {
    const reconnect = f.reconnect.getMockImplementation()!
    f.reconnect.mockImplementationOnce(reconnect).mockRejectedValueOnce(new Error('Original frontend reply unknown'))
  } else f.reconnect.mockRejectedValueOnce(new Error('Original initialization reply unknown'))
  const observed = await f.client.ensureAgentContinuity(f.original)
  expect(observed.kind).toBe('pending')
  const events: Array<{ type: string; code?: string; session?: Pick<AgentMuxStoredAgentSession, 'run' | 'continuity'> }> = []
  const off = f.inner.publisher.onStatusEvent((event: typeof events[number]) => events.push(structuredClone(event)))
  cleanup.push(async () => off())
  const retained = structuredClone((await f.store.readMetadata('recipient'))!.continuityOperations![f.original.operationId]!)
  expect(retained.initializationRecovery?.run).toEqual(f.original.expectedRun)
  if (origin === 'frontend') expect(retained.frontendReconnect?.previousFrontendId).toBe('first-tui')

  // An unrelated historical operation must survive the current Run transition.
  const historical = { ...structuredClone(retained), operationId: 'prior-initialization-observation' }
  await f.inner.registry.update('recipient', f.original.expectedRun, (value: AgentMuxStoredAgentSession) => ({ ...value,
    continuityOperations: { ...value.continuityOperations, [historical.operationId]: historical } }))
  const provider = f.client.providers.get('codex')
  f.inner.sessionExecutorOptions = async (_session: unknown, input: unknown) => input
  f.inner.probePreparedAgent = vi.fn(async () => ({ providerId: 'codex', executable: 'codex', installed: true,
    capabilities: provider.catalog.capabilities }))
  f.inner.requireHookIngressOwner = vi.fn(async () => {})
  f.inner.ensureManagedHooks = vi.fn(async () => {})
  f.inner.hookServer.createBinding = vi.fn(() => ({ bindingId: 'replacement-hook',
    endpoint: { url: 'http://127.0.0.1:0', token: 'replacement-token' }, bindRun: async () => {}, close: async () => {} }))
  const managed = vi.spyOn(provider as Required<typeof provider>, 'prepareManagedLaunch').mockImplementation(async (plan, operationId) => ({ plan,
    nativeActor: { ...f.actor, actorId: 'replacement-actor', lifecycleOperationId: operationId, token: 'b'.repeat(64) } }))
  if (provider.readPromptExecutionEvidence) vi.spyOn(provider as Required<typeof provider>, 'readPromptExecutionEvidence').mockResolvedValue(null)
  let successor: CtxmuxAdapterRun | undefined, observable = !loseStartReply
  const ended: CtxmuxAdapterRun = { ...f.run(f.original.expectedRun.runId), state: { type: 'interrupted', reason: 'daemon_restart' } }
  f.inner.kernel.status = vi.fn(async (runId: string) => runId === ended.runId ? ended : successor!)
  f.inner.kernel.start = vi.fn(async (input: { operationKey: string; program: string; args: string[] }) => {
    successor = { ...f.run('replacement-run'), pid: 456, program: input.program, args: input.args,
      lifecycleOperationId: input.operationKey }
    if (loseStartReply) throw new AgentMuxError('Original replacement Start reply unknown', 'CONTROL_UNAVAILABLE')
    return successor
  })
  f.inner.kernel.inspectCreation = vi.fn(async (operationId: string) =>
    observable && successor?.lifecycleOperationId === operationId ? successor : null)
  f.inner.kernel.prepareStop = vi.fn(async (runId: string, operationKey: string) => ({ daemonInstance: 'fixture-runtime', operationKey, runId }))
  f.inner.kernel.stop = vi.fn(async (operation: { runId: string }) => {
    expect(operation.runId).toBe(successor!.runId)
    successor = { ...successor!, state: { type: 'exited', code: 0, signal: null } }
  })
  return { ...f, managed, historical, retained, events, successor: () => successor!, observeStart: () => { observable = true } }
}

async function expectReplacementCanClose(f: Awaited<ReturnType<typeof replacementAfterInitialization>>, result: Pick<AgentMuxAgentContinuityResult, 'continuity'>) {
  const saved = (await f.store.readMetadata('recipient'))!
  expect(saved.run).toEqual({ runId: f.successor().runId })
  expect(saved.retiredRuns).toContainEqual(f.original.expectedRun)
  expect(saved.nativeHandle).toMatchObject({ providerId: 'codex', sessionId: 'original-native' })
  expect(saved.nativeActor).toMatchObject({ actorId: 'replacement-actor', lifecycleOperationId: f.successor().lifecycleOperationId })
  expect(saved.continuityOperations![f.historical.operationId]).toEqual(f.historical)
  expect(saved.continuity?.initializationRecovery).toBeUndefined()
  expect(saved.continuity?.frontendReconnect).toBeUndefined()
  expect(saved.continuityOperations![f.original.operationId]).toEqual(saved.continuity)
  expect(result.continuity).toEqual(saved.continuity)
  expect(f.events.filter(event => event.code === 'AGENT_CONTINUITY_RECEIPT_UNCONFIRMED')).toEqual([])
  const published = f.events.filter(event => event.type === 'agent-session' && event.session?.run.runId === saved.run.runId)
  expect(published.length).toBeGreaterThan(0)
  for (const event of published) {
    expect(event.session!.continuity?.initializationRecovery).toBeUndefined()
    expect(event.session!.continuity?.frontendReconnect).toBeUndefined()
  }
  expect(await f.store.readLifecycleReservation('recipient')).toBeNull()
  expect(f.inner.kernel.start).toHaveBeenCalledOnce()
  expect(f.inner.kernel.input).not.toHaveBeenCalled()
  await expect(f.client.stopAgent('recipient', saved.run)).resolves.toBeUndefined()
  expect(f.inner.kernel.stop).toHaveBeenCalledOnce()
  expect(await f.store.readMetadata('recipient')).toBeNull()
  expect(await f.store.readRetiredAgentSession('recipient')).toMatchObject({
    agentSessionId: 'recipient', run: saved.run, history: { nativeHandle: saved.nativeHandle } })
}

it.each(['initialization', 'frontend'] as const)('replaces an ended Run after pending %s recovery and closes the exact successor', async origin => {
  const f = await replacementAfterInitialization(origin)
  const result = await f.client.ensureAgentContinuity(f.original)
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'resumed', run: { runId: 'replacement-run' } })
  await expectReplacementCanClose(f, result)
})

it.each(['initialization', 'frontend'] as const)('reconciles the original prepared Start after pending %s recovery without replay and then closes it', async origin => {
  const f = await replacementAfterInitialization(origin, true)
  const attempted = await f.client.ensureAgentContinuity(f.original)
  expect(attempted.kind).toBe('pending')
  const reservation = await f.store.readLifecycleReservation('recipient')
  expect(reservation).toMatchObject({ kind: 'resume', expectedRun: f.original.expectedRun,
    preparedSession: { nativeActor: { actorId: 'replacement-actor' } } })
  const unknown = await f.client.ensureAgentContinuity(f.original)
  expect(unknown.kind).toBe('pending')
  expect(await f.store.readLifecycleReservation('recipient')).toEqual(reservation)
  await expect(f.client.stopAgent('recipient', f.original.expectedRun)).rejects.toMatchObject({ code: 'AGENT_SESSION_BUSY' })
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
  expect(f.inner.kernel.start).toHaveBeenCalledOnce()
  f.observeStart()
  const restored = await f.client.ensureAgentContinuity(f.original)
  expect(restored, JSON.stringify(restored)).toMatchObject({ kind: 'resumed', run: { runId: 'replacement-run' } })
  await expectReplacementCanClose(f, restored)
})

it('connection recovery commits the retained successor before any manual continuity receipt is recorded', async () => {
  const f = await replacementAfterInitialization('frontend', true)
  expect((await f.client.ensureAgentContinuity(f.original)).kind).toBe('pending')
  const reservation = await f.store.readLifecycleReservation('recipient')
  expect(reservation).toMatchObject({ kind: 'resume', preparedSession: { continuity: {
    initializationRecovery: expect.any(Object), frontendReconnect: expect.any(Object) } } })
  f.observeStart()
  await f.inner.recoverStaleLifecycles()
  expect(f.inner.kernel.inspectCreation).toHaveBeenCalledWith(reservation!.operationId)
  await expectReplacementCanClose(f, f.client.agentSession('recipient'))
})

it.each([
  { origin: 'initialization' as const, loseStartReply: true },
  { origin: 'frontend' as const, loseStartReply: false }
])('Hosted recovery retains the accepted receipt after $origin post-commit observation failure', async ({ origin, loseStartReply }) => {
  const f = await replacementAfterInitialization(origin, loseStartReply)
  await f.inner.registry.update('recipient', f.original.expectedRun, (value: AgentMuxStoredAgentSession) => {
    const original = value.continuityOperations![f.original.operationId]!
    const operation = { ...original, supervision: { phase: 'observing' as const, activeAttemptOperationId: original.operationId,
      attemptCount: 1, attemptLimit: 3, observedAt: Date.now(), reason: 'start-pending' } }
    return { ...value, continuity: operation, continuityOperations: { ...value.continuityOperations, [operation.operationId]: operation } }
  })
  const hosted = new AgentMuxHostedRuntimeService(f.client, f.store.path, () => ({ runtimeId: 'initialization-runtime',
    ownerInstanceId: 'initialization-owner', protocolVersion: 2, processId: process.pid, ctxmux: f.client.runtimeIdentity(), availability: 'connected' }))
  cleanup.push(() => hosted.dispose())
  const socketPath = join(f.root, 'control.sock')
  const server = new AgentMuxControlServer({ socketPath, coreClients: f.coreClients, hostedRuntime: () => hosted })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
  const consumer = await connectHostedAgentMux({ rpc }); cleanup.push(() => consumer.dispose())
  if (loseStartReply) {
    expect((await consumer.ensureAgentContinuity(f.original)).kind).toBe('pending')
    expect((await f.store.readLifecycleReservation('recipient'))?.preparedSession).toBeDefined()
    f.observeStart()
  }
  const failure = new AgentMuxError('Original post-commit observation failed', 'TEST_OBSERVATION_UNAVAILABLE')
  if (loseStartReply) f.inner.ensureTerminalHandshakeOrDegrade.mockRejectedValueOnce(failure)
  else vi.spyOn(f.inner.recovery.reconciler, 'observeResumedInterruption').mockRejectedValueOnce(failure)
  const result = await consumer.ensureAgentContinuity(f.original)
  expect(result.kind).toBe('resumed')
  expect(result.continuity).toMatchObject({ errorCode: 'TEST_OBSERVATION_UNAVAILABLE', error: 'Original post-commit observation failed' })
  await expectReplacementCanClose(f, result)
})

it('skips initial-input history enumeration for a legacy actor while its original supervisor still observes', async () => {
  const f = await fixture({ resume: true, capability: false }), operation = await retainSupervisedFrontend(f)
  const counted = countHistoryEnumeration(f.inner.recovery, f.inner.registry.get('recipient'))
  f.inner.recovery.observe(counted.session)
  expect(counted.supervisorObserve.mock.calls.some(([value]) => value === counted.session)).toBe(true)
  await vi.waitFor(() => expect(f.inner.kernel.observeLifecycle).toHaveBeenCalledOnce())
  await vi.waitFor(async () => expect((await f.store.readMetadata('recipient'))!.continuityOperations![operation.operationId]!.supervision)
    .toMatchObject({ phase: 'observing', reason: 'frontend-attached', process: { run: f.original.expectedRun, state: 'running' } }))
  expect(counted.counts.initial, 'An ineligible initial-input observer must not enumerate this Session history').toBe(0)
  expect(f.reconnect).not.toHaveBeenCalled(); expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('skips initial-input history enumeration after dispose when a late Session observation arrives', async () => {
  const f = await fixture({ resume: true }); await retainSupervisedFrontend(f)
  const counted = countHistoryEnumeration(f.inner.recovery, f.inner.registry.get('recipient'))
  await f.inner.recovery.dispose()
  f.inner.recovery.observe(counted.session)
  expect(counted.counts.supervisor).toBe(0)
  expect(counted.counts.initial, 'A disposed initial-input observer must not enumerate this Session history').toBe(0)
  expect(f.inner.kernel.observeLifecycle).not.toHaveBeenCalled(); expect(f.reconnect).not.toHaveBeenCalled()
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('treats an omitted trigger as explicit manual recovery under a manual automatic policy', async () => {
  const f = await fixture()
  const result = await f.client.ensureAgentContinuity({ ...f.original, policy: { activeRecovery: 'manual' } })
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'reattachable', continuity: { operationId: f.original.operationId, reason: 'initialization-ready' } })
  expect(f.requests).toEqual([{ operationId: f.original.operationId, expectedFrontendId: 'original-frontend',
    target: { kind: 'initialization', lifecycleOperationId: f.actor.lifecycleOperationId } }])
  expect(f.client.agentSession('recipient').nativeHandle?.sessionId).toBe('original-native')
  expect(f.inner.queueNativeIdentityCapture).toHaveBeenCalledWith(expect.objectContaining({ nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' } }))
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('joins a fresh startup to missing initialization evidence without treating its running backend as ready', async () => {
  const f = await fixture({ missing: true })
  const first = await f.client.ensureAgentContinuity({ ...f.original, trigger: 'startup' })
  const second = await f.client.ensureAgentContinuity({ ...f.original, operationId: 'fresh-startup', trigger: 'startup' })
  expect(first).toMatchObject({ kind: 'pending', reason: 'provider-unverified' })
  expect(second).toMatchObject({ kind: 'pending', continuity: { operationId: f.original.operationId } })
  expect(f.reconnect).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.start).not.toHaveBeenCalled()
})

it('requires the original actor initialization capability before continuing a failed native bootstrap', async () => {
  const f = await fixture({ capability: false })
  expect(await f.client.ensureAgentContinuity(f.original)).toMatchObject({ kind: 'pending' })
  expect(f.reconnect).not.toHaveBeenCalled(); expect(f.client.agentSession('recipient').nativeHandle).toBeUndefined()
  expect(f.inner.kernel.start).not.toHaveBeenCalled()
})

it('continues the original managed resume preflight without treating its retained unknown native source as another creation', async () => {
  const f = await fixture({ resume: true })
  expect(await f.client.ensureAgentContinuity(f.original)).toMatchObject({ kind: 'reattachable' })
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].target).toEqual({ kind: 'initialization', lifecycleOperationId: f.actor.lifecycleOperationId })
  expect(f.client.agentSession('recipient').nativeHandle).toMatchObject({ providerId: 'codex', sessionId: 'original-native' })
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('persists a distinct native frontend suboperation when the original bootstrap becomes ready but its first TUI fails', async () => {
  const f = await fixture({ detached: true })
  const result = await f.client.ensureAgentContinuity(f.original)
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'reattachable', continuity: { operationId: f.original.operationId,
    initializationRecovery: { actorId: f.actor.actorId, lifecycleOperationId: f.actor.lifecycleOperationId },
    frontendReconnect: { frontendId: 'recovered-tui' } } })
  expect(f.requests).toHaveLength(2)
  expect(f.requests[0].target).toEqual({ kind: 'initialization', lifecycleOperationId: f.actor.lifecycleOperationId })
  expect(f.requests[1].operationId).not.toBe(f.requests[0].operationId)
  expect(f.requests[1].target).toEqual({ kind: 'native-session', nativeSessionId: 'original-native' })
  const saved = await f.store.readMetadata('recipient'), receipt = saved!.continuityOperations![f.original.operationId]!
  expect(receipt.frontendReconnect?.operationId).toBe(f.requests[1].operationId)
  expect(receipt.initializationRecovery?.observation.initialization?.phase).toBe('ready')
  expect(saved!.run).toEqual(f.original.expectedRun)
  await f.client.ensureAgentContinuity(f.original)
  expect(f.reconnect).toHaveBeenCalledTimes(2); expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('does not bind or dispatch from an old initialization reply after the original actor changes', async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), reply = Promise.withResolvers<any>()
  f.reconnect.mockImplementationOnce(async () => { entered.resolve(); return await reply.promise })
  const recovering = f.client.ensureAgentContinuity(f.original); await entered.promise
  await f.inner.registry.update('recipient', f.original.expectedRun, (value: AgentMuxStoredAgentSession) => ({ ...value,
    nativeActor: { ...f.actor, token: 'b'.repeat(64), launch: { command: 'codex', args: ['--new-owner'] } } }))
  reply.resolve({ frontendId: 'late', state: 'attached', backendState: 'running', source: 'managed-process', observedAt: 2,
    initialization: { lifecycleOperationId: f.actor.lifecycleOperationId, phase: 'ready', native: { state: 'confirmed', sessionId: 'old-actor-native' } } })
  expect(await recovering).toMatchObject({ kind: 'pending' })
  expect(f.client.agentSession('recipient').nativeHandle).toBeUndefined()
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})

it('records native admission on the original managed resume key without inventing a terminal or argv receipt', async () => {
  const f = await fixture({ resume: true }), provider = f.client.providers.get('codex')
  const run = f.original.expectedRun, previousRun = { runId: 'previous-ended-run' }
  f.watch.frontend = { ...f.watch.frontend!, state: 'attached', initialization: { lifecycleOperationId: f.actor.lifecycleOperationId,
    phase: 'ready', native: { state: 'confirmed', sessionId: 'original-native' } } }
  const operation: AgentMuxContinuityOperation = { operationId: 'original-managed-resume', agentSessionId: 'recipient', trigger: 'input',
    policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, previousRun, newRun: run, nativeTarget: { kind: 'provider', providerId: 'codex', sessionId: 'original-native' },
    admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'resumed', reason: 'explicit-request', evidence: { kind: 'run-ended', state: 'exited', observedAt: 1 } }
  operation.launchInput = prepareContinuityLaunchInput(operation, provider.catalog, f.actor.lifecycleOperationId,
    { submissionId: 'original-managed-input', prompt: 'The original resumed task.' })!
  operation.launchInput.delivery = 'post-launch'
  bindContinuityLaunchInput(operation, run)
  await f.inner.registry.update('recipient', run, (value: AgentMuxStoredAgentSession) => ({ ...value, retiredRuns: [previousRun],
    continuity: operation, continuityOperations: { [operation.operationId]: operation } }))
  const send = vi.fn(async () => ({ outcome: 'admitted' as const, turnId: 'original-native-turn' }))
  vi.spyOn(provider, 'prepareNativeInput').mockImplementation(async (_context, target) => ({
    plan: { kind: 'native-rpc', protocolId: f.actor.protocolId, actorId: f.actor.actorId, threadId: target.nativeSessionId,
      sourceId: JSON.stringify([target.providerId, target.nativeSessionId]), operation: 'start-or-steer' },
    assertCurrent: async () => {}, send, dispose: () => {}
  }))
  const request = { agentSessionId: 'recipient', expectedRun: previousRun, operationId: operation.operationId }
  expect(await f.client.ensureAgentContinuity(request)).toMatchObject({ kind: 'resumed' })
  expect((await f.store.readMetadata('recipient'))!.continuityOperations?.[operation.operationId]?.launchInput)
    .toMatchObject({ key: operation.launchInput.key, delivery: 'post-launch', state: 'native-admitted' })
  expect((await f.client.inspectAgentPromptSubmission(operation.launchInput.key!))?.admission)
    .toMatchObject({ inputKey: operation.launchInput.key, transport: 'native', acknowledged: true, native: { outcome: 'admitted' } })
  await f.client.ensureAgentContinuity(request)
  expect(send).toHaveBeenCalledOnce(); expect(f.inner.kernel.input).not.toHaveBeenCalled(); expect(f.inner.kernel.start).not.toHaveBeenCalled()
})


it.each(['same', 'foreign'] as const)('keeps a %s rich native binding when initialization only attests its protocol ID', async identity => {
  const f = await fixture({ resume: true })
  const handle = { kind: 'provider' as const, providerId: 'codex', sessionId: identity === 'same' ? 'original-native' : 'other-native',
    transcriptPath: f.root + '/original-native.jsonl' }
  const source = { state: 'unknown' as const, run: f.original.expectedRun, observedAt: Date.now(), reason: 'retained-record-observation' }
  await f.inner.registry.update('recipient', f.original.expectedRun, (value: AgentMuxStoredAgentSession) => ({ ...value,
    nativeHandle: handle, nativeSourceObservation: source, updatedAt: Math.max(value.updatedAt + 1, source.observedAt) }))
  const result = await f.client.ensureAgentContinuity(f.original)
  expect(result.kind).toBe(identity === 'same' ? 'reattachable' : 'pending')
  const saved = await f.store.readMetadata('recipient')
  expect(saved!.nativeHandle).toEqual(handle)
  expect(saved!.nativeSourceObservation).toEqual(source)
  expect(f.inner.kernel.start).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
})
