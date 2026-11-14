// An independent private Core process, with the same deterministic Runtime port
// as public-rpc-owner. This is not a Provider/model or physical Runtime proof.
import { join } from 'node:path'
import { AgentMuxClient } from '../../src/client.ts'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.ts'
import { AgentMuxControlServer } from '../../src/public-rpc-server.ts'

const [root, sid] = process.argv.slice(2)
const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const client = new AgentMuxClient({ store, sessionExecutorConfiguration: async () => { throw Error('Current configuration is not the original source') } })
const inner = client
await inner.registry.load('local'); inner.connected = true
inner.kernel.isConnected = () => true
const status = async runId => ({ runId, lifecycleOperationId: null, program: '/original/grok', args: ['--model', 'original-model'],
  workspacePath: root, pid: null, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0,
  acceptedInputBytes: 0, nativeService: null })
inner.kernel.status = status
inner.kernel.identity = () => ({ daemonInstanceId: 'original-private-runtime' })
inner.kernel.observeOutput = async id => ({ run: await status(id), gap: null, terminal: { type: 'not-requested' }, resizeRevision: 0, replay: [], close: async () => {} })
for (const name of ['start', 'stop', 'input', 'attach', 'connect']) inner.kernel[name] = async () => { throw Error('Read-only Core restart cannot control Native: ' + name) }
const server = new AgentMuxControlServer({ socketPath: join(root, 'status-owner.sock'), coreClients: () => [{ hostId: 'local', client }] })
await server.start()
process.stdout.write(JSON.stringify({ pid: process.pid, socket: server.path, sid }) + '\n')
process.stdin.resume()
process.stdin.once('end', async () => {
  await server.stop(); await client.dispose()
  process.stdout.write(JSON.stringify({ closed: true, pid: process.pid }) + '\n')
})
