import type { AgentProvider } from './agent-provider.js'
import { AgentMuxClient } from './client.js'
import { connectHostedAgentMux } from './hosted-client.js'
import type { AgentMuxHostedClient } from './hosted-client-contract.js'
import { connectAgentMuxRpc, type AgentMuxPreparedSshRoute } from './public-rpc-client.js'
import type { AgentMuxRpcEndpoint } from './public-rpc.js'
export type { AgentMuxRuntimeOwnerIdentity } from './hosted-client-contract.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'

export type AgentMuxRuntimeClient = AgentMuxClient | AgentMuxHostedClient

export type AgentMuxSshHostedClient = AgentMuxHostedClient & {
  /** Validate and update the launcher for future SSH channels, retaining current readers. */
  setRemoteCommand(command?: string): void
  /** Prepare only the authenticated semantic identity; adoption retains this consumer. */
  prepareRoute(target: AgentMuxSshRuntimeClientOptions['target'], signal?: AbortSignal): Promise<AgentMuxPreparedSshRoute>
}

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

/** One mapping for connection, route repair and explicit configuration inspection. */
export function agentMuxSshEndpoint(target: AgentMuxSshRuntimeClientOptions['target']): Extract<AgentMuxRpcEndpoint, { transport: 'ssh' }> {
  return { transport: 'ssh', host: target.hostname,
    ...(target.user === undefined ? {} : { user: target.user }), ...(target.port === undefined ? {} : { port: target.port }),
    ...(target.identityFile === undefined ? {} : { identityFile: target.identityFile }),
    ...(target.remoteCommand === undefined ? {} : { command: target.remoteCommand }),
    ...(target.remoteSocketPath === undefined ? {} : { socketPath: target.remoteSocketPath }) }
}

/** Connect physical Run capabilities without awaiting Session/catalog observation.
 * Call client.connect() explicitly to load semantics; failures remain diagnostic
 * and can be retried on this same Client without replacing healthy Runs.
 */
export async function connectLocalAgentMuxRuntime(
  options: AgentMuxLocalRuntimeClientOptions = {}
): Promise<AgentMuxClient> {
  const client = new AgentMuxClient({
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.store === undefined ? {} : { store: options.store })
  })
  await client.connectRuntime()
  return client
}

/** Return only after the complete Session/catalog observation has succeeded. */
export async function connectLocalAgentMux(
  options: AgentMuxLocalRuntimeClientOptions = {}
): Promise<AgentMuxClient> {
  const client = await connectLocalAgentMuxRuntime(options)
  try { await client.connect(); return client }
  catch (error) {
    // A rejected factory cannot hand its observation resources to a caller.
    // Disposing this Client releases those resources without stopping its Runs.
    try { await client.dispose() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Session observation failed and Client cleanup was incomplete.') }
    throw error
  }
}

export async function connectSshAgentMux(
  options: AgentMuxSshRuntimeClientOptions
): Promise<AgentMuxSshHostedClient> {
  // This endpoint belongs only to this consumer and its RPC transport. Updating
  // its launcher does not replace the current channel or any observation lease.
  const endpoint = agentMuxSshEndpoint(options.target)
  const rpc = await connectAgentMuxRpc({ endpoint })
  try {
    const client = await connectHostedAgentMux({ rpc,
      ...(options.expectedRuntimeId === undefined ? {} : { expectedRuntimeId: options.expectedRuntimeId }),
      ...(options.waitForReady === undefined ? {} : { waitForReady: options.waitForReady }),
      ...(options.consumerId === undefined ? {} : { consumerId: options.consumerId }),
      subscribeRpc: (method, params, handlers) => rpc.subscribe(method, params, handlers),
      forwardRpc: (method, params, context = {}) => {
        if (context.principal?.kind === 'device' && !context.forwarding) {
          throw new AgentMuxError('The original device forwarding authority is unavailable.', 'CONTROL_UNAVAILABLE')
        }
        return rpc.call(method, params, {
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          ...(context.caller === undefined ? {} : { credentials: context.caller }),
          ...(context.runtimeFence === undefined ? {} : { runtimeFence: context.runtimeFence }),
          ...(context.principal?.kind === 'device' ? { forwarding: context.forwarding! } : {})
        })
      }
    })
    const releaseConsumer = client.dispose
    client.dispose = async () => { try { await releaseConsumer() } finally { await rpc.dispose() } }
    return Object.assign(client, { async prepareRoute(target: AgentMuxSshRuntimeClientOptions['target'], signal?: AbortSignal) {
      const expected = options.expectedRuntimeId ?? client.runtimeOwnerIdentity()?.runtimeId
      if (!expected || target.hostId !== options.target.hostId) throw new AgentMuxError('Route repair requires the original bound SSH Host.', 'INVALID_CONTROL_REQUEST')
      const next = agentMuxSshEndpoint(target)
      return await rpc.prepareSshRoute(next, expected, signal)
    }, setRemoteCommand(command?: string): void {
      rpc.setSshRemoteCommand(command)
    } })
  } catch (error) { await rpc.dispose(); throw error }
}
