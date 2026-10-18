import type { AgentMuxDesktopApi, AgentMuxPreloadApi } from '../../../shared/contracts'
import { unwrapToolkitConfigurationResult } from '../../../shared/toolkit-configuration-result'

export function createToolkitConfigurationApi(transport: AgentMuxPreloadApi['toolkit']): AgentMuxDesktopApi['toolkit'] {
  return { ...transport,
    add: (...args) => transport.add(...args).then(unwrapToolkitConfigurationResult),
    update: (...args) => transport.update(...args).then(unwrapToolkitConfigurationResult),
    remove: (...args) => transport.remove(...args).then(unwrapToolkitConfigurationResult)
  }
}
