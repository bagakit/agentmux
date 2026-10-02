import type { AgentProvider } from './agent-provider.js'
import { AgentMuxClient } from './client.js'
import { connectHostedAgentMux } from './hosted-client.js'
import type { AgentMuxHostedClient } from './hosted-client-contract.js'
import { connectAgentMuxRpc } from './public-rpc-client.js'
export type { AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'

export type AgentMuxRuntimeClient = AgentMuxClient | AgentMuxHostedClient

type AgentMuxRuntimeClientCommonOptions = {
  providers?: readonly AgentProvider[]
  store?: AgentMuxAgentSessionStore
}

export type AgentMuxLocalRuntimeClientOptions = AgentMuxRuntimeClientCommonOptions

export type AgentMuxSshRuntimeClientOptions = {
  expectedRuntimeId?: string
  waitForReady?: boolean
  consumerId?: string
  target: {
    hostId: string
    hostname: string
    user?: string
    port?: number
    identityFile?: string
    remoteCommand?: string
    remoteSocketPath?: string
  }
}

export async function connectLocalAgentMux(
  options: AgentMuxLocalRuntimeClientOptions = {}
): Promise<AgentMuxClient> {
  const client = new AgentMuxClient({
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.store === undefined ? {} : { store: options.store })
  })
  await client.connect()
  return client
}

export async function connectSshAgentMux(
  options: AgentMuxSshRuntimeClientOptions
): Promise<AgentMuxHostedClient> {
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'ssh', host: options.target.hostname,
    ...(options.target.user === undefined ? {} : { user: options.target.user }),
    ...(options.target.port === undefined ? {} : { port: options.target.port }),
    ...(options.target.identityFile === undefined ? {} : { identityFile: options.target.identityFile }),
    ...(options.target.remoteCommand === undefined ? {} : { command: options.target.remoteCommand }),
    ...(options.target.remoteSocketPath === undefined ? {} : { socketPath: options.target.remoteSocketPath })
  } })
  try {
    const client = await connectHostedAgentMux({ rpc,
      ...(options.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: options.expectedRuntimeId }),
      ...(options.waitForReady === undefined ? {} : { waitForReady: options.waitForReady }),
      ...(options.consumerId === undefined ? {} : { consumerId: options.consumerId }),
      forwardRpc: (method, params, context = {}) => rpc.call(method, params, {
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(context.caller === undefined ? {} : { credentials: context.caller }),
        ...(context.runtimeFence === undefined ? {} : { runtimeFence: context.runtimeFence })
      })
    })
    const releaseConsumer = client.dispose
    client.dispose = async () => { try { await releaseConsumer() } finally { await rpc.dispose() } }
    return client
  } catch (error) { await rpc.dispose(); throw error }
}
