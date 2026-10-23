import { AgentMuxError } from './errors.js'
import { AGENTMUX_RPC_MAX_MESSAGE_BYTES } from './public-rpc-frame.js'
import type { AgentMuxRpcClient, AgentMuxRpcCallOptions } from './public-rpc-client.js'
import type { ConnectionCredentialMethod } from './connection-credential-contract.js'
import { parseConnectionCredentialParams } from './connection-credential-codec.js'

/** Only this stdin boundary consumes plaintext; existing protected transports carry it to the original Host. */
export async function prepareConnectionCredentialCli(client: AgentMuxRpcClient, method: ConnectionCredentialMethod, params: Record<string, unknown>): Promise<{ params: Record<string, unknown>; options: AgentMuxRpcCallOptions }> {
  const { owner } = await client.call('runtime.owner.identity', {})
  const options = { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } }
  if (method !== 'connection.credential.store') return { params, options }
  const chunks: Buffer[] = []
  let bytes = 0, plaintext: Buffer | undefined
  try {
    for await (const chunk of process.stdin) {
      const part = Buffer.from(chunk); bytes += part.byteLength; chunks.push(part)
      if (bytes > AGENTMUX_RPC_MAX_MESSAGE_BYTES) throw new AgentMuxError('Credential stdin exceeds the original receiving transport budget.', 'INVALID_CLI_ARGUMENT')
    }
    plaintext = Buffer.concat(chunks)
    let secret: string
    try { secret = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext) }
    catch { throw new AgentMuxError('Credential stdin must contain complete UTF-8 text.', 'INVALID_CLI_ARGUMENT') }
    return { params: parseConnectionCredentialParams('connection.credential.store', { operationId: params.operationId, secret }), options }
  } finally { plaintext?.fill(0); for (const chunk of chunks) chunk.fill(0) }
}
