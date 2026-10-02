// A fresh ordinary Node consumer re-reads the original private stores and public Core.
// This is not an Electron restart, a physical Terminal Writer or a second history reader.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  AgentMuxFileAgentSessionStore,
  AgentMuxSpatialStateStore,
  connectAgentMuxRpc,
  connectHostedAgentMux
} from '@agentmux/core'
import { summarizeRecoveryStorage } from '../../src/main/recovery-probe.ts'

const [socketPath, sessionPath, spatialPath, uiPath, stoppedId, healthyId] = process.argv.slice(2)
const store = new AgentMuxFileAgentSessionStore(sessionPath)
const retired = await store.loadRetiredAgentSessions()
const stopped = retired.find(item => item.agentSessionId === stoppedId)
assert.ok(stopped, 'The original stopped SID must exist in the original retired FileStore')
const spatial = await new AgentMuxSpatialStateStore(spatialPath).read()
assert.ok(spatial, 'The original spatial document must be nonempty')
const uiRaw = await readFile(uiPath, 'utf8')
const ui = JSON.parse(uiRaw).state
const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
const client = await connectHostedAgentMux({ rpc })
try {
  const history = (await client.sessionHistorySources()).find(item => item.agentSessionId === stoppedId)
  assert.equal(history?.state, 'retired')
  const page = await client.sessionHistoryPage(stoppedId, { limit: 30 })
  assert.ok(page.items.length > 0, 'The original public reader must still return retained history')
  const healthy = await client.statusAgent(healthyId)
  process.stdout.write(JSON.stringify({
    pid: process.pid,
    stopped: { agentSessionId: stopped.agentSessionId, run: stopped.run,
      observedAt: stopped.observedAt, history },
    page,
    spatial,
    ui,
    presentation: summarizeRecoveryStorage(uiRaw, spatial),
    healthy: { agentSessionId: healthy.session.agentSessionId,
      runId: healthy.run.runId, pid: healthy.run.pid, state: healthy.run.state }
  }) + '\n')
} finally {
  await client.dispose()
  await rpc.dispose()
}
