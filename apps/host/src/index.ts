import { isAbsolute } from 'node:path'
import { startAgentMuxHost, agentMuxHostStore } from './host.js'
import { defaultPrivateAccessConfigurationPath, isPrivateAccessConfigurationPath, readPrivateAccessConfiguration,
  type PrivateAccessConfiguration } from './private-access-configuration.js'

const storePath = process.env.AGENTMUX_AGENT_SESSION_STORE
if (!storePath || !isAbsolute(storePath)) throw new Error('The Host requires the original absolute Agent Session Store path.')
const storeArgument = process.argv.indexOf('--store')
if (storeArgument !== -1 && process.argv[storeArgument + 1] !== storePath) throw new Error('The Host Store argument and original namespace do not agree.')
const privateArgument = process.argv.indexOf('--private-access')
const privatePath = privateArgument === -1 ? defaultPrivateAccessConfigurationPath(storePath) : process.argv[privateArgument + 1]
let privateAccess: PrivateAccessConfiguration | undefined, privateAccessIssue: string | undefined
let privateAccessConfigurationPath: string | undefined
try {
  if (!isPrivateAccessConfigurationPath(privatePath) || process.argv.filter(value => value === '--private-access').length > 1) throw new Error('Private mobile access needs one absolute non-secret manifest path. Correct this startup option; the original Unix Host and Runs remain available.')
  privateAccessConfigurationPath = privatePath
  privateAccess = await readPrivateAccessConfiguration(privatePath)
} catch (error) {
  if (!(privateArgument === -1 && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
    privateAccessIssue = error instanceof Error ? error.message : 'Private mobile access configuration is unavailable.'
  }
}
const host = await startAgentMuxHost({ store: agentMuxHostStore(storePath),
  ...(privateAccess ? { privateAccess } : {}),
  ...(privateAccessConfigurationPath ? { privateAccessConfigurationPath } : {}), ...(privateAccessIssue ? { privateAccessIssue } : {}) })
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => {
  if (stopping) return; stopping = true
  void host.dispose().then(() => process.exit(0), error => { console.error(error); process.exit(1) })
})
// RPC owns the process lifetime. Parent/consumer exits have no relationship to a Run lifetime.
process.stdout.write(JSON.stringify({ protocol: 'jsonrpc-2.0', pid: process.pid, identity: host.client!.runtimeIdentity(),
  privateAccess: host.privateAccessState() }) + '\n')
