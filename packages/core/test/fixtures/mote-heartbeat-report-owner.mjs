import { join } from 'node:path'
import { AgentMuxNotesStorage } from '../../src/notes-storage.ts'
import { AgentMuxClient } from '../../src/client.ts'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.ts'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.ts'
import { AgentMuxRpcService } from '../../src/public-rpc-service.ts'
import { MoteDialogueStore } from '../../src/mote/dialogue-store.ts'
import { createHostContent } from '../../../../apps/host/src/content-owner.ts'
import { createHostMoteMainReader, createHostMoteDialogue } from '../../../../apps/host/src/mote-dialogue.ts'
const input = JSON.parse(await new Promise((yes, no) => {
  let data = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', value => data += value)
  process.stdin.on('end', () => yes(data)); process.stdin.on('error', no)
}))
const store = new AgentMuxFileAgentSessionStore(join(input.root, 'sessions.json')), spatial = new AgentMuxSpatialStateStore(join(input.root, 'spatial.json'))
const client = new AgentMuxClient({ store }); await client.registry.load('local')
for (const name of ['connect', 'start', 'input', 'stop', 'attach']) client.kernel[name] = async () => { throw Error('A report read cannot control an Agent') }
const content = createHostContent({ configurationPath: join(input.root, 'configuration.json'), spatial, storage: new AgentMuxNotesStorage(join(input.root, 'notes-location.json'), join(input.root, 'notes')) })
const main = createHostMoteMainReader({ configurationPath: join(input.root, 'configuration.json'), spatial, files: content.files })
const dialogue = createHostMoteDialogue({ main, spatial, store: new MoteDialogueStore(join(input.root, 'report-dialogue.sqlite')), clientForHost: () => client })
const service = new AgentMuxRpcService({ ...content, spatialState: spatial, coreClients: () => [{ hostId: 'local', client }], moteDialogue: dialogue })
try {
  const sessionsBefore = await store.loadMetadata()
  const page = await service.call('space.mote.dialogue.read', { target: input.target, kind: 'heartbeat', operationId: input.operationId }, { principal: { kind: 'device', id: 'private-report-reader' } })
  const sessionsAfter = await store.loadMetadata()
  process.stdout.write(JSON.stringify({ pid: process.pid, page, sessionsBefore, sessionsAfter }) + '\n')
} finally { await service.dispose(); await client.dispose() }
