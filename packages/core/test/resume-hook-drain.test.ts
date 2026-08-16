import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import { AgentHookServer } from '../src/hook-server.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession, NativeHookEnvelope } from '../src/types.js'

// Real Hook ingress and Core lifecycle; only process and Provider seams are replaced.
it('resumes the original Agent after an old Hook times out without waiting for its stalled read', async () => {
  const current: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'review-agent', providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: '/review-fixture', run: { runId: 'old-run' }, retiredRuns: [],
    hookBindingId: 'review-binding'.padEnd(43, 'A'), hookToken: 'review-token'.padEnd(43, 'B'),
    outputCursorBytes: 0, createdAt: 1, updatedAt: 1,
    promptCompletionAdmission: { submissionId: 'old-prompt',
      operationId: 'old-input', startByte: 0, endByte: 5 },
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'review-native' }
  }
  const ended: CtxmuxAdapterRun = {
    runId: 'old-run', lifecycleOperationId: null, program: 'claude', args: [],
    workspacePath: current.workspacePath, pid: null,
    state: { type: 'interrupted', reason: 'daemon_restart' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0
  }
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, current)
  const reserve = vi.spyOn(store, 'reserveLifecycle')
  const release = vi.spyOn(store, 'releaseLifecycle')
  const client = new AgentMuxClient({ store })
  const inner = client as unknown as {
    registry: { load(hostId: string): Promise<void> }
    connected: boolean
    kernel: Record<string, unknown>
    hookServer: AgentHookServer
    hookBindings: Map<string, ReturnType<AgentHookServer['createBinding']>>
    probeAgent: unknown
    ensureManagedHooks: unknown
    acceptHookEvent(event: NativeHookEnvelope, signal: AbortSignal): Promise<void>
  }
  await inner.registry.load('local')
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.identity = () => ({ daemonInstanceId: 'review-daemon', protocolVersion: 1, buildIdentity: 'review' })
  let releaseStatus!: (run: CtxmuxAdapterRun) => void
  let statusStarted!: () => void
  const firstStatus = new Promise<CtxmuxAdapterRun>((resolve) => { releaseStatus = resolve })
  const started = new Promise<void>((resolve) => { statusStarted = resolve })
  let statusCalls = 0
  inner.kernel.status = async () => {
    statusCalls++
    if (statusCalls === 1) {
      statusStarted()
      return await firstStatus
    }
    return ended
  }
  const startRun = vi.fn(async () => ({
    ...ended, runId: 'new-run', pid: 42, state: { type: 'running' as const }
  }))
  inner.kernel.start = startRun
  inner.probeAgent = async () => ({ providerId: 'claude', executable: 'claude', installed: true,
    capabilities: new AgentProviderRegistry().get('claude').catalog.capabilities })
  inner.ensureManagedHooks = async () => {}
  let hookAborted = false
  const server = new AgentHookServer(async (event, signal) => {
    signal.addEventListener('abort', () => { hookAborted = true }, { once: true })
    await inner.acceptHookEvent(event, signal)
  }, 0)
  inner.hookServer = server
  await server.start()
  const binding = server.createBinding(current.agentSessionId, current.providerId, current.hookBindingId, current.hookToken)
  await binding.bindRun('old-run')
  inner.hookBindings.set('old-run', binding)
  let resume: Promise<unknown> | undefined
  let resumeSettled = false
  try {
    const response = fetch(binding.endpoint.url, { method: 'POST', headers: {
      authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json'
    }, body: JSON.stringify({ receiptId: 'review-stop', eventName: 'Stop', payload: { session_id: 'review-native' } }) })
    await started
    resume = client.resumeAgent({ agentSessionId: current.agentSessionId, operationId: 'review-resume', prompt: 'review fixture' })
      .then((value) => { resumeSettled = true; return value }, (error) => { resumeSettled = true; return error })
    expect((await response).status).toBe(503)
    expect(hookAborted).toBe(true)
    await vi.waitFor(() => expect(resumeSettled).toBe(true), { timeout: 300 })
    expect(startRun).toHaveBeenCalledOnce()
    expect(reserve).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(await resume).toMatchObject({
      agentSessionId: current.agentSessionId,
      nativeHandle: current.nativeHandle,
      run: { runId: 'new-run' }
    })
    // A late read result cannot resurrect the old Run's semantic state or receipt.
    releaseStatus(ended)
    await new Promise((resolve) => setImmediate(resolve))
    const restored = (await store.load())[0]
    expect(restored).toMatchObject({ run: { runId: 'new-run' } })
    expect(restored).not.toHaveProperty('promptCompletionAdmission')
    expect(restored).not.toHaveProperty('hookReceipt')
    expect(restored).not.toHaveProperty('semanticStatus')
  } finally {
    releaseStatus(ended)
    await resume
    await client.dispose()
  }
}, 6_000)
