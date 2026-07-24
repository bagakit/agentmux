import { access } from 'node:fs/promises'
import { AgentMuxFileAgentSessionStore } from '../../dist/agent-session-store.js'

const mode = process.env.AGENTMUX_STORE_WORKER_MODE
const storePath = process.env.AGENTMUX_STORE_PATH
const startPath = process.env.AGENTMUX_STORE_START_PATH
const workerId = process.env.AGENTMUX_STORE_WORKER_ID
if (!mode || !storePath || !startPath || !workerId) throw new Error('Store worker environment is incomplete.')

const waitForStart = async () => {
  for (;;) {
    try {
      await access(startPath)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

process.stdout.write(`${JSON.stringify({ type: 'ready', workerId })}\n`)
await waitForStart()

const store = new AgentMuxFileAgentSessionStore(storePath)
const expectedRun = { runId: 'original-run' }
const reservation = {
  reservationId: `${workerId}-reservation`,
  ownerId: `${workerId}-owner`,
  ownerPid: process.pid,
  kind: mode,
  agentSessionId: 'shared-semantic',
  operationId: `${workerId}-operation`,
  expiresAt: Date.now() + 30_000,
  ...(mode === 'create' ? {} : { expectedRun })
}

try {
  await store.reserveLifecycle(reservation)
  const run = { runId: `${mode}-${workerId}-run` }
  const current = mode === 'resume' ? (await store.load())[0] : null
  await store.commitLifecycle(reservation, {
    kind: 'agent',
    agentSessionId: 'shared-semantic',
    agentId: 'codex',
    hostId: 'local',
    workspacePath: '/private/tmp/store-race',
    run,
    retiredRuns: current ? [...current.retiredRuns, current.run].slice(-16) : [],
    hookBindingId: `${workerId}-binding`,
    hookToken: `${workerId}-token`,
    outputCursorBytes: 0,
    createdAt: current?.createdAt ?? 1,
    updatedAt: 2
  })
  process.stdout.write(`${JSON.stringify({ type: 'result', workerId, ok: true, runId: run.runId })}\n`)
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    type: 'result',
    workerId,
    ok: false,
    code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN',
    message: error instanceof Error ? error.message : String(error)
  })}\n`)
}
