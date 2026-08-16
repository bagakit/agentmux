import { expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

it('Core status observes the ended Run instead of reusing a stale working hook', async () => {
  const stored: AgentMuxStoredAgentSession = {
    kind: 'agent', agentSessionId: 'status-agent', providerId: 'claude', executorId: 'claude',
    hostId: 'local', workspacePath: '/fixture', run: { runId: 'status-run' }, retiredRuns: [],
    hookBindingId: 'binding', hookToken: 'token', outputCursorBytes: 0, createdAt: 1, updatedAt: 1,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 }
  }
  const run: CtxmuxAdapterRun = {
    runId: 'status-run', lifecycleOperationId: null, program: 'claude', args: [], workspacePath: '/fixture', pid: null,
    state: { type: 'interrupted', reason: 'daemon_restart' }, cols: 80, rows: 24,
    latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0
  }
  const store = new AgentMuxMemoryAgentSessionStore()
  await store.compareAndSwap(null, stored)
  const client = new AgentMuxClient({ store })
  const inner = client as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown> }
  await inner.registry.load('local')
  inner.connected = true
  inner.kernel.isConnected = () => true
  inner.kernel.status = async () => run
  try {
    const status = await client.statusAgent(stored.agentSessionId)
    expect(status.run).toMatchObject({ state: 'interrupted', interruptionReason: 'daemon_restart' })
    expect(status.observation).toMatchObject({ process: 'interrupted', semantic: 'unknown', readiness: 'unknown', source: 'run-process' })
  } finally {
    await client.dispose()
  }
})
