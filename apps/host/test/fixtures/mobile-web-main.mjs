import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { AgentMuxControlServer, AgentMuxSpatialStateStore, AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath } from '../../../../packages/core/src/index.ts'
import { RuntimeController } from '../../../desktop/src/main/runtime-controller.ts'
import { connectDesktopAgentMuxHost, desktopBusinessSocketPath } from '../../../desktop/src/main/desktop-host.ts'
import { ClientIncidentArchive } from '@agentmux/host/client-incident-archive'
const store = new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE)
const runtime = new RuntimeController(store, connectDesktopAgentMuxHost)
runtime.commit(await runtime.prepare({ hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {} }))
for (const { client } of runtime.rpcClients()) await client.readAgentSessions()
const archive = new ClientIncidentArchive(join(process.env.AGENTMUX_STATE_DIRECTORY, 'client-incidents'))
await archive.flush()
const originalIncident = archive.enqueue({ kind: 'connection-recovered', occurrenceId: 'original-main-observation', attemptId: 'original-main-attempt',
  relatedOccurrenceId: null, hostId: 'local', regionId: null, stage: 'connection-state', code: null,
  agentSessionId: null, runId: null, observedAt: 1, elapsedMs: 1, metadata: {}, stages: [], references: [] },
  { kind: 'main', appInstanceId: archive.appInstanceId, producerInstanceId: 'original-main-producer', windowId: null, documentGeneration: null, buildId: null })
await archive.flush()
await writeFile(join(process.env.AGENTMUX_STATE_DIRECTORY, 'mobile-test-main-incident.json'), JSON.stringify({ recordRef: archive.reference(originalIncident.logId), authority: archive.authority }))
const server = new AgentMuxControlServer({ socketPath: desktopBusinessSocketPath(),
  spatialState: new AgentMuxSpatialStateStore(),
  forwardingPeer: { authoritySocketPath: defaultAgentMuxControlSocketPath() },
  coreClients: () => runtime.rpcClients(), clientIncidents: () => archive,
  callOriginalCore: (hostId, method, params, context) => runtime.callOriginalCore(hostId, method, params, context) })
await server.start()
process.stdout.write(JSON.stringify({ ready: true, path: desktopBusinessSocketPath() }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void (async () => { await server.stop(); await archive.flush(); await runtime.dispose() })().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
