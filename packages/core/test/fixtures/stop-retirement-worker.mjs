import { readFile, writeFile } from 'node:fs/promises'
import { AgentMuxClient } from '../../dist/client.js'
import { AgentMuxFileAgentSessionStore } from '../../dist/agent-session-store.js'
import { projectRunProcessStatus, runExitFacts } from '../../dist/agent-run-status.js'

const [storePath, phase, scenario] = process.argv.slice(2)
const kernelPath = `${storePath}.kernel.json`
const store = new AgentMuxFileAgentSessionStore(storePath)
const session = {
  kind: 'agent', agentSessionId: 'restart-agent', providerId: 'claude', executorId: 'claude',
  hostId: 'local', workspacePath: '/fixture', run: { runId: 'restart-run' }, retiredRuns: [],
  hookBindingId: 'binding', hookToken: 'token', outputCursorBytes: 0, createdAt: 1, updatedAt: 1
}
let run = {
  runId: 'restart-run', lifecycleOperationId: null, program: 'claude', args: [], workspacePath: '/fixture',
  pid: 42, state: { type: 'running' }, cols: 80, rows: 24,
  latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0
}
if (phase === 'first') await store.compareAndSwap(null, session)
else run = JSON.parse(await readFile(kernelPath, 'utf8'))

// Only the transport is fake. FileStore, lifecycle reservation, retirement, filtering and
// restart reconciliation are production code in separate Node processes, with no daemon connection.
const client = new AgentMuxClient({ store })
await client.registry.load('local')
client.connected = true
client.kernel.isConnected = () => true
client.kernel.status = async () => run
client.kernel.list = async () => [run]
const stopOperations = []
client.kernel.prepareStop = async (runId, operationKey) => {
  if (scenario === 'prepare-failed' && phase === 'first') throw new Error('fixture prepare failed')
  return { daemonInstance: 'fixture-daemon', operationKey, runId }
}
client.kernel.stop = async (operation) => {
  stopOperations.push(operation)
  if (scenario === 'uncertain-running' && phase === 'first') throw new Error('fixture lost receipt before result')
  run = { ...run, pid: null, state: { type: 'exited', code: 137, signal: 'SIGKILL' } }
  if (scenario === 'uncertain-ended' && phase === 'first') throw new Error('fixture lost receipt after result')
}
let failure
if (phase === 'first') {
  if (scenario !== 'natural-crash') {
    try { await client.stopAgent(session.agentSessionId, session.run) }
    catch (error) { failure = error.message }
  }
  if (scenario === 'natural-crash' || scenario === 'prepare-failed') {
    run = { ...run, pid: null, state: { type: 'exited', code: 139, signal: 'SIGSEGV' } }
  }
  await writeFile(kernelPath, JSON.stringify(run))
} else {
  await client.recoverStaleLifecycles()
  client.backfillEndedRuns([run])
}
const live = await store.load()
const retired = await store.loadRetiredAgentSessions()
const lifecycle = JSON.parse(await readFile(storePath, 'utf8')).reservations
const projection = await client.runtimeProjection()
const statuses = projection.subjects.map((subject) => projectRunProcessStatus({
  state: subject.run.state, source: 'run-process', observedAt: subject.run.observedAt, ...runExitFacts(subject.run)
}).state)
console.log(JSON.stringify({ pid: process.pid, failure, live: live.map((item) => item.agentSessionId),
  retired: retired.map((item) => item.agentSessionId), lifecycle: lifecycle.map((item) => ({ kind: item.kind, stopOperation: item.stopOperation })),
  projected: projection.subjects.map((item) => item.subjectId), statuses, stopOperations }))
// No client.dispose(): this phase models losing its process-local maps at process exit.
