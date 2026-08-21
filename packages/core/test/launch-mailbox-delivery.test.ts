import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

it.each([['create', 'kimi'], ['resume', 'kimi'], ['create', 'claude'], ['resume', 'claude']] as const)('%s %s records actual delivery and retains a healthy Run on uncertain input', async (operation, providerId) => {
  for (const confirmed of providerId === 'kimi' ? [false, true] : [true]) {
    const store = new AgentMuxMemoryAgentSessionStore()
    const client = new AgentMuxClient({ store })
    const internals = client as unknown as {
      connected: boolean; kernel: Record<string, unknown>; hookServer: Record<string, unknown>
      registry: { load(hostId: string): Promise<void> }
      probeAgent: unknown; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown
      promptSubmission: { submitInputPlan: unknown }
    }
    const provider = new AgentProviderRegistry().get(providerId)
    const old: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: 'mail-agent', providerId, executorId: providerId,
      hostId: 'local', workspacePath: '/repo', run: { runId: 'old-run' }, retiredRuns: [], outputCursorBytes: 0,
      createdAt: 1, updatedAt: 1, hookBindingId: 'binding-old', hookToken: 'token-old', nativeHandle: { kind: 'provider', providerId, sessionId: 'native' } }
    if (operation === 'resume') await store.compareAndSwap(null, old)
    await internals.registry.load('local')
    internals.connected = true
    const run = (id: string): CtxmuxAdapterRun => ({ runId: id, lifecycleOperationId: null, program: providerId, args: [], workspacePath: '/repo',
      pid: 123, state: id === 'old-run' ? { type: 'exited', code: 0, signal: null } : { type: 'running' },
      cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
    internals.kernel.isConnected = () => true
    internals.kernel.identity = () => ({ daemonInstanceId: 'test', protocolVersion: 1, buildIdentity: 'test' })
    internals.kernel.status = async (id: string) => run(id)
    internals.kernel.start = async () => run('new-run')
    const stop = vi.fn()
    internals.kernel.stop = stop
    internals.hookServer.isRunning = () => true
    internals.hookServer.createBinding = () => ({ bindingId: 'binding'.padEnd(43, 'b'),
      endpoint: { url: 'http://127.0.0.1:0', token: 'token'.padEnd(43, 't') }, bindRun: async () => {}, close: async () => {} })
    internals.probeAgent = async () => ({ providerId, executable: providerId, installed: true, capabilities: provider.catalog.capabilities })
    internals.ensureManagedHooks = async () => {}
    internals.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
    let submitted = 0
    internals.promptSubmission.submitInputPlan = async () => {
      submitted++
      // Completion must not become durable before the actual input result is known.
      expect((await store.loadTimeline('mail-agent')).items).toEqual([])
      if (!confirmed) throw new Error('input receipt lost')
    }
    const errors: AgentMuxClientEvent[] = []
    client.onEvent((event) => { if (event.type === 'agent-error') errors.push(event) })
    try {
      const result = operation === 'create'
        ? await client.createAgent({ agentSessionId: 'mail-agent', executorId: providerId, providerId, workspacePath: '/repo', prompt: 'exact words', injectAgentMuxGuide: false })
        : await client.resumeAgent({ agentSessionId: 'mail-agent', operationId: 'resume-mail', prompt: 'exact words' })
      expect(result.run.runId).toBe('new-run')
      expect(submitted).toBe(providerId === 'kimi' ? 1 : 0)
      expect(stop).not.toHaveBeenCalled()
      expect((await store.loadTimeline('mail-agent')).items.map(({ content, status }) => ({ content, status })))
        .toEqual([{ content: 'exact words', status: confirmed ? 'complete' : 'failed' }])
      expect(errors).toHaveLength(confirmed ? 0 : 1)
      if (!confirmed) expect(errors[0]).toMatchObject({ message: expect.stringContaining('was not confirmed') })
      expect((await client.agentSession('mail-agent')).run.runId).toBe('new-run')
    } finally { await client.dispose() }
  }
})
