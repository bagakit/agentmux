import {
  LocalExecutionHost,
  SshExecutionHost,
  HostedExecutionHost,
  connectSshAgentMux,
  type ExecutionHost
} from '@agentmux/core'
import type { HostConfig } from '../shared/contracts.js'

export function createExecutionHost(config: HostConfig): ExecutionHost {
  if (config.kind === 'local') return new LocalExecutionHost({ id: config.id, label: config.label })
  if (config.transport === 'tailcat' || config.transport === 'ssh-tailcat') return new HostedExecutionHost({
    id: config.id, label: config.label,
    connect: () => connectSshAgentMux({ ...(config.runtimeId ? { expectedRuntimeId: config.runtimeId } : {}),
      target: { ...config, hostId: config.id } })
  })
  return new SshExecutionHost({
    id: config.id,
    label: config.label,
    hostname: config.hostname,
    connectTimeoutSeconds: 20,
    ...(config.user ? { user: config.user } : {}),
    ...(config.port ? { port: config.port } : {}),
    ...(config.identityFile ? { identityFile: config.identityFile } : {})
  })
}
