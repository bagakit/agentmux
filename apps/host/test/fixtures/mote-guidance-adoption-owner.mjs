// A private OS owner around the real Core/Host persistence. Runtime I/O is a
// deterministic boundary: this process has no input writer or model executable.
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, spatialCatalog } from '../../../../packages/core/src/index.ts'
import { ContinuousProgressLoopManager } from '../../src/continuous-progress-loop-manager.ts'
import { ContinuousProgressLoopStore } from '../../src/continuous-progress-loop-store.ts'
import { createGoalRuntime } from '../../src/goal-runtime.ts'
import { createHostContent } from '../../src/content-owner.ts'
import { createHostMoteMainReader } from '../../src/mote-dialogue.ts'
import { createHostMotePresence } from '../../src/mote-presence.ts'
import { HostMoteQuickPreferences } from '../../src/mote-quick-preferences.ts'
const { root, input, actor, stage, output } = JSON.parse(await readFile(process.argv[2], 'utf8'))
Object.assign(process.env, { AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
await client.registry.load('local'); client.connected = true
client.kernel.isConnected = () => true
client.kernel.connect = async () => {}
client.kernel.status = async runId => ({ runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: root, pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')), configurationPath = join(root, 'configuration.json')
const files = createHostContent({ configurationPath, spatial }).files
const main = createHostMoteMainReader({ configurationPath, spatial, files })
const clients = () => [{ hostId: 'local', client }]
const runtime = createGoalRuntime({ clients, checkIn: async () => ({ known: false, reason: 'Unused' }) })
const store = new ContinuousProgressLoopStore(join(root, 'loops.json'))
let dropped = false
const save = store.save.bind(store)
store.save = async loops => {
  await save(loops)
  const receipt = loops.find(value => value.loopId === input.action.expectedSchedule.loopId)?.guidanceAdoptions?.find(value => value.operationId === input.operationId)
  if (!dropped && receipt && (stage === 'host-prepare' && receipt.state === 'prepared' || stage === 'host-publish' && receipt.publishedAt !== undefined)) {
    dropped = true; throw Error('Private OS owner lost Host ACK after actual durable publication')
  }
}
const manager = new ContinuousProgressLoopManager(store, async () => { throw Error('No input is authorized by this private OS fixture') }, () => 100000, async () => { throw Error('No due observation') }, { saveFutureIntent: async (loop, active, context) => {
  await runtime.saveFutureIntent(loop, active, context)
  if (!dropped && loop.currentDefinition && (stage === 'core-prepare' && !active || stage === 'core-activate' && active)) {
    dropped = true; throw Error('Private OS owner lost Core ACK after actual durable publication')
  }
}, inspectFutureIntent: runtime.inspectFutureIntent })
const presence = createHostMotePresence({ configurationPath, spatial, files, main, schedules: manager, clients })
const quick = new HostMoteQuickPreferences({ files, main, catalog: async () => spatialCatalog((await spatial.read()).graph), executors: async () => [], maintenance: presence.read, adoptGuidance: presence.adoptGuidance })
try {
  await manager.start()
  const result = await quick.save(input, { actor })
  const loop = manager.inspectLoop(input.action.expectedSchedule.loopId)
  await writeFile(output, JSON.stringify({ pid: process.pid, result, loop, session: { agentSessionId: client.agentSession(loop.agentSessionId).agentSessionId, run: client.agentSession(loop.agentSessionId).run, nativeHandle: client.agentSession(loop.agentSessionId).nativeHandle }, oldIntent: await client.readAgentFuturePromptIntent(loop.agentSessionId, input.action.expectedDefinition.intentId), newIntent: loop.guidanceAdoptions?.[0] ? await client.readAgentFuturePromptIntent(loop.agentSessionId, loop.guidanceAdoptions[0].newDefinition.intentId) : null, dropped }))
} finally { presence.dispose(); await manager.stop(); await client.dispose() }
