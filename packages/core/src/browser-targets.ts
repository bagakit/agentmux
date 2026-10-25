export type AgentMuxBrowserMode = 'normal' | 'private'

/** Original native TLS request awaiting the person. Discovery grants no approval. */
export type AgentMuxBrowserCertificateRequest = {
  requestId: string
  navigationId: string
  url: string
  error: string
  fingerprint: string
  subject: string
  issuer: string
  validFrom: string
  validTo: string
  /** Native accepted connections can be reused by pages sharing this Profile. */
  scope: 'profile-connections'
}

/** Original native page request. This provenance grants no input or navigation authority. */
export type AgentMuxBrowserSource = {
  browserId: string
  navigationId: string
  /** Exact presentation at creation, when the original owner could confirm it. */
  location?: { displayWorkspaceId: string; groupId: string; tabId: string; regionId: string }
}

/** Current host-owned input facts. A retained operation alone grants no control. */
export type AgentMuxBrowserControl = {
  /** Current host-owned input recipient; Agent ownership survives execution completion until explicit handoff. */
  owner: 'agent' | 'human' | 'unknown'
  activeOperationId: string | null
  revision: number
  inputIsolation: 'inactive' | 'preparing' | 'isolated' | 'unconfirmed' | 'unsupported'
  /** Confirmed Browser association, independent of input ownership. Null is none; absence is unknown. */
  agent?: { hostId: string; agentSessionId: string } | null
}

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
  openedFrom?: AgentMuxBrowserSource
  capabilities: readonly string[]
  /** Present when the target exposes a bounded CDP subset rather than all engine commands. */
  cdpMethods?: readonly string[]
  control?: AgentMuxBrowserControl
  certificateRequest?: AgentMuxBrowserCertificateRequest | null
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
