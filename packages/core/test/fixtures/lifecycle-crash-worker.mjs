import {
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux
} from '@agentmux/core'

const fakeCodex = process.env.AGENTMUX_FAKE_CODEX
if (!fakeCodex) throw new Error('AGENTMUX_FAKE_CODEX is required.')

const delegate = new AgentMuxFileAgentSessionStore()
const store = {
  load: async () => await delegate.load(),
  loadRetiredRuns: async () => await delegate.loadRetiredRuns(),
  compareAndSwap: async (expected, next) => await delegate.compareAndSwap(expected, next),
  reserveLifecycle: async (reservation) => await delegate.reserveLifecycle(reservation),
  claimStaleLifecycles: async (claim) => await delegate.claimStaleLifecycles(claim),
  releaseLifecycle: async (reservation, runs) => await delegate.releaseLifecycle(reservation, runs),
  retireRuns: async (runs) => await delegate.retireRuns(runs),
  async commitLifecycle(reservation, next) {
    if (reservation.kind === 'create' && reservation.agentSessionId === 'crash-semantic') {
      process.stdout.write(`${JSON.stringify({
        type: 'run-started-before-commit',
        runId: next.run.runId
      })}\n`)
      await new Promise(() => {})
    }
    await delegate.commitLifecycle(reservation, next)
  }
}

const client = await connectLocalAgentMux({ store })
await client.createAgent({
  agentSessionId: 'crash-semantic',
  createOperationId: 'crash-after-run-start',
  agentId: 'codex',
  workspacePath: process.cwd(),
  prompt: 'crash-fixture',
  commandOverride: fakeCodex
})
