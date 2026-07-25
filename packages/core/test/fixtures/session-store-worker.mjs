import { access } from 'node:fs/promises'
import { AgentMuxFileAgentSessionStore } from '../../dist/agent-session-store.js'

const mode = process.env.AGENTMUX_STORE_WORKER_MODE
const storePath = process.env.AGENTMUX_STORE_PATH
const startPath = process.env.AGENTMUX_STORE_START_PATH
const workerId = process.env.AGENTMUX_STORE_WORKER_ID
const scenario = process.env.AGENTMUX_STORE_WORKER_SCENARIO
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

const writeMessage = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}
const readyMessage = { type: 'ready', workerId }
const scenarioResult = mode === 'timeline'
  ? { type: 'result', workerId, ok: true, revision: 1, changed: true }
  : { type: 'result', workerId, ok: true, runId: `${mode}-${workerId}-run` }

if (scenario === 'exit-before-ready') {
  process.exitCode = 17
} else if (scenario === 'hang-after-ready') {
  writeMessage(readyMessage)
  await new Promise(() => { setInterval(() => {}, 1_000) })
} else if (scenario === 'malformed-after-ready') {
  writeMessage(readyMessage)
  process.stdout.write('{"type":\n')
} else if (scenario === 'trailing-after-result') {
  writeMessage(readyMessage)
  writeMessage(scenarioResult)
  process.stdout.write('trailing')
} else {
  if (scenario) throw new Error(`Unknown Store worker scenario: ${scenario}`)
  writeMessage(readyMessage)
  await waitForStart()

  const store = new AgentMuxFileAgentSessionStore(storePath)
  const expectedRun = { runId: 'original-run' }

  try {
    if (mode === 'timeline') {
      const commit = await store.applyTimelineMutation({
        type: 'append',
        agentSessionId: 'shared-semantic',
        item: {
          id: `activity-${workerId}`,
          agentSessionId: 'shared-semantic',
          kind: 'assistant_message',
          status: 'complete',
          source: 'acp',
          createdAt: 1,
          updatedAt: 1,
          title: `Activity ${workerId}`
        }
      })
      writeMessage({
        type: 'result',
        workerId,
        ok: true,
        revision: commit.revision,
        changed: commit.changed
      })
    } else {
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
      await store.reserveLifecycle(reservation)
      const run = { runId: `${mode}-${workerId}-run` }
      const current = mode === 'resume' ? (await store.load())[0] : null
      await store.commitLifecycle(reservation, {
        kind: 'agent',
        agentSessionId: 'shared-semantic',
        providerId: 'codex',
        executorId: 'codex',
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
      writeMessage({ type: 'result', workerId, ok: true, runId: run.runId })
    }
  } catch (error) {
    writeMessage({
      type: 'result',
      workerId,
      ok: false,
      code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error)
    })
  }
}
