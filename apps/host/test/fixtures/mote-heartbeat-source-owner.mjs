import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '../../../../packages/core/src/index.ts'
import { ContinuousProgressLoopStore } from '../../src/continuous-progress-loop-store.ts'
import { ContinuousProgressLoopManager } from '../../src/continuous-progress-loop-manager.ts'
import { createGoalRuntime } from '../../src/goal-runtime.ts'
const { root, loopId, output } = JSON.parse(await readFile(process.argv[2], 'utf8'))
Object.assign(process.env, { AGENTMUX_STATE_DIRECTORY: join(root, 'state'), AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
await client.registry.load('local'); client.connected = true
client.kernel.isConnected = () => true; client.kernel.connect = async () => {}
client.kernel.status = async runId => ({ runId, lifecycleOperationId: null, program: 'codex', args: [], workspacePath: root, pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0, nativeService: null })
const runtime = createGoalRuntime({ clients: () => [{ hostId: 'local', client }], checkIn: async () => ({ known: false, reason: 'Unused' }) })
const manager = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(root, 'loops.json')), async () => { throw Error('No input is authorized by this private read owner') }, () => 100000, async () => { throw Error('No due observation is authorized') }, runtime)
try {
  await manager.start()
  const result = await manager.call('schedule.inspect', { scheduleId: loopId })
  const session = client.agentSession(result.schedule.agentSessionId)
  await writeFile(output, JSON.stringify({ pid: process.pid, result, session: { agentSessionId: session.agentSessionId, run: session.run, nativeHandle: session.nativeHandle } }))
} finally { await manager.stop(); await client.dispose() }
