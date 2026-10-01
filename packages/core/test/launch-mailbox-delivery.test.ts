import { fixturePath as upstreamFixturePath, fixtureDisplayPath as upstreamFixtureDisplayPath } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { composeAgentLaunchPrompt } from '../src/agent-outbound-message.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import { hashAgentCapability } from '../src/agent-capability.js'
import { AgentProviderRegistry } from '../src/agent-provider.js'
import type { AgentMuxAgentSession, AgentMuxClientEvent, AgentMuxStoredAgentSession } from '../src/types.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

it.each([['create', 'kimi'], ['resume', 'kimi'], ['create', 'claude'], ['resume', 'claude'], ['discuss', 'kimi'], ['discuss', 'claude']] as const)('%s %s records actual delivery and retains a healthy Run on uncertain input', async (operation, providerId) => {
  for (const confirmed of providerId === 'kimi' ? [false, true] : [true]) {
    const root = await mkdtemp(upstreamFixtureDisplayPath("tmp/amux-launch-mail-"))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
    vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
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
      hostId: 'local', workspacePath: upstreamFixturePath("repo"), run: { runId: 'old-run' }, retiredRuns: [],
      createdAt: 1, updatedAt: 1, hookBindingId: 'binding-old', hookToken: 'token-old', nativeHandle: { kind: 'provider', providerId, sessionId: 'native' } }
    if (operation !== 'create') await store.compareAndSwap(null, { ...old, capabilityHash: hashAgentCapability('valid-capability') })
    await internals.registry.load('local')
    internals.connected = true
    const run = (id: string): CtxmuxAdapterRun => ({ runId: id, lifecycleOperationId: null, program: providerId, args: [], workspacePath: upstreamFixturePath("repo"),
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
    internals.promptSubmission.submitInputPlan = async (current: AgentMuxAgentSession) => {
      submitted++
      // Completion must not become durable before the actual input result is known.
      expect((await store.loadTimeline(current.agentSessionId)).items).toEqual([])
      if (!confirmed) throw new Error('input receipt lost')
    }
    const errors: AgentMuxClientEvent[] = []
    client.onEvent((event) => { if (event.type === 'agent-error') errors.push(event) })
    try {
      const discussionInput = { callerAgentSessionId: 'mail-agent', capability: 'valid-capability', executorId: providerId,
        providerId, workspacePath: upstreamFixturePath("repo"), body: 'exact words', operationId: 'discussion-mail' }
      if (operation === 'discuss') {
        await expect(client.startDiscussion({ ...discussionInput, capability: 'forged' }))
          .rejects.toMatchObject({ code: 'AGENT_CAPABILITY_INVALID' })
        expect(submitted).toBe(0)
      }
      const discussion = operation === 'discuss' ? await client.startDiscussion(discussionInput) : undefined
      const result = discussion ? discussion.session : operation === 'create'
        ? await client.createAgent({ agentSessionId: 'mail-agent', executorId: providerId, providerId, workspacePath: upstreamFixturePath("repo"), prompt: 'exact words', injectAgentMuxGuide: false })
        : await client.resumeAgent({ agentSessionId: 'mail-agent', operationId: 'resume-mail', prompt: 'exact words' })
      if (discussion) {
        expect(discussion.thread.delivery.state).toBe(confirmed ? 'delivered' : 'queued')
        expect(discussion.thread.targetAgentSessionId).toBe(result.agentSessionId)
        expect(discussion.thread.messages.map(({ authorAgentSessionId }) => authorAgentSessionId)).toEqual(['mail-agent'])
      }
      expect(result.run.runId).toBe('new-run')
      expect(submitted).toBe(providerId === 'kimi' ? 1 : 0)
      expect(stop).not.toHaveBeenCalled()
      const recorded = (await store.loadTimeline(result.agentSessionId)).items
      expect(recorded.map(({ kind, source, content, status, authorAgentSessionId }) => ({ kind, source, content, status, authorAgentSessionId })))
        .toEqual([
          ...(operation === 'discuss' ? [{ kind: 'system_message', source: 'agentmux',
            content: composeAgentLaunchPrompt('exact words', true).systemContext,
            status: confirmed ? 'complete' : 'failed', authorAgentSessionId: undefined }] : []),
          { kind: 'user_message', source: 'user', content: operation === 'discuss' ? '[Message from Agent mail-agent]\nexact words' : 'exact words', status: confirmed ? 'complete' : 'failed',
            authorAgentSessionId: operation === 'discuss' ? 'mail-agent' : undefined }
        ])
      expect(errors).toHaveLength(confirmed ? 0 : 1)
      if (!confirmed) expect(errors[0]).toMatchObject({ message: expect.stringContaining('was not confirmed') })
      expect((await client.agentSession(result.agentSessionId)).run.runId).toBe('new-run')
    } finally { await client.dispose(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
  }
})
