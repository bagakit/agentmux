import { afterEach, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import type { AgentTerminalFrontend } from '../src/agent-terminal-frontend.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY, type AgentMuxContinuityOperation } from '../src/agent-session-recovery.js'
import { prepareContinuityLaunchInput, bindContinuityLaunchInput } from '../src/agent-session-recovery/input.js'

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

it('treats an omitted trigger as explicit manual recovery under a manual automatic policy', async () => {
  const f = await fixture()
  const result = await f.client.ensureAgentContinuity({ ...f.original, policy: { activeRecovery: 'manual' } })
  expect(result, JSON.stringify(result)).toMatchObject({ kind: 'reattachable', continuity: { operationId: f.original.operationId, reason: 'initialization-ready' } })
  expect(f.requests).toEqual([{ operationId: f.original.operationId, expectedFrontendId: 'original-frontend',
    target: { kind: 'initialization', lifecycleOperationId: f.actor.lifecycleOperationId } }])
  expect(f.client.agentSession('recipient').nativeHandle?.sessionId).toBe('original-native')
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
