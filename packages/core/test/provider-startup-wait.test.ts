import { afterEach, expect, it, vi } from 'vitest'
import { defineAgentProvider } from '../src/agent-provider.js'
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '../src/agent-session-recovery/continuity-contract.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const plainProvider = () => defineAgentProvider({ catalog: { id: 'plain-pty', label: 'Plain PTY', executable: 'plain-pty', expectedProcess: 'plain-pty',
    promptDelivery: 'post-launch-only', readySignal: { kind: 'foreground-process', expectedProcess: 'plain-pty' },
    hookStrategy: { kind: 'none' }, resumeStrategy: { kind: 'provider-native', locator: 'session-id' }, acpStrategy: { kind: 'none' },
    capabilities: { terminal: true, timeline: 'unavailable', permission: 'none', providerResume: true, replyCorrelation: 'none' } },
    buildArgs: (_prompt, args) => [...args], buildResumeArgs: (id, _path, _prompt, args) => [...args, id], hook: { rules: [] } })

it.each(['create', 'resume'] as const)('delivers original conversation input once on a %s Run for a Provider without native startup semantics', async lifecycle => {
  const provider = plainProvider()
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: provider.id, executorId: provider.id }), () => ({ providers: [provider] }))
  try {
    const current = (await f.store.readMetadata('recipient'))!, at = current.updatedAt + 1
    await f.store.compareAndSwapMetadata(current, { ...current, updatedAt: at,
      ...(lifecycle === 'create' ? { creation: { createOperationId: 'original-create', createdRun: current.run, initialPrompt: 'not-requested' as const } }
        : { continuity: { operationId: 'original-resume', agentSessionId: current.agentSessionId, trigger: 'manual' as const,
          policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY }, reason: 'original-native-context' as const, admittedAt: at, observedAt: at,
          rechecks: 0, kind: 'resumed' as const, previousRun: { runId: 'previous-run' }, newRun: current.run,
          nativeTarget: { kind: 'provider' as const, providerId: provider.id, sessionId: 'original-native' }, evidence: { kind: 'run-running' as const, observedAt: at } } }) })
    await f.inner.registry.refresh(current.agentSessionId, current.run)
    const input = { agentSessionId: current.agentSessionId, expectedRun: current.run, operationId: 'original-conversation-input',
      prompt: 'Original plain Provider question', admissionIntent: { kind: 'session-conversation' as const }, execution: 'immediate' as const, authorHuman: true }
    await f.client.submitAgentPrompt(input)
    const key = { kind: 'prompt' as const, agentSessionId: current.agentSessionId, expectedRun: current.run, submissionId: input.operationId }
    await vi.waitFor(async () => expect((await f.client.inspectAgentPromptSubmission(key))?.admission?.acknowledged).toBe(true))
    const semanticInput = f.inner.kernel.input as ReturnType<typeof vi.fn>
    const writes = f.rawInput.mock.calls.length + semanticInput.mock.calls.length
    await f.client.submitAgentPrompt(input)
    expect(f.rawInput.mock.calls.length + semanticInput.mock.calls.length).toBe(writes)
    const payloads = [...f.rawInput.mock.calls.map(call => call[1]), ...semanticInput.mock.calls.map(call => call[1].data)]
    const written = payloads.map(data => typeof data === 'string' ? data : Buffer.from(data).toString('utf8')).join('')
    expect(written.split(input.prompt)).toHaveLength(2)
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    expect((await f.store.readMetadata(current.agentSessionId))!.run).toEqual(current.run)
  } finally { await f.close() }
})

it('retains input for the original actor initialization even when the Provider contributes only PTY', async () => {
  const provider = plainProvider()
  const f = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: provider.id, executorId: provider.id }), () => ({ providers: [provider] }))
  try {
    const current = (await f.store.readMetadata('recipient'))!, nativeActor = { protocolId: 'original-actor-protocol', actorId: 'original-actor',
      lifecycleOperationId: 'original-create', token: 'a'.repeat(64), frontendControl: true as const, initializationControl: true as const,
      launch: { command: 'plain-pty', args: [] } }
    await f.store.compareAndSwapMetadata(current, { ...current, nativeActor,
      creation: { createOperationId: 'original-create', createdRun: current.run, initialPrompt: 'not-requested' }, updatedAt: current.updatedAt + 1 })
    await f.inner.registry.refresh(current.agentSessionId, current.run)
    const input = { agentSessionId: current.agentSessionId, expectedRun: current.run, operationId: 'actor-pending-original-input',
      prompt: 'Keep this original actor input', admissionIntent: { kind: 'session-conversation' as const }, execution: 'immediate' as const, authorHuman: true }
    await f.client.submitAgentPrompt(input)
    const key = { kind: 'prompt' as const, agentSessionId: current.agentSessionId, expectedRun: current.run, submissionId: input.operationId }
    await vi.waitFor(async () => expect((await f.client.inspectAgentInput({ key }))?.control.waiting).toMatchObject({ reason: 'native-session-starting' }))
    expect(f.rawInput).not.toHaveBeenCalled(); expect(f.inner.kernel.input).not.toHaveBeenCalled()
    expect(await f.client.inspectAgentPromptSubmission(key)).toBeNull()
    expect((await f.store.readMetadata(current.agentSessionId))!.nativeActor).toEqual(nativeActor)
  } finally { await f.close() }
})
