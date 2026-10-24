import { join } from 'node:path'
import { AgentMuxControlServer, AgentMuxSpatialStateStore, AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath } from '../../../../packages/core/src/index.ts'
import { RuntimeController } from '../../../desktop/src/main/runtime-controller.ts'
import { connectDesktopAgentMuxHost, desktopBusinessSocketPath } from '../../../desktop/src/main/desktop-host.ts'
import { ClientIncidentArchive } from '../../../desktop/src/main/client-incident-archive.ts'
import { mobileWebReportOwner } from '../../../desktop/src/main/mobile-web-report-owner.ts'
const store = new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE)
const runtime = new RuntimeController(store, connectDesktopAgentMuxHost)
runtime.commit(await runtime.prepare({ hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {} }))
for (const { client } of runtime.rpcClients()) await client.readAgentSessions()
const archive = new ClientIncidentArchive(join(process.env.AGENTMUX_STATE_DIRECTORY, 'mobile-incidents'))
await archive.flush()
const server = new AgentMuxControlServer({ socketPath: desktopBusinessSocketPath(),
  spatialState: new AgentMuxSpatialStateStore(),
  forwardingPeer: { authoritySocketPath: defaultAgentMuxControlSocketPath() },
  coreClients: () => runtime.rpcClients(), clientIncidents: archive, mobileWebReports: mobileWebReportOwner(archive),
  callOriginalCore: (hostId, method, params, context) => runtime.callOriginalCore(hostId, method, params, context) })
await server.start()
process.stdout.write(JSON.stringify({ ready: true, path: desktopBusinessSocketPath() }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void (async () => { await server.stop(); await archive.flush(); await runtime.dispose() })().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
