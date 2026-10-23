import { connectAgentMuxRpc, type AgentExternalInputAuthorityPort } from '@agentmux/core'
import { createConnectionExternalInputAuthority } from '../../../../apps/host/src/external-input-authority.js'

/** Explicit test composition across the original RPC endpoint, never a default Host owner. */
export function createRpcExternalInputAuthority(options: { socketPath: string; executionHostId: string }): AgentExternalInputAuthorityPort {
  const read = async <T>(call: (rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>>) => Promise<T>): Promise<T> => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: options.socketPath } })
    try { return await call(rpc) } finally { await rpc.dispose() }
  }
  return createConnectionExternalInputAuthority({ executionHostId: options.executionHostId, ingress: async () => ({
    authority: input => read(rpc => rpc.call('connection.ingress.authority', input)),
    recordAuthority: input => read(rpc => rpc.call('connection.ingress.record-authority', input))
  }) })
}
