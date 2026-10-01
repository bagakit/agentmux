/** One addressable page, with its actual transport capabilities. No host UI or profile object. */
export type AgentMuxBrowserTarget = {
  id: string
  workspaceId: string | null
  source: 'embedded' | 'external'
  status: 'ready' | 'disconnected' | 'revoked' | 'closed' | 'unavailable'
  url: string
  title: string
  navigationId: string
  capabilities: readonly string[]
  /** Present when the target exposes a bounded CDP subset rather than all engine commands. */
  cdpMethods?: readonly string[]
  warning?: string
}

/** Only the person-facing Desktop API supplies a pairing secret. Never a Control result. */
export type AgentMuxExternalBrowserPairing = { link: string; expiresAt: number }
