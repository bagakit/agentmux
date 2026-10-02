import type { AgentMuxPreloadApi } from '../../shared/contracts'

declare global {
  const __AGENTMUX_WEB_PREVIEW__: boolean

  // The desktop Chromium exposes this standard API before our TypeScript DOM
  // library includes its declaration.
  interface Element {
    moveBefore(node: Node, child: Node | null): void
  }

  interface Window {
    agentmux?: AgentMuxPreloadApi
  }
}

export {}
