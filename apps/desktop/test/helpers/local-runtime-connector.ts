import { connectLocalAgentMux, connectSshAgentMux } from '@agentmux/core'
import type { DesktopRuntimeConnector } from '../../src/main/desktop-host.js'

/** Test hosts explicitly choose their own private/mock Core. Product always injects the Host connector. */
export const localRuntimeConnector: DesktopRuntimeConnector = async (config, store) => {
  if (config.kind === 'local') return await connectLocalAgentMux({ store })
  return await connectSshAgentMux({ store, target: { hostId: config.id, hostname: config.hostname,
    ...(config.user ? { user: config.user } : {}), ...(config.port ? { port: config.port } : {}),
    ...(config.identityFile ? { identityFile: config.identityFile } : {}) } })
}
