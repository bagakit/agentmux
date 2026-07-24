import type { AgentMuxDesktopApi } from '../../shared/contracts'

declare global {
  const __AGENTMUX_WEB_PREVIEW__: boolean

  interface Window {
    agentmux?: AgentMuxDesktopApi
  }
}

export {}
