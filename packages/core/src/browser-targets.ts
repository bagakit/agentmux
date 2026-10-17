export type AgentMuxBrowserMode = 'normal' | 'private'

/** One addressable page, with its actual transport capabilities. No host UI or profile object. */
export type AgentMuxBrowserTarget = {
  id: string
  workspaceId: string | null
  source: 'embedded' | 'external'
  /** Only present when the original page owner knows its storage mode. */
  mode?: AgentMuxBrowserMode
  status: 'ready' | 'disconnected' | 'revoked' | 'closed' | 'unavailable'
  url: string
  title: string
  /** Absent when an embedded durable description has no native document yet. */
  navigationId?: string
  capabilities: readonly string[]
  /** Present when the target exposes a bounded CDP subset rather than all engine commands. */
  cdpMethods?: readonly string[]
  resource?: AgentMuxBrowserResource
  warning?: string
}

/** Coverage describes membership of this query, not native readiness or process observation. */
export type AgentMuxBrowserTargetsResult = {
  targets: AgentMuxBrowserTarget[]
  coverage: 'complete' | 'partial'
  warning?: string
}

/** Only the person-facing Desktop API supplies a pairing secret. Never a Control result. */
export type AgentMuxExternalBrowserPairing = { link: string; expiresAt: number }

/** Native owner facts only; absence is unknown, never permission to discard a page. */
export type AgentMuxBrowserRetentionReason =
  | 'visible' | 'presentation' | 'operation' | 'loading' | 'profile-switch' | 'selection'
  | 'media' | 'download' | 'upload' | 'debugger' | 'document-used' | 'document-unconfirmed'
  | 'source-changed' | 'close-unconfirmed' | 'beforeunload' | 'owner-unavailable'
export type AgentMuxBrowserRetention = {
  status: 'eligible' | 'retained' | 'unknown'
  reasons: readonly AgentMuxBrowserRetentionReason[]
}
export type AgentMuxBrowserReleaseReceipt = {
  browserId: string
  navigationId: string
  status: 'released' | 'retained' | 'unknown'
  reasons: readonly AgentMuxBrowserRetentionReason[]
}

/** Current owner facts joined with durable positions; never another lifecycle registry. */
export type AgentMuxBrowserResource = {
  state: 'live' | 'released' | 'cold' | 'unknown'
  locations: readonly { workspaceId: string | null; tabId: string; regionId: string }[]
  /** null means native ownership was not completely observed, not an empty process. */
  processes: readonly { pid: number; creationTime: number }[] | null
  retention?: AgentMuxBrowserRetention
}
