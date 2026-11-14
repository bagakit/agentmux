import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import { AgentMuxHostedRuntimeService } from '../../src/hosted-runtime-service.js'
import { AgentMuxCreationAuthority } from '../../src/agent-creation-authority.js'
import { createHostSpatialAgentControl } from '../../../../apps/host/src/spatial-agent-control.js'
const [root, runtimeId, sid, operationId] = process.argv.slice(2)
const original = await readFile(join(root, 'spatial.json'), 'utf8')
const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) })
client.creationAuthority = new AgentMuxCreationAuthority({ stateDirectory: join(root, 'creation-authority'), runtimeId })
let controls = 0
const forbidden = async () => { controls++; throw new Error('A Takeover reader cannot launch, send input or stop.') }
Object.assign(client.kernel, { start: forbidden, input: forbidden, stop: forbidden, connect: forbidden })
const owner = { runtimeId, ownerInstanceId: 'private-restarted-reader', protocolVersion: 2, processId: process.pid, ctxmux: null, availability: 'connected' }
const spatial = new AgentMuxSpatialStateStore(join(root, 'spatial.json')), hosted = new AgentMuxHostedRuntimeService(client, null, () => owner)
let server
const runtime = { client, ownerIdentity: () => owner, get server() { return server } }
server = new AgentMuxControlServer({ socketPath: join(root, 'reader.sock'), spatialState: spatial, coreClients: () => [{ hostId: 'local', client }], hostedRuntime: () => hosted,
  spatialAgentControl: createHostSpatialAgentControl({ configurationPath: join(root, 'config.json'), spatial, runtime: () => runtime }) })
let rpc
try {
  await server.start(); rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const creation = (await client.readAgentSession(sid))?.creation
  const incoming = await rpc.call('agent.takeover.ls', { expectedRuntimeId: runtimeId, direction: 'incoming', subject: { runtimeId, agentSessionId: sid } })
  const outgoing = await rpc.call('agent.takeover.ls', { expectedRuntimeId: runtimeId, direction: 'outgoing', subject: { runtimeId: creation.takeover.source.runtimeId, agentSessionId: creation.takeover.source.agentSessionId } })
  const known = await rpc.call('space.inspect', { target: { operationId } })
  const unknown = await rpc.call('space.inspect', { target: { operationId: 'unknown-takeover-operation' } })
  console.log(JSON.stringify({ pid: process.pid, creation, incoming, outgoing, known: known.request, unknown: unknown.request, controls,
    graphUnchanged: original === await readFile(join(root, 'spatial.json'), 'utf8') }))
} finally { await rpc?.dispose(); await server.stop(); await hosted.dispose(); await client.dispose() }
