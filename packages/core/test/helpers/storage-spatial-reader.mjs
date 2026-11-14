import { AgentMuxSpatialStateStore } from '../../src/spatial-state.ts'
import { AgentMuxControlServer } from '../../src/public-rpc-server.ts'
const [path, socket] = process.argv.slice(2)
const store = new AgentMuxSpatialStateStore(path)
const server = new AgentMuxControlServer({ socketPath: socket, spatialState: store })
try {
  await server.start()
  process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + '\n')
  await new Promise(resolve => { process.stdin.once('end', resolve); process.stdin.resume() })
} finally { await server.stop() }
