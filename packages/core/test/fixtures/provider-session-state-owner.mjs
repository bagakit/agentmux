import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, root, compiled] = process.argv.slice(2)
if (!['create', 'restore'].includes(mode) || !root || !compiled) throw new Error('An exact private owner mode, directory and compiled Core are required.')
const load = name => import(pathToFileURL(join(compiled, name + '.js')).href)
const { AgentMuxClient } = await load('client')
const { AgentMuxFileAgentSessionStore } = await load('agent-session-store')
const { AgentMuxControlServer } = await load('public-rpc-server')
const id = 'session-original', runId = 'run-original', key = {
  kind: 'prompt', agentSessionId: id, expectedRun: { runId }, submissionId: 'query-original'
}
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
if (mode === 'create') {
  if (await store.readMetadata(id)) throw new Error('The first owner cannot reseed an existing original Session.')
  await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'claude', hostId: 'local',
    workspacePath: root, run: { runId }, retiredRuns: [], hookBindingId: 'binding-original', hookToken: 'private-fixture-token', createdAt: 1, updatedAt: 1 })
} else if (!await store.readMetadata(id)) throw new Error('The restoring owner must read the original durable Session.')

// Runtime transport is an isolated deterministic port. These are real independent
// Core/Store/Control owners; this fixture does not certify or operate an installed Agent CLI.
const client = new AgentMuxClient({ store })
await client.registry.load('local')
client.connected = true
client.kernel.isConnected = () => true
client.kernel.status = async requested => {
  if (requested !== runId) throw new Error('A read changed the original Run.')
  return { nativeService: null, runId, lifecycleOperationId: null, program: 'claude', args: [], workspacePath: root,
    pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 17, firstAvailableByte: 0, acceptedInputBytes: 0 }
}
let runtimeWrites = 0
client.kernel.input = async () => { runtimeWrites++; throw new Error('Waiting input must not write Runtime bytes.') }
client.kernel.openInput = async () => { runtimeWrites++; throw new Error('Waiting input must not open a Runtime writer.') }

if (mode === 'create') {
  const hook = (eventName, receiptId, sequence, turnId, extra = {}) => client.acceptHookEvent({
    agentSessionId: id, providerId: 'claude', runId, receiptId, eventName,
    payload: { hook_event_name: eventName, session_id: 'native-main', sourceId: 'source-original', sequence, turnId, ...extra }
  }, AbortSignal.timeout(5000))
  await hook('turn.start', 'main-start-original', 1, 'main-turn-original')
  await hook('turn.start', 'child-start-original', 2, 'child-turn-original', { agent_id: 'child-original' })
  await hook('turn.complete', 'main-end-original', 3, 'main-turn-original', { reason: 'answer', isAborted: false, backgroundWork: 'pending' })
  await client.submitAgentPrompt({ agentSessionId: id, expectedRun: key.expectedRun, operationId: key.submissionId,
    prompt: 'Original retained query', admissionIntent: { kind: 'session-conversation' }, execution: 'immediate', authorHuman: true })
  await client.inputWaitingRecipients.get(id)?.pending
}

const server = new AgentMuxControlServer({ socketPath: join(root, 'state.sock'), coreClients: () => [{ hostId: 'local', client }] })
await server.start()
const result = async () => ({ type: 'ready', pid: process.pid, endpoint: server.path, runtimeWrites,
  status: await client.statusAgent(id), input: await client.inspectAgentInput({ key }), stored: await store.readMetadata(id) })
process.send?.(await result())
let closing = false
process.on('message', async message => {
  if (message?.type !== 'close' || closing) return
  closing = true
  try { await server.stop(); await client.dispose(); process.exit(0) }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exit(1) }
})
