import type { AgentMuxPermissionHandler } from './acp-adapter.js'
import type { AgentProvider } from './agent-provider.js'
import { AgentMuxClient } from './client.js'
import type { AgentMuxAgentSessionStore } from './agent-session-store.js'
import { activateAgentMuxLocalDaemon } from './local-daemon.js'
import { SshAgentMuxDaemonConnector } from './ssh-daemon-connector.js'

type AgentMuxRuntimeClientCommonOptions = {
  providers?: readonly AgentProvider[]
  store?: AgentMuxAgentSessionStore
  permissionHandler?: AgentMuxPermissionHandler
}

export type AgentMuxLocalRuntimeClientOptions = AgentMuxRuntimeClientCommonOptions & {
  endpointPath?: string
  statePath?: string
}

export type AgentMuxSshRuntimeClientOptions = AgentMuxRuntimeClientCommonOptions & {
  target: {
    hostId: string
    hostname: string
    user?: string
    port?: number
    identityFile?: string
  }
  runtime: {
    buildIdentity: string
    remoteNodePath: string
    remoteEntrypointPath: string
    remoteEndpointPath: string
  }
  sshCommand?: string
}

export async function connectLocalAgentMux(
  options: AgentMuxLocalRuntimeClientOptions = {}
): Promise<AgentMuxClient> {
  await activateAgentMuxLocalDaemon({
    ...(options.endpointPath === undefined ? {} : { socketPath: options.endpointPath }),
    ...(options.statePath === undefined ? {} : { statePath: options.statePath })
  })
  const client = new AgentMuxClient({
    ...(options.endpointPath === undefined ? {} : { socketPath: options.endpointPath }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.permissionHandler === undefined ? {} : { permissionHandler: options.permissionHandler })
  })
  await client.connect()
  return client
}

export async function connectSshAgentMux(
  options: AgentMuxSshRuntimeClientOptions
): Promise<AgentMuxClient> {
  const client = new AgentMuxClient({
    connector: new SshAgentMuxDaemonConnector({
      target: options.target,
      remoteNodePath: options.runtime.remoteNodePath,
      remoteAgentMuxdPath: options.runtime.remoteEntrypointPath,
      remoteSocketPath: options.runtime.remoteEndpointPath,
      expectedBuildIdentity: options.runtime.buildIdentity,
      ...(options.sshCommand === undefined ? {} : { sshCommand: options.sshCommand })
    }),
    ...(options.providers === undefined ? {} : { providers: options.providers }),
    ...(options.store === undefined ? {} : { store: options.store }),
    ...(options.permissionHandler === undefined ? {} : { permissionHandler: options.permissionHandler })
  })
  await client.connect()
  return client
}
