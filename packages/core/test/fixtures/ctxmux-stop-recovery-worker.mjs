import {
  AgentMuxFileAgentSessionStore,
  connectLocalAgentMux
} from '@agentmux/core'

const delegate = new AgentMuxFileAgentSessionStore()
let claimedStopOperation = null
const store = {
  load: async () => await delegate.load(),
  loadRetiredRuns: async () => await delegate.loadRetiredRuns(),
  loadRetiredAgentSessions: async () => await delegate.loadRetiredAgentSessions(),
  compareAndSwap: async (expected, next) => await delegate.compareAndSwap(expected, next),
  reserveLifecycle: async (reservation) => await delegate.reserveLifecycle(reservation),
  async claimStaleLifecycles(claim) {
    const reservations = await delegate.claimStaleLifecycles(claim)
    const stop = reservations.find((reservation) => reservation.kind === 'stop')
    if (stop) claimedStopOperation = stop.stopOperation
    return reservations
  },
  commitLifecycle: async (reservation, next) => await delegate.commitLifecycle(reservation, next),
  releaseLifecycle: async (reservation, runs) => await delegate.releaseLifecycle(reservation, runs),
  retireRuns: async (runs) => await delegate.retireRuns(runs),
  loadTimeline: async (agentSessionId) => await delegate.loadTimeline(agentSessionId),
  applyTimelineMutation: async (mutation, signal) => (
    await delegate.applyTimelineMutation(mutation, signal)
  )
}

const client = await connectLocalAgentMux({ store })
try {
  const runId = claimedStopOperation?.runId ?? null
  const recoveredRun = runId === null
    ? null
    : (await client.listRuns()).find((run) => run.runId === runId) ?? null
  process.stdout.write(`${JSON.stringify({
    phase: 'recovered',
    operation: claimedStopOperation,
    agentSessions: client.agentSessions(),
    recoveredRun
  })}\n`)
} finally {
  await client.dispose()
}
