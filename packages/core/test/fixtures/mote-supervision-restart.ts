import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { AgentMuxClient } from '../../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../src/agent-session-store.js'
import { AgentMuxSpatialStateStore } from '../../src/spatial-state.js'
import { AgentMuxRpcService } from '../../src/public-rpc-service.js'
import { MoteDialogueStore } from '../../src/mote-dialogue-store.js'
import { createHostContent } from '../../../../apps/host/src/content-owner.js'
import { createHostMoteDialogue, createHostMoteMainReader } from '../../../../apps/host/src/mote-dialogue.js'
import { fixtureHostExecutorOptions } from '../../../../apps/host/test/helpers/configured-executor-owner.js'

/** A fresh read owner over the original private fixture; it never connects or starts Runtime. */
const input = JSON.parse(await new Promise<string>((done, fail) => {
  let source = ''; process.stdin.setEncoding('utf8')
  process.stdin.on('data', chunk => { source += chunk }); process.stdin.on('end', () => done(source)); process.stdin.on('error', fail)
}))
const configurationPath = join(input.root, 'configuration.json')
const store = new AgentMuxFileAgentSessionStore(join(input.root, 'sessions.json'))
const spatial = new AgentMuxSpatialStateStore(join(input.root, 'spatial.json'))
const client = new AgentMuxClient({ store, ...fixtureHostExecutorOptions(() => configurationPath)(input.root) })
const content = createHostContent({ configurationPath, spatial })
const main = createHostMoteMainReader({ configurationPath, spatial, files: content.files! })
const dialogue = createHostMoteDialogue({ main, spatial, store: new MoteDialogueStore(join(input.root, 'work-dialogue.sqlite')), clientForHost: () => client })
let originalSourceAvailable = true
const service = new AgentMuxRpcService({ spatialState: spatial, moteDialogue: dialogue,
  coreClients: () => originalSourceAvailable ? [{ hostId: 'local', client }] : [] })
const context = { principal: { kind: 'device' as const, id: 'private-restart-reader' } }
try {
  const normal = await service.call('space.mote.dialogue.supervision.read', { target: input.target }, context)
  const dispatch = await service.call('message.dispatch.read', { hostId: 'local', sourceMessageId: input.messageId }, context)
  // A missing original read route is unknown. Restoring that route must reveal the same data.
  originalSourceAvailable = false
  const unknown = await service.call('space.mote.dialogue.supervision.read', { target: input.target }, context)
  originalSourceAvailable = true
  const recovered = await service.call('space.mote.dialogue.supervision.read', { target: input.target }, context)
  const sessions = [...await store.loadMetadata()].sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId))
  const files = Object.fromEntries(await Promise.all([
    configurationPath, input.motePath, join(dirname(input.motePath), 'SOUL.md'), spatial.path, store.path,
    join(input.root, 'work-dialogue.sqlite'), client.agentMessageQueuePath()
  ].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')])))
  process.stdout.write(JSON.stringify({ pid: process.pid, normal, unknown, recovered, dispatch,
    spatial: await spatial.readForLayout(), sessions, files }) + '\n')
} finally { await service.dispose(); await client.dispose() }
