import { connectAgentMuxRpc, connectHostedAgentMux } from '@agentmux/core'
import type { AgentMuxHostedRpcPort } from '@agentmux/core/hosted'
import type { DesktopRuntimeConnector } from '../../src/main/desktop-host.js'
import type { DesktopRuntimeClient } from '../../src/main/desktop-host.js'

export function runtimeOwnerIdentity(client: DesktopRuntimeClient | undefined) {
  return client && 'runtimeOwnerIdentity' in client ? client.runtimeOwnerIdentity() : null
}

/** Private real owners qualify Desktop behavior; only SSH selection/scheduling is controlled. */
export function privateRuntimeConnector(localSocket: string, remoteSocket: (hostname: string) => string,
  beforeRemote?: (hostname: string) => Promise<void>): DesktopRuntimeConnector {
  return async config => {
    const hostname = config.kind === 'ssh' ? config.hostname : null
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix',
      path: hostname === null ? localSocket : remoteSocket(hostname) } })
    let ready: Promise<void> | undefined
    const prepare = () => ready ??= hostname === null ? Promise.resolve() : beforeRemote?.(hostname) ?? Promise.resolve()
    const port: AgentMuxHostedRpcPort = {
      call: async (method, params, options) => { await prepare(); return await rpc.call(method, params, options) },
      subscribe: async (method, params, handlers) => { await prepare(); return await rpc.subscribe(method, params, handlers) }
    }
    const client = await connectHostedAgentMux({ rpc: port, waitForReady: false,
      ...(config.kind === 'ssh' && config.runtimeId ? { expectedRuntimeId: config.runtimeId } : {}) })
    const dispose = client.dispose.bind(client)
    client.dispose = async () => { try { await dispose() } finally { await rpc.dispose() } }
    return client
  }
}
