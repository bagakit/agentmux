import './agent-information-loader.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { informationNativeFixture } from './agent-information-native.mjs'

const [root, mode = 'create', nativeProcessId] = process.argv.slice(2), candidate = process.env.AMX_INFORMATION_CANDIDATE
if (!root || !candidate) throw new Error('The isolated owner needs its exact data directory and candidate.')
const load = name => import(pathToFileURL(join(candidate, 'core/dist', name + '.js')).href)
const { AgentMuxClient } = await load('client'), { AgentMuxFileAgentSessionStore } = await load('agent-session-store')
const { defineAgentProvider } = await load('agent-provider'), { AgentMuxError } = await load('errors')
const { AgentMuxControlServer } = await load('public-rpc-server')
const fixture = await informationNativeFixture({ AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, AgentMuxError }, root,
  { mode, processId: nativeProcessId === undefined ? process.pid : Number(nativeProcessId) })
const server = new AgentMuxControlServer({ socketPath: join(root, 'information.sock'),
  coreClients: () => [{ hostId: 'local', client: fixture.client }] })
await server.start()
process.send?.({ type: 'ready', pid: process.pid, endpoint: server.path, input: fixture.input })
let closing = false
process.on('message', async message => {
  if (message?.type === 'native-mode') {
    fixture.state.mode = message.mode
    process.send?.({ type: 'native-mode', mode: fixture.state.mode }); return
  }
  if (message?.type === 'stats') { process.send?.({ type: 'stats', ...fixture.state }); return }
  if (message?.type !== 'close' || closing) return
  closing = true
  try { await server.stop(); await fixture.close(); process.exit(0) }
  catch (error) { process.stderr.write(String(error) + '\n'); process.exit(1) }
})
