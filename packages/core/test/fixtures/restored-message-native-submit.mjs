import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '../../dist/index.js'
import { AgentMuxControlServer } from '../../dist/public-rpc-server.js'
const [storePath, id, body, operation] = process.argv.slice(2), execute = promisify(execFile)
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(storePath) })
let server
try {
  await client.connect()
  const session = client.agentSession(id), predecessor = session.nativePromptPredecessor
  assert.equal(predecessor.run.runId, session.run.runId)
  assert.equal(predecessor.previousRun.runId, session.retiredRuns.at(-1).runId)
  server = new AgentMuxControlServer({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'cold-control.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  const reply = await execute(process.execPath, [fileURLToPath(new URL('../../bin/agentmux', import.meta.url)), '--endpoint', 'unix://' + server.path,
    'agent', 'send', '--to-session', id, '--text', body, '--execution', 'immediate', '--operation-id', operation], { env: process.env, timeout: 50_000, maxBuffer: 1024 * 1024 })
  console.log(JSON.stringify({ coldCoreProcess: process.pid, predecessor, result: JSON.parse(reply.stdout).result,
    submission: client.agentSession(id).terminalPromptSubmission }))
} finally { await server?.stop(); await client.dispose() }
