import { AgentMuxClient } from '../../dist/client.js'
import { AgentMuxFileAgentSessionStore } from '../../dist/agent-session-store.js'
const [storePath, id, mode] = process.argv.slice(2)
const store = new AgentMuxFileAgentSessionStore(storePath)
const client = new AgentMuxClient({ store })
await client.registry.load('local')
const original = client.agentSession(id)
client.connected = true
client.kernel.isConnected = () => true
client.kernel.status = async () => ({ nativeService: null, runId: original.run.runId, lifecycleOperationId: null,
  program: 'private-provider', args: [], workspacePath: original.workspacePath, pid: null, state: { type: 'running' },
  cols: 80, rows: 24, latestOutputBytes: 17, firstAvailableByte: 0, acceptedInputBytes: 11 })
const hook = (eventName, receiptId, payload) => client.acceptHookEvent({ agentSessionId: id, providerId: 'claude',
  runId: original.run.runId, eventName, receiptId, payload: { hook_event_name: eventName, session_id: 'native-main', ...payload } }, AbortSignal.timeout(5000))
try {
  if (mode === 'first') {
    await hook('turn.start', 'original-start', { sourceId: 'original-source', sequence: 1, turnId: 'original-turn' })
    await hook('UserPromptSubmit', 'original-merged-input', {})
    await hook('PreToolUse', 'original-tool', { tool_name: 'Bash', tool_use_id: 'original-call', tool_input: {} })
  } else if (mode === 'second') {
    await hook('PostToolUse', 'continued-tool', { tool_name: 'Bash', tool_use_id: 'original-call', tool_response: 'private result' })
  } else if (mode === 'end') {
    await hook('turn.complete', 'original-end', { sourceId: 'original-source', sequence: 2, turnId: 'original-turn', reason: 'answer', isAborted: false, backgroundWork: 'none' })
  } else throw new Error('Unknown private owner mode')
  const status = await client.statusAgent(id)
  const saved = await store.readMetadata(id)
  console.log(JSON.stringify({ pid: process.pid, sessionId: status.session.agentSessionId, run: status.session.run,
    nativeHandle: status.session.nativeHandle, observation: status.observation, semanticStatus: saved.semanticStatus,
    recoveryActivity: saved.recoveryActivity }))
} finally { await client.dispose() }
