// Private product process: production Host + original durable store and Native.
import { access, writeFile, unlink } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { AgentMuxFileAgentSessionStore, defaultAgentMuxControlSocketPath } from '@agentmux/core'
import { startAgentMuxHost } from '../../src/host.ts'
const configurationPath = join(dirname(process.env.AGENTMUX_AGENT_SESSION_STORE), 'original-config.json')
try { await access(configurationPath) } catch { await writeFile(configurationPath, JSON.stringify({ hosts: [{ id: 'local', kind: 'local', label: 'Private Local' }], workspaces: [], executors: {}, appearance: {} })) }
const socketPath = defaultAgentMuxControlSocketPath()
const host = await startAgentMuxHost({ store: new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE), configurationPath,
  socketPath, desktopSocketPath: socketPath + '.desktop', mobileBuildDirectory: join(dirname(configurationPath), 'absent-mobile'), mobilePort: 0 })
// A private one-shot transport cut occurs only after the original owner completed.
const remove = host.client.removeHostExecutor.bind(host.client)
host.client.removeHostExecutor = async input => {
  const result = await remove(input)
  const marker = join(dirname(configurationPath), 'lose-remove-reply')
  try { await access(marker) } catch { return result }
  await unlink(marker); await host.server.stop()
  return result
}
const { owner } = await host.hosted.call('runtime.owner.identity', {})
process.stdout.write(JSON.stringify({ owner, socketPath }) + '\n')
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) }) })
