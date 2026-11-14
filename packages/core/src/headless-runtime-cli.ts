import { AgentMuxError } from './errors.js'
import { agentMuxRpcEndpoint, connectAgentMuxRpc } from './public-rpc-client.js'
import { forwardAgentMuxRpcStdio } from './agentmux-rpc-stdio.js'
import { startHeadlessAgentMux } from './headless-runtime.js'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { loadOrCreateRelayKeyPair } from './rpc-relay-keypair.js'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { startAgentMuxStorageRecovery } from './storage-recovery-maintenance.js'

async function main(args: string[]): Promise<void> {
  let endpoint: string | undefined
  if (args[0] === '--endpoint') { endpoint = args[1]; args = args.slice(2) }
  const [operation, ...tail] = args
  if (operation === 'system' && tail[0] === 'endpoint' && tail[1] === '--stdio' && tail.length === 2) {
    await forwardAgentMuxRpcStdio({ endpoint: agentMuxRpcEndpoint(endpoint), input: process.stdin, output: process.stdout }); return
  }
  if (!operation || operation === '--help') {
    process.stdout.write('agentmux-runtime serve [--gateway-config FILE] | status | shutdown\n  agentmux-runtime relay-key [--file FILE]\n  relay-key reuses the original RPC client identity and prints its public key only.\n  --endpoint unix:<SOCKET_PATH> (status/shutdown)\n  serve uses AGENTMUX_STATE_DIRECTORY and AGENTMUX_RUNTIME_DIRECTORY.\n  gateway-config is read once; its optional failure leaves the original Unix Core available.\n'); return
  }
  if (operation === 'relay-key') {
    if (endpoint || tail.length && (tail.length !== 2 || tail[0] !== '--file' || !tail[1] || !isAbsolute(tail[1]))) throw new AgentMuxError('Relay key uses only an optional absolute --file path.', 'INVALID_CLI_ARGUMENT')
    const path = tail[1] ?? join(homedir(), '.agentmux', 'relay-client-keypair.json')
    const key = await loadOrCreateRelayKeyPair(path).catch(() => { throw new AgentMuxError('The original Relay client identity is unconfirmed. Preserve its key file and inspect storage before trying again.', 'CONTROL_UNAVAILABLE') })
    process.stdout.write(JSON.stringify({ operation, path, publicKeyB64: exportPublicKey(key.publicKey) }) + '\n'); return
  }
  if (operation === 'recovery-serve') {
    if (endpoint || tail.length % 2) throw new AgentMuxError('Recovery serve requires explicit original state, Store and socket paths.', 'INVALID_CLI_ARGUMENT')
    const values = new Map<string, string>()
    for (let i = 0; i < tail.length; i += 2) { const key = tail[i]!, value = tail[i + 1]!
      if (!['--state-directory', '--store', '--socket', '--generation'].includes(key) || values.has(key) || !value) throw new AgentMuxError('Recovery serve received an unknown or duplicate selector.', 'INVALID_CLI_ARGUMENT'); values.set(key, value) }
    for (const key of ['--state-directory', '--store', '--socket']) if (!values.get(key) || !isAbsolute(values.get(key)!)) throw new AgentMuxError('Recovery serve requires absolute original paths.', 'INVALID_CLI_ARGUMENT')
    const owner = await startAgentMuxStorageRecovery({ stateDirectory: values.get('--state-directory')!, storePath: values.get('--store')!, socketPath: values.get('--socket')!, ...(values.has('--generation') ? { generationId: values.get('--generation')! } : {}) })
    process.stdout.write(JSON.stringify({ operation, namespace: owner.recovery.namespace, socketPath: owner.socketPath }) + '\n')
    const stop = () => { void owner.stop().then(() => process.exit(0), error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1 }) }
    process.once('SIGINT', stop); process.once('SIGTERM', stop); return
  }
  if (!['serve', 'status', 'shutdown'].includes(operation) || tail.length && (operation !== 'serve' || tail.length !== 2 || tail[0] !== '--gateway-config' || !tail[1] || !isAbsolute(tail[1]))) throw new AgentMuxError('Expected serve [--gateway-config FILE], status or shutdown.', 'INVALID_CLI_ARGUMENT')
  if (operation === 'serve') {
    if (endpoint) throw new AgentMuxError('Serve binds the configured local owner; endpoint selection belongs to clients.', 'INVALID_CLI_ARGUMENT')
    const owner = await startHeadlessAgentMux({ ...(tail[1] ? { relayGateway: { configurationPath: tail[1] } } : {}) })
    process.stdout.write(JSON.stringify({ operation: 'serve', owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
    // This entry owns this process. After the semantic owner has flushed and detached,
    // an unacknowledged SDK read wire must not retain it; admitted Native Runs survive.
    const stop = () => { void owner.stop().then(() => { process.exit(0) }, error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1 }) }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
    return
  }
  const client = await connectAgentMuxRpc({ endpoint: agentMuxRpcEndpoint(endpoint) })
  try {
    const { owner } = await client.call('runtime.owner.identity', {})
    const result = operation === 'status' ? { owner } : await client.call('runtime.owner.shutdown', {
      fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    process.stdout.write(JSON.stringify({ operation, result }) + '\n')
  } finally { await client.dispose() }
}
void main(process.argv.slice(2)).catch(error => {
  process.stderr.write(JSON.stringify({ error: { code: error instanceof AgentMuxError ? error.code : 'HEADLESS_FAILED',
    message: error instanceof Error ? error.message : String(error) } }) + '\n'); process.exitCode = 1
})
