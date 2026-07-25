import type { AgentMuxPreloadApi } from '../../shared/contracts'

declare global {
  const __AGENTMUX_WEB_PREVIEW__: boolean

  interface Window {
    agentmux?: AgentMuxPreloadApi
  }
}

export {}
