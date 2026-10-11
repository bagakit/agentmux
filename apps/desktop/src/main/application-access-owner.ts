import { AgentMuxApplicationAccessOwner, AgentMuxError } from '@agentmux/core'
import type { RuntimeController } from './runtime-controller.js'

/** Process-scoped owner. Window IPC borrows this instance and never owns its write queue. */
export function createDesktopApplicationAccessOwner(runtime: RuntimeController, path: string): AgentMuxApplicationAccessOwner {
  return new AgentMuxApplicationAccessOwner({ path, async resolveHost(hostId) {
    const entries = runtime.rpcClients().filter(entry => entry.hostId === hostId)
    if (entries.length !== 1) throw new AgentMuxError('The exact application execution Host is unavailable. Existing Agents are retained.', 'APPLICATION_ACCESS_HOST_UNAVAILABLE')
    const client = entries[0]!.client, executionHost = runtime.executionHost(hostId)
    await client.connect()
    const identity = 'runtimeOwnerIdentity' in client ? client.runtimeOwnerIdentity() : null
    if (!identity || identity.availability !== 'connected') throw new AgentMuxError('The original semantic Runtime identity is unconfirmed. Existing Agents are retained.', 'APPLICATION_ACCESS_RUNTIME_UNCONFIRMED')
    const assertCurrent = () => {
      const current = runtime.rpcClients().filter(entry => entry.hostId === hostId), owner = 'runtimeOwnerIdentity' in client ? client.runtimeOwnerIdentity() : null
      if (current.length !== 1 || current[0]!.client !== client || runtime.executionHost(hostId) !== executionHost || owner?.runtimeId !== identity.runtimeId || owner.availability !== 'connected') throw new AgentMuxError('The original application execution route changed. Inspect it again before this action.', 'APPLICATION_ACCESS_HOST_CHANGED')
    }
    assertCurrent()
    return { executionHost, runtimeId: identity.runtimeId, assertCurrent }
  } })
}
