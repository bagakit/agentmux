import { AgentMuxFileAgentSessionStore } from '../../dist/index.js'
import { randomUUID } from 'node:crypto'

// Separate OS owners contend through the public durable Store, never a parent's in-memory tail.
const input = JSON.parse(process.argv[2])
const store = new AgentMuxFileAgentSessionStore(input.storePath)
const retirement = (await store.loadRetiredAgentSessions())[0]
const reservation = { kind: 'reopen', reservationId: randomUUID(), ownerId: randomUUID(), ownerPid: process.pid,
  agentSessionId: retirement.agentSessionId, operationId: input.operationId, expiresAt: Date.now() + 60_000,
  expectedRetirement: retirement }
process.send({ kind: 'ready', pid: process.pid })
process.once('message', async () => {
  try {
    await store.reserveLifecycle(reservation)
    process.send({ kind: 'reserved', pid: process.pid })
    process.once('message', async () => {
      try {
        await store.commitLifecycle(reservation, { ...input.old, run: { runId: input.operationId },
          retiredRuns: [retirement.run], reopenedFrom: { run: retirement.run, source: retirement.source, observedAt: retirement.observedAt } })
        process.send({ kind: 'committed', pid: process.pid })
      } catch (error) { process.send({ kind: 'error', code: error.code, message: error.message }) }
      process.disconnect()
    })
  } catch (error) { process.send({ kind: 'rejected', code: error.code, pid: process.pid }); process.disconnect() }
})
