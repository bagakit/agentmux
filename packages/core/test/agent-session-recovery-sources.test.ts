import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentContinuityAdmission, normalizeAgentContinuityPolicy, parseAgentContinuityTrigger,
  type AgentMuxAgentContinuityInput, type AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { AgentSessionContinuitySupervisor } from '../src/agent-session-recovery/supervisor.js'
import { parseRpcAgentSession } from '../src/rpc-native-codec.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'

const historicalSources = ['archived-view-open', 'retained-surface-startup']
const automaticSources = [...historicalSources, 'workspace-startup', 'workspace-open', 'host-restored']
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})

it('preserves machine labels verbatim and rejects malformed source packets', () => {
  for (const source of ['manual', 'input', 'startup', ...automaticSources, ' original-source ', '界'.repeat(170), 'x'.repeat(512)]) {
    expect(parseAgentContinuityTrigger(source)).toBe(source)
  }
  for (const source of [undefined, null, {}, [], 1, '', '   ', '界'.repeat(171), 'x'.repeat(513),
    ...Array.from({ length: 32 }, (_, code) => 'source' + String.fromCharCode(code)), 'source\u007f']) {
    expect(() => parseAgentContinuityTrigger(source)).toThrow(expect.objectContaining({ code: 'INVALID_AGENT_CONTINUITY_TRIGGER' }))
  }
})

it.each(historicalSources)('reloads and publicly rejoins the original %s intent without rewriting source, budget or unknown input', async trigger => {
  const f = await rpcOwnerFixture(['original']); cleanups.push(f.close)
  const before = (await f.store.readMetadata('original'))!
  const operation: AgentMuxContinuityOperation = {
    operationId: 'retained-recovery', agentSessionId: before.agentSessionId, trigger, previousRun: before.run,
    policy: normalizeAgentContinuityPolicy({ retryMaxAttempts: 2, recheckMaxAttempts: 0 }),
    admittedAt: 1, observedAt: 1, rechecks: 0, kind: 'pending', reason: 'runtime-unverified',
    evidence: { kind: 'run-unknown', observedAt: 1, message: 'Original observation is unknown.' },
    supervision: { phase: 'cancelled', activeAttemptOperationId: 'retained-recovery', attemptCount: 1,
      attemptLimit: 3, observedAt: 1, reason: 'explicit-cancel' }
  }
  const key = { kind: 'prompt' as const, agentSessionId: before.agentSessionId, expectedRun: before.run, submissionId: 'original-unknown-input' }
  const admission: NonNullable<AgentMuxStoredAgentSession['promptCompletionAdmission']> = {
    inputKey: key, submissionId: key.submissionId, operationId: 'original-byte-claim', startByte: 0, endByte: 7, acknowledged: false,
    intent: { run: before.run, ownerInstanceId: 'original-input-owner', prompt: 'fixture', plan: { kind: 'single-phase', data: 'fixture' } }
  }
  await f.store.compareAndSwap(before, { ...before, continuity: operation, continuityOperations: { [operation.operationId]: operation }, promptCompletionAdmission: admission })
  await f.client.dispose()
  const store = new AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json'))
  const client = new AgentMuxClient({ store }); cleanups.push(() => client.dispose())
  const inner = client as unknown as { connected: boolean; registry: { load(host: string): Promise<void> }; kernel: Record<string, unknown> }
  await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => true
  inner.kernel.status = vi.fn(async (id: string) => f.run(id)); inner.kernel.list = vi.fn(async () => [f.run(before.run.runId)])
  inner.kernel.identity = f.inner.kernel.identity
  const start = vi.fn(async () => { throw new Error('Unexpected replacement Run') }), input = vi.fn(async () => { throw new Error('Unexpected input replay') })
  inner.kernel.start = start; inner.kernel.input = input
  const probe = vi.spyOn(client as unknown as { probePreparedAgent: typeof client.probeAgent }, 'probePreparedAgent').mockRejectedValue(new Error('Unexpected executable probe'))
  const originalInput = { agentSessionId: before.agentSessionId, run: before.run, admission }
  expect(await client.inspectAgentPromptSubmission(key)).toEqual(originalInput)
  expect(parseRpcAgentSession(client.agentSession(before.agentSessionId)).continuity).toEqual(operation)
  const hosted = await hostedTestClient(client); cleanups.push(hosted.dispose)
  expect((await hosted.sdk.readAgentSession(before.agentSessionId))?.continuity).toEqual(operation)
  const request: AgentMuxAgentContinuityInput = { agentSessionId: before.agentSessionId, expectedRun: before.run,
    operationId: 'fresh-observer', trigger: 'workspace-startup', policy: { retryMaxAttempts: 20 } }
  await expect(hosted.sdk.ensureAgentContinuity(request)).resolves.toMatchObject({ kind: 'reattachable', previousRun: before.run,
    run: { runId: before.run.runId }, continuity: operation })
  const saved = (await store.readMetadata(before.agentSessionId))!
  expect(saved.run).toEqual(before.run); expect(saved.continuityOperations).toEqual({ [operation.operationId]: operation })
  expect(saved.continuity).toEqual(operation); expect(saved.promptCompletionAdmission).toEqual(admission)
  expect(await hosted.sdk.inspectAgentPromptSubmission(key)).toEqual(originalInput)
  expect(start).not.toHaveBeenCalled(); expect(input).not.toHaveBeenCalled(); expect(probe).not.toHaveBeenCalled()
})

