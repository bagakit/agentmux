import { describe, expect, it } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxAdapterRun } from '../src/ctxmux-run-adapter.js'

function terminalRun(runId: string): CtxmuxAdapterRun {
  return {
    runId,
    lifecycleOperationId: null,
    program: '/bin/sh',
    args: [],
    workspacePath: '/repo',
    pid: 42,
    state: { type: 'running' },
    cols: 80,
    rows: 24,
    latestOutputBytes: 12,
    firstAvailableByte: 0,
    acceptedInputBytes: 4
  }
}

describe('AgentMuxClient exact Runtime Subject projection', () => {
  it('projects one terminal from one status call without enumerating Runs', async () => {
    const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() })
    const internals = client as unknown as {
      kernel: { status: (runId: string) => Promise<CtxmuxAdapterRun>; list: () => Promise<CtxmuxAdapterRun[]>; isConnected: () => boolean }
      connected: boolean
    }
    let statusCalls = 0
    internals.kernel.status = async (runId) => {
      statusCalls += 1
      return terminalRun(runId)
    }
    internals.kernel.list = async () => {
      throw new Error('exact projection must not enumerate Runs')
    }
    internals.kernel.isConnected = () => true
    internals.connected = true
    try {
      await expect(client.runtimeSubject({ kind: 'terminal-run', runId: 'run-1' }))
        .resolves.toMatchObject({
          kind: 'terminal',
          subjectId: 'terminal:local:run-1',
          run: { runId: 'run-1', workspacePath: '/repo' }
        })
      expect(statusCalls).toBe(1)
    } finally {
      await client.dispose()
    }
  })
})
