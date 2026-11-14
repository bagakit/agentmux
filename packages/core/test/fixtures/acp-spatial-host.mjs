import { access, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { startAgentMuxHost } from '../../../../apps/host/src/host.ts'
import { AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore, defaultAgentMuxControlSocketPath } from '../../dist/index.js'

// Host code is loaded from source by the original Host fixture loader. Core and
// the private ACP actor must come from the candidate's actual package output.
const storePath = process.env.AGENTMUX_AGENT_SESSION_STORE
const state = process.env.AGENTMUX_STATE_DIRECTORY
const socketPath = defaultAgentMuxControlSocketPath()
const workspace = { id: 'acp-fixture-workspace', hostId: 'local', name: 'Private ACP Workspace', path: dirname(state), kind: 'folder' }
const configurationPath = join(state, 'acp-original-configuration.json')
try { await access(configurationPath) }
catch (error) {
  if (error.code !== 'ENOENT') throw error
  await writeFile(configurationPath, JSON.stringify({ workspaces: [workspace], executors: {}, appearance: {} }), { mode: 0o600 })
}
const spatial = new AgentMuxSpatialStateStore(join(state, 'spatial-state.json'))
await spatial.registerFolder(workspace)
const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(storePath), configurationPath,
  socketPath, desktopSocketPath: socketPath + '.desktop' })
const { owner } = await host.hosted.call('runtime.owner.identity', {})
process.stdout.write(JSON.stringify({ owner, socketPath }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
})
