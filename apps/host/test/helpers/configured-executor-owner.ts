import { join } from 'node:path'
import { AgentMuxCreationAuthority } from '../../../../packages/core/src/agent-creation-authority.js'
import { AgentMuxHostExecutorOwner } from '../../../../packages/core/src/executor-owner.js'
import { AgentProviderRegistry } from '../../../../packages/core/src/agent-provider.js'
import type { AgentMuxClientOptions } from '../../../../packages/core/src/client-contract.js'
import { readConfiguredExecutors } from '../../src/mote-resources.js'

/** Constructor injection keeps creation and recovery on the same real Host owners. */
export function fixtureHostExecutorOptions(configurationPath: () => string): (root: string) => Omit<AgentMuxClientOptions, 'store'> {
  return root => {
    const runtimeId = 'fixture-original-execution-host', providers = new AgentProviderRegistry()
    return {
      hostExecutorOwner: new AgentMuxHostExecutorOwner({ path: join(root, 'host-executors.json'), runtimeId,
        catalog: () => providers.catalog(), configurations: id => readConfiguredExecutors(configurationPath(), id) }),
      creationAuthority: new AgentMuxCreationAuthority({ stateDirectory: join(root, 'creation-authority'), runtimeId })
    }
  }
}
