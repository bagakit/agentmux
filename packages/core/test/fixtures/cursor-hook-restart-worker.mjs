import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry,
  defaultAgentMuxHookPort, loadAgentSessions } from '../../dist/index.js'

const [root, generation, nativeId, transcriptPath] = process.argv.slice(2)
for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_')) delete process.env[key]
process.env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'runtime')
process.env.AGENTMUX_STATE_DIRECTORY = join(root, 'durable')
process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'queue.ndjson')
process.env.AGENTMUX_AGENT_SESSION_STORE = join(root, 'sessions.json')
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const [session] = await loadAgentSessions(store)
const before = await readFile(join(root, 'sessions.json'))
let controls = 0
const run = { id: session.run.runId, spec: { program: 'cursor-agent', args: [], cwd: session.workspacePath, env: {} },
  lineage: null, pid: 123, state: { type: 'running' }, latest_output_bytes: 0, durable_output_bytes: 0,
  first_available_byte: 0, attachments: 0, applied_input_bytes: 10, current_size: { cols: 80, rows: 24 } }
const client = new AgentMuxClient({ store })
Object.assign(client.kernel, { client: { list: async () => [{ id: run.id }], status: async () => run,
  start: async () => { controls++; throw new Error('unexpected start') },
  stop: async () => { controls++; throw new Error('unexpected stop') },
  recoverableInput: async () => { controls++; throw new Error('unexpected input') }
}, runtime: { daemonInstanceId: 'cursor-private-daemon' } })
try {
  await client.connect()
  if (generation === 'birth') {
    const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
      method: 'POST', headers: { authorization: `Bearer ${session.hookToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: 'process-birth', eventName: 'beforeSubmitPrompt',
        payload: { conversation_id: nativeId, transcript_path: transcriptPath, prompt: 'process birth' } })
    })
    if (response.status !== 204) throw new Error(`birth HTTP status ${response.status}`)
  }
  const restored = client.agentSession(session.agentSessionId)
  const plan = new AgentProviderRegistry().get('cursor').buildResumeLaunch({ workspacePath: restored.workspacePath,
    nativeHandle: restored.nativeHandle, args: [], env: {}, prompt: 'continue' })
  console.log(JSON.stringify({ generation, pid: process.pid, sessionId: restored.agentSessionId,
    run: restored.run, nativeHandle: restored.nativeHandle, resume: plan.args, controls,
    storeUnchanged: (await readFile(join(root, 'sessions.json'))).equals(before) }))
} finally {
  await client.dispose()
}
