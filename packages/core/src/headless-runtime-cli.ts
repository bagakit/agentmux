import { AgentMuxError } from './errors.js'
import { agentMuxRpcEndpoint, connectAgentMuxRpc } from './public-rpc-client.js'
import { forwardAgentMuxRpcStdio } from './agentmux-rpc-stdio.js'
import { startHeadlessAgentMux } from './headless-runtime.js'

async function main(args: string[]): Promise<void> {
  let endpoint: string | undefined
  if (args[0] === '--endpoint') { endpoint = args[1]; args = args.slice(2) }
  const [operation, ...tail] = args
  if (operation === 'system' && tail[0] === 'endpoint' && tail[1] === '--stdio' && tail.length === 2) {
    await forwardAgentMuxRpcStdio({ endpoint: agentMuxRpcEndpoint(endpoint), input: process.stdin, output: process.stdout }); return
  }
  if (!operation || operation === '--help') {
    process.stdout.write('agentmux-runtime serve | status | shutdown\n  --endpoint unix:<SOCKET_PATH> (status/shutdown)\n  serve uses AGENTMUX_STATE_DIRECTORY and AGENTMUX_RUNTIME_DIRECTORY.\n'); return
  }
  if (tail.length || !['serve', 'status', 'shutdown'].includes(operation)) throw new AgentMuxError('Expected serve, status or shutdown.', 'INVALID_CLI_ARGUMENT')
  if (operation === 'serve') {
    if (endpoint) throw new AgentMuxError('Serve binds the configured local owner; endpoint selection belongs to clients.', 'INVALID_CLI_ARGUMENT')
    const owner = await startHeadlessAgentMux()
    process.stdout.write(JSON.stringify({ operation: 'serve', owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
    const stop = () => { void owner.stop().then(() => { process.exitCode = 0 }, error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1 }) }
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
