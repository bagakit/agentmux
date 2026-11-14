import { AgentMuxError } from './errors.js'
import { rpcCount, rpcRecord, rpcString } from './rpc-data.js'
import { connectAgentMuxRpc, type AgentMuxRpcClient } from './public-rpc-client.js'
import { agentMuxSshEndpoint, type AgentMuxSshRuntimeTarget } from './ssh-runtime-target.js'
import type { AgentMuxRpcCredentials, AgentMuxRpcEndpoint } from './public-rpc.js'
import type { AgentMuxRuntimeFence } from './hosted-client-contract.js'

export type AgentMuxCliSource = { configuredHostId: string; runtimeId: string; ownerInstanceId: string }
type CliRpc = Pick<AgentMuxRpcClient, 'call' | 'subscribe' | 'dispose'> & { source?: AgentMuxCliSource }

/** Project only transport fields. The original application still owns Host configuration. */
function savedTarget(value: Record<string, unknown>, hostId: string): { target: AgentMuxSshRuntimeTarget; runtimeId: string } {
  if (value.kind !== 'ssh') throw new AgentMuxError('--source-host selects a saved SSH Host. Use the original default or explicit endpoint for a local Host.', 'INVALID_CLI_ARGUMENT')
  if (typeof value.runtimeId !== 'string' || !value.runtimeId.length) throw new AgentMuxError('The selected Host has no confirmed Runtime binding. Keep its configuration and use settings hosts inspect; no connection or configuration was changed.', 'RUNTIME_OWNER_UNCONFIRMED')
  const target: AgentMuxSshRuntimeTarget = { hostId, hostname: value.transport === 'tailcat' && value.hostname === '' ? '' : rpcString(value.hostname, 'Saved SSH hostname') }
  for (const key of ['user', 'identityFile', 'remoteCommand', 'remoteSocketPath'] as const) {
    if (value[key] !== undefined) target[key] = rpcString(value[key], `Saved SSH ${key}`)
  }
  if (value.port !== undefined) {
    target.port = rpcCount(value.port, 22, 65535)
    if (!target.port) throw new AgentMuxError('Saved SSH port is invalid.', 'INVALID_CONTROL_REQUEST')
  }
  if (value.transport !== undefined) {
    if (value.transport !== 'ssh' && value.transport !== 'ssh-tailcat' && value.transport !== 'tailcat') throw new AgentMuxError('Saved Host transport is invalid.', 'INVALID_CONTROL_REQUEST')
    target.transport = value.transport
  }
  if (value.transport === 'ssh-tailcat' || value.transport === 'tailcat') {
    const tailcat = rpcRecord(value.tailcat, ['address', 'keyFile'])
    target.tailcat = { address: rpcString(tailcat.address, 'Saved Tailcat address'), keyFile: rpcString(tailcat.keyFile, 'Saved Tailcat key file') }
  }
  return { target, runtimeId: rpcString(value.runtimeId, 'Saved Source Runtime') }
}

/** One immutable saved target and original caller; never a second routing or authorization owner. */
export async function connectAgentMuxCliSource(options: {
  endpoint: AgentMuxRpcEndpoint; sourceHost?: string; credentials?: AgentMuxRpcCredentials
}): Promise<CliRpc> {
  const credentials = options.credentials ? { credentials: options.credentials } : {}
  if (options.sourceHost === undefined) return await connectAgentMuxRpc({ endpoint: options.endpoint, ...credentials })
  if (options.endpoint.transport !== 'unix') throw new AgentMuxError('--source-host requires the original local Unix configuration service. Remote configuration key paths cannot be used as local credentials; use its explicit endpoint instead.', 'INVALID_CLI_ARGUMENT')
  const configuration = await connectAgentMuxRpc({ endpoint: options.endpoint, ...credentials })
  let selected: ReturnType<typeof savedTarget>
  try {
    const { hosts } = await configuration.call('settings.hosts.ls', {})
    const matches = hosts.filter(host => host.id === options.sourceHost)
    if (matches.length !== 1) throw new AgentMuxError('The exact saved Source Host is unknown or ambiguous. Read settings hosts ls on this configuration service; no alternative was selected.', matches.length ? 'AMBIGUOUS_HOST' : 'UNKNOWN_HOST')
    selected = savedTarget(matches[0]!, options.sourceHost)
  } finally { await configuration.dispose() }
  const source = await connectAgentMuxRpc({ endpoint: agentMuxSshEndpoint(selected.target), ...credentials })
  try {
    // This authenticated facade exposes the same semantic identity to an Agent.
    // Its optional launch contracts never gate unrelated Source operations.
    const { source: original } = await source.call('agent.open.describe', { expectedRuntimeId: selected.runtimeId })
    const fence: AgentMuxRuntimeFence = { runtimeId: original.runtimeId, ownerInstanceId: original.ownerInstanceId }
    const fixed = (given?: AgentMuxRuntimeFence): AgentMuxRuntimeFence => {
      if (given && (given.runtimeId !== fence.runtimeId || given.ownerInstanceId !== fence.ownerInstanceId)) throw new AgentMuxError('This command supplied another Source Runtime or owner instance. Keep its original request; no action was rerouted.', 'RUNTIME_OWNER_MISMATCH')
      return fence
    }
    return {
      source: { configuredHostId: options.sourceHost, ...fence },
      call: (method, params, options) => source.call(method, params, { ...options, runtimeFence: fixed(options?.runtimeFence) }),
      subscribe: (method, params, handlers) => source.subscribe(method, params, { ...handlers, runtimeFence: fixed(handlers.runtimeFence) }),
      dispose: () => source.dispose()
    }
  } catch (error) { await source.dispose(); throw error }
}
