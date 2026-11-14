import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
// Only the standalone listener asset uses Node's native TS loader. No dist build is borrowed.
const fork = childProcess.fork
childProcess.fork = (path, args, options) => fork(String(path).endsWith('/control-endpoint-listener-worker.js')
  ? fileURLToPath(new URL('../../src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)
syncBuiltinESMExports()
const [{ AgentMuxClient }, { AgentMuxFileAgentSessionStore }, { AgentMuxControlServer }] = await Promise.all([
  import('../../src/client.ts'), import('../../src/agent-session-store.ts'), import('../../src/public-rpc-server.ts')])
const root = process.argv[2], client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
await client.registry.load('local')
for (const name of ['start', 'input', 'stop', 'connect', 'attach']) client.kernel[name] = async () => { throw Error('Read-only result restoration cannot control a Run') }
const server = new AgentMuxControlServer({ socketPath: join(root, 'result-owner.sock'), coreClients: () => [{ hostId: 'local', client }] })
await server.start()
process.stdout.write(JSON.stringify({ pid: process.pid, socket: server.path }) + '\n')
process.stdin.resume()
process.stdin.once('end', async () => { await server.stop(); await client.dispose(); process.stdout.write(JSON.stringify({ closed: true, pid: process.pid }) + '\n') })
