import type { AgentMuxPermissionHandler } from './acp-adapter.js'
import type { AgentProvider } from './agent-provider.js'
import { AgentMuxClient } from './client.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'

type AgentMuxRuntimeClientCommonOptions = {
  providers?: readonly AgentProvider[]
  store?: AgentMuxAgentSessionStore
  permissionHandler?: AgentMuxPermissionHandler
}

export type AgentMuxLocalRuntimeClientOptions = AgentMuxRuntimeClientCommonOptions

export type AgentMuxSshRuntimeClientOptions = AgentMuxRuntimeClientCommonOptions & {
  target: {
    hostId: string
    hostname: string
    user?: string
    port?: number
    identityFile?: string
  }
}

export async function connectLocalAgentMux(
  options: AgentMuxLocalRuntimeClientOptions = {}
): Promise<AgentMuxClient> {
  const client = new AgentMuxClient({
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.permissionHandler === undefined ? {} : { permissionHandler: options.permissionHandler })
  })
  await client.connect()
  return client
}

export async function connectSshAgentMux(
  _options: AgentMuxSshRuntimeClientOptions
): Promise<AgentMuxClient> {
  throw new AgentMuxError(
    'Remote AgentMux Runs are not available until the ctxmux Remote contract is delivered.',
    'REMOTE_UNSUPPORTED'
  )
}
