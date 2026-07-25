import { createInterface } from 'node:readline'
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
  loadRetiredAgentSessions: async () => await delegate.loadRetiredAgentSessions(),
  compareAndSwap: async (expected, next) => await delegate.compareAndSwap(expected, next),
  async reserveLifecycle(reservation) {
    await delegate.reserveLifecycle(reservation)
    if (reservation.kind === 'stop') {
      process.stdout.write(`${JSON.stringify({
        phase: 'stop-reserved',
        operation: reservation.stopOperation
      })}\n`)
    }
  },
  claimStaleLifecycles: async (claim) => await delegate.claimStaleLifecycles(claim),
  commitLifecycle: async (reservation, next) => await delegate.commitLifecycle(reservation, next),
  releaseLifecycle: async (reservation, runs) => await delegate.releaseLifecycle(reservation, runs),
  retireRuns: async (runs) => await delegate.retireRuns(runs),
  loadTimeline: async (agentSessionId) => await delegate.loadTimeline(agentSessionId),
  applyTimelineMutation: async (mutation, signal) => (
    await delegate.applyTimelineMutation(mutation, signal)
  )
}

const client = await connectLocalAgentMux({ store })
const session = await client.createAgent({
  agentSessionId: 'packed-stop-response-loss',
  createOperationId: 'packed-stop-response-loss-create',
  providerId: 'codex',
  executorId: 'codex',
  workspacePath: process.cwd(),
  prompt: 'wait for stop',
  commandOverride: fakeCodex
})
process.stdout.write(`${JSON.stringify({
  phase: 'ready',
  agentSessionId: session.agentSessionId,
  run: session.run
})}\n`)

const commands = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const command of commands) {
  if (command !== 'stop') throw new Error(`Unexpected Stop response-loss command: ${command}`)
  try {
    await client.stopAgent(session.agentSessionId, session.run)
    process.stdout.write(`${JSON.stringify({ phase: 'stop-result', ok: true })}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      phase: 'stop-result',
      ok: false,
      code: error && typeof error === 'object' && 'code' in error ? error.code : null,
      detail: error && typeof error === 'object' && 'detail' in error ? error.detail : null,
      message: error instanceof Error ? error.message : String(error)
    })}\n`)
  }
  await new Promise(() => {})
}
