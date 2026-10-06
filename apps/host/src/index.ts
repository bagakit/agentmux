import { isAbsolute } from 'node:path'
import { startAgentMuxHost, agentMuxHostStore } from './host.js'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const storePath = process.env.AGENTMUX_AGENT_SESSION_STORE
if (!storePath || !isAbsolute(storePath)) throw new Error('The Host requires the original absolute Agent Session Store path.')
const storeArgument = process.argv.indexOf('--store')
if (storeArgument !== -1 && process.argv[storeArgument + 1] !== storePath) throw new Error('The Host Store argument and original namespace do not agree.')
const mobileBuildDirectory = process.env.AGENTMUX_MOBILE_BUILD_DIRECTORY ?? join(dirname(fileURLToPath(import.meta.url)), '../../mobile/dist')
const host = await startAgentMuxHost({ store: agentMuxHostStore(storePath), mobileBuildDirectory })
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true
  void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
})
// RPC owns the process lifetime. Parent/consumer exits have no relationship to a Run lifetime.
const { owner } = await host.hosted.call('runtime.owner.identity', {})
process.stdout.write(JSON.stringify({ protocol: 'jsonrpc-2.0', pid: process.pid, owner,
  mobileAccess: host.mobileAccessState() }) + '\n')
