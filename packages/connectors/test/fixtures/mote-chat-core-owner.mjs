import { readFile, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath } from '../../../core/src/index.ts'
import { startAgentMuxHost } from '../../../../apps/host/src/host.ts'
import { signedRoomAdapter } from './signed-room-adapter.ts'

const state = dirname(process.env.AGENTMUX_AGENT_SESSION_STORE), configurationPath = join(state, 'original-configuration.json')
try { await readFile(configurationPath) } catch { await writeFile(configurationPath, JSON.stringify({ workspaces: [], executors: {}, appearance: {} })) }
const wire = signedRoomAdapter(), verify = wire.adapter.ingress.verify, start = wire.adapter.transport.start, dispatch = wire.adapter.publication.dispatch
wire.adapter.ingress.verify = async (...args) => ({ ...await verify(...args), conversationKind: 'direct' })
wire.adapter.transport.start = async (...args) => {
  const receiver = await start(...args)
  await writeFile(join(state, 'direct-endpoint.json'), JSON.stringify({ endpoint: wire.endpoint, connectionId: args[0].config.connectionId, ownerPid: process.pid }))
  return receiver
}
wire.adapter.publication.dispatch = async (...args) => {
  const result = await dispatch(...args)
  await appendFile(join(state, 'external-effects.jsonl'), JSON.stringify({ ownerPid: process.pid, operationId: args[0].requestKey,
    request: JSON.parse(args[0].request.body), result }) + '\n')
  return result
}
const path = defaultAgentMuxControlSocketPath()
const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE),
  configurationPath, socketPath: path, desktopSocketPath: path + '.desktop', mobilePort: 0,
  connections: { directory: join(state, 'connectors'), adapters: [wire.adapter], moteConfigurationPath: configurationPath } })
const { owner } = await host.hosted.call('runtime.owner.identity', {})
process.stdout.write(JSON.stringify({ owner, socketPath: path }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
