import { writeFile } from 'node:fs/promises'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.ts'
import { AgentMuxClient } from '../../src/client.ts'
import { AgentMuxControlServer } from '../../src/public-rpc-server.ts'

// A fresh process opens only the private test namespace. It never connects a Runtime.
const [database, readback, socket, encodedKey] = process.argv.slice(2)
const key = JSON.parse(encodedKey), store = new AgentMuxFileAgentSessionStore(database)
const client = new AgentMuxClient({ store })
const server = new AgentMuxControlServer({ socketPath: socket, coreClients: () => [{ hostId: 'local', client }] })
try {
  const record = await store.readPromptAdmission(key.agentSessionId, key.expectedRun, key.submissionId)
  const active = await store.readMetadata(key.agentSessionId), retired = await store.readRetiredAgentSession(key.agentSessionId)
  await writeFile(readback, JSON.stringify({ pid: process.pid, record, active, retired }), { mode: 0o600 })
  await server.start()
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n')
  await new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume() })
} finally { await server.stop(); await client.dispose() }
