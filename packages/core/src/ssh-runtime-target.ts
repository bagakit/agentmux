import { AgentMuxError } from './errors.js'
import type { AgentMuxRpcRemoteEndpoint, AgentMuxTailcatTarget } from './public-rpc.js'

/** A saved remote Host's connection target; the same shape connects, repairs routes and is inspected. */
export type AgentMuxSshRuntimeTarget = {
  hostId: string
  hostname: string
  user?: string
  port?: number
  identityFile?: string
  remoteCommand?: string
  remoteSocketPath?: string
  transport?: 'ssh' | 'ssh-tailcat' | 'tailcat'
  tailcat?: AgentMuxTailcatTarget
}

/**
 * One mapping for connection, route repair and explicit configuration inspection. It is a pure
 * function of the saved target, kept apart from the Runtime client so that readers of a Host's
 * configuration (and the CLI that loads them) do not load the in-process Core client.
 */
export function agentMuxSshEndpoint(target: AgentMuxSshRuntimeTarget): AgentMuxRpcRemoteEndpoint {
  if (target.transport !== undefined && !['ssh', 'ssh-tailcat', 'tailcat'].includes(target.transport)) throw new AgentMuxError('Unknown remote transport selection.', 'INVALID_CONTROL_REQUEST')
  if (target.transport === 'tailcat' || target.transport === 'ssh-tailcat') {
    if (!target.tailcat) throw new AgentMuxError('Tailcat connection requires its saved address and client key.', 'INVALID_CONTROL_REQUEST')
    if (target.transport === 'tailcat') return { transport: 'tailcat', ...target.tailcat }
  }
  return { transport: 'ssh', host: target.hostname,
    ...(target.transport === 'ssh-tailcat' ? { tailcat: target.tailcat! } : {}),
    ...(target.user === undefined ? {} : { user: target.user }), ...(target.port === undefined ? {} : { port: target.port }),
    ...(target.identityFile === undefined ? {} : { identityFile: target.identityFile }),
    ...(target.remoteCommand === undefined ? {} : { command: target.remoteCommand }),
    ...(target.remoteSocketPath === undefined ? {} : { socketPath: target.remoteSocketPath }) }
}
