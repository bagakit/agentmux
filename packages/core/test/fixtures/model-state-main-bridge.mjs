import '../../../../apps/host/test/mobile-web-node-loader.mjs'
import { installInformationCandidateLoader } from './agent-information-loader.mjs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Reinstall the exact compiled package resolver above the existing Node source loader.
// Main stays in Node; Renderer tests consume only this child's actual wire results.
installInformationCandidateLoader()

export async function createModelStateMainBridge({ client, directory, agentSessionId, hostId = 'local', onRuntimeEvent = () => {} }) {
  const candidate = process.env.AMX_INFORMATION_CANDIDATE
  if (!candidate) throw new Error('The Main bridge requires the same-source compiled Core and listener worker.')
  const { AgentMuxControlServer } = await import(pathToFileURL(join(candidate, 'core/dist/public-rpc-server.js')).href)
  const { connectAgentMuxRpc } = await import(pathToFileURL(join(candidate, 'core/dist/public-rpc-client.js')).href)
  const { RuntimeController } = await import('../../../../apps/desktop/src/main/runtime-controller.ts')
  const session = client.agentSession(agentSessionId)
  const control = { kind: 'agent', hostId, agentSessionId, run: { ...session.run } }
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'm.sock'), coreClients: () => [{ hostId: 'local', client }] })
  await server.start()
  let rpc
  try { rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }) }
  catch (error) { await server.stop(); throw error }
  const requests = [], runtimeEvents = []
  const receiver = {
    hostReconfigurationReservations: new Set(), hostOperations: new Map(),
    coreEventObservers: new Map(), toolkitRunObservers: new Map(), toolkitRuns: new Map(),
    readyAgentColorQueryRuns: new Map(), pendingAgentColorQueryReplies: new Map(), hosts: new Map(),
    clients: new Set([{ isDestroyed: () => false, send: (_channel, event) => { runtimeEvents.push(event); onRuntimeEvent(event) } }]),
    async connectedClient(selected) {
      if (selected !== hostId) throw new Error('The original configured Host changed.')
      return { forwardRpc: async (method, params, context) => { requests.push({ method, params }); return await rpc.call(method, params, context) } }
    },
    trackHostOperation(...args) { return RuntimeController.prototype.trackHostOperation.call(receiver, ...args) }
  }
  const release = client.onEvent(event => { if (event.type === 'agent-session') RuntimeController.prototype.publish.call(receiver, hostId, event) }, { observeMessages: false })
  return { control, endpoint: server.path, requests, runtimeEvents, rpc,
    inspectConfiguration: (selected = control, operationId) => RuntimeController.prototype.inspectConfiguration.call(receiver, selected, operationId),
    inspectInformation: (selected = control) => RuntimeController.prototype.inspectInformation.call(receiver, selected),
    setConfiguration: (selected, request) => RuntimeController.prototype.setConfiguration.call(receiver, selected, request),
    async close() { release(); await rpc.dispose(); await server.stop() } }
}