it('keeps explicit admission exclusive to the exact manual and input tags', async () => {
  const f = await rpcOwnerFixture(['original']); cleanups.push(f.close)
  const session = f.client.agentSession('original'), policy = normalizeAgentContinuityPolicy({ resumeAfterExit: false })
  for (const trigger of ['manual', 'input']) expect(agentContinuityAdmission({ session, trigger, policy, admittedAt: 1, now: 1 })).toMatchObject({ kind: 'resume', reason: 'explicit-request' })
  for (const trigger of ['startup', ...automaticSources, 'manual-copy', ' input ']) {
    expect(agentContinuityAdmission({ session, trigger, policy, admittedAt: 1, now: 1 })).toEqual({ kind: 'pending', reason: 'resume-disabled' })
  }
})

it.each(['active-manual', 'frontend-retry-budget-exhausted'])('grants the %s reset exception only to exact startup', async reason => {
  const f = await rpcOwnerFixture(['original']); cleanups.push(f.close)
  const before = (await f.store.readMetadata('original'))!, frontend = reason === 'frontend-retry-budget-exhausted'
  const operation: AgentMuxContinuityOperation = {
    operationId: 'original-intent', agentSessionId: before.agentSessionId, trigger: historicalSources[0]!, previousRun: before.run,
    policy: normalizeAgentContinuityPolicy({ activeRecovery: 'manual' }), admittedAt: 1, observedAt: 1, rechecks: 0,
    kind: frontend ? 'reattachable' : 'pending', reason: frontend ? 'run-running' : reason,
    evidence: { kind: 'run-running', observedAt: 1 },
    ...(frontend ? { frontendReconnect: { previousFrontendId: 'original-frontend', frontendId: 'confirmed-frontend', outputAfterByte: 0 } } : {}),
    supervision: { phase: 'paused', activeAttemptOperationId: 'original-intent', attemptCount: frontend ? 1 : 0,
      attemptLimit: 1, reason, observedAt: 1 }
  }
  const session = { ...before, continuity: operation, continuityOperations: { [operation.operationId]: operation } }
  const unexpected = async (): Promise<never> => { throw new Error('No execution is needed to select the retained intent') }
  const supervisor = new AgentSessionContinuitySupervisor({ read: unexpected, lifecycle: unexpected, status: unexpected,
    watch: unexpected, update: unexpected, perform: unexpected, failed: () => { throw new Error('Unexpected supervisor action') } })
  cleanups.push(() => supervisor.dispose())
  const request = { agentSessionId: before.agentSessionId, expectedRun: before.run, operationId: 'fresh-observer', policy: { activeRecovery: 'automatic' as const } }
  expect(supervisor.retainedAutomaticIntent(session, { ...request, trigger: 'startup' })).toBeUndefined()
  for (const trigger of automaticSources) expect(supervisor.retainedAutomaticIntent(session, { ...request, trigger })).toBe(operation)
  const cancelled = { ...operation, supervision: { ...operation.supervision!, phase: 'cancelled' as const } }
  expect(supervisor.retainedAutomaticIntent({ ...session, continuity: cancelled, continuityOperations: { [cancelled.operationId]: cancelled } },
    { ...request, trigger: 'startup' })).toBe(cancelled)
})

it('rejects malformed recovery sources at the public owner while unrelated healthy raw input remains available', async () => {
  const f = await rpcOwnerFixture(['original']); cleanups.push(f.close)
  const session = f.client.agentSession('original'), status = f.inner.kernel.status, start = vi.fn()
  f.inner.kernel.start = start
  for (const trigger of [null, {}, '', 'source\tother']) {
    await expect(f.client.ensureAgentContinuity({ agentSessionId: session.agentSessionId, expectedRun: session.run,
      operationId: 'invalid-source', trigger } as AgentMuxAgentContinuityInput)).rejects.toMatchObject({ code: 'INVALID_AGENT_CONTINUITY_TRIGGER' })
  }
  expect(status).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
  expect((await f.store.readMetadata(session.agentSessionId))?.continuityOperations).toBeUndefined()
  await expect(f.client.writeAgent({ agentSessionId: session.agentSessionId, expectedRun: session.run, data: 'healthy raw input', source: 'user' })).resolves.toMatchObject({ runId: session.run.runId })
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled()
})
