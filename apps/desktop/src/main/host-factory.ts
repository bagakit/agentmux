import {
  LocalExecutionHost,
  SshExecutionHost,
  type ExecutionHost
} from '@agentmux/core'
import type { HostConfig } from '../shared/contracts.js'

export function createExecutionHost(config: HostConfig): ExecutionHost {
  if (config.kind === 'local') return new LocalExecutionHost({ id: config.id, label: config.label })
  return new SshExecutionHost({
    id: config.id,
    label: config.label,
    hostname: config.hostname,
    ...(config.user ? { user: config.user } : {}),
    ...(config.port ? { port: config.port } : {}),
    ...(config.identityFile ? { identityFile: config.identityFile } : {})
  })
}
