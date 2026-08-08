import { describe, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterExitEvent } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

const RUN_ID = 'ended-readiness-run'
const SESSION_ID = 'ended-readiness-agent'

function stored(): AgentMuxStoredAgentSession {
  return {
    kind: 'agent',
    agentSessionId: SESSION_ID,
    providerId: 'codex',
    executorId: 'codex',
    hostId: 'local',
    workspacePath: '/repo',
    run: { runId: RUN_ID },
    retiredRuns: [],
    hookBindingId: 'binding',
    hookToken: 'token',
    outputCursorBytes: 0,
    terminalPromptReadiness: {
      source: 'initial-composer',
      id: 'pending-epoch',
      run: { runId: RUN_ID },
      outputCursorBytes: 0
    },
    createdAt: 1,
    updatedAt: 1
  }
}

describe('prompt readiness lifecycle cleanup', () => {
  it('clears pending readiness when the exact Run exits', async () => {
    const store = new AgentMuxMemoryAgentSessionStore()
    await store.compareAndSwap(null, stored())
    const client = new AgentMuxClient({ store })
    const internals = client as unknown as {
      registry: { load(hostId: string): Promise<void> }
      acceptKernelEvent(event: CtxmuxAdapterExitEvent): void
    }
    await internals.registry.load('local')

    internals.acceptKernelEvent({
      type: 'exit',
      runId: RUN_ID,
      state: { type: 'exited', code: 0, signal: null },
      observedAt: 10
    })

    await vi.waitFor(async () => {
      const [session] = await store.load() as AgentMuxStoredAgentSession[]
      expect(session?.terminalPromptReadiness).toBeUndefined()
    })
    await client.dispose()
  })
})
