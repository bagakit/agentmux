export type AgentMuxBrowserMode = 'normal' | 'private'

/** Main returned a healthy original page that does not match this explicit Profile request. */
export type AgentMuxBrowserOpenProfileMismatch = {
  kind: 'browser-open-profile-mismatch'
  operationId: string
  browserId: string
  profileId: string | null
  mode: AgentMuxBrowserMode
  requestedProfileId: string
}

/** A foreign returned ID is an observation, never this operation's confirmed creation. */
export type AgentMuxBrowserOpenIdentityMismatch = {
  kind: 'browser-open-identity-mismatch'
  operationId: string
  requestedBrowserId: string
  returnedBrowserId: string
  creation: 'unconfirmed'
}
export type AgentMuxBrowserOpenMismatch = AgentMuxBrowserOpenProfileMismatch | AgentMuxBrowserOpenIdentityMismatch

export type { BrowserSitePermission, BrowserSitePermissionRequest, BrowserSitePermissionDecision, BrowserSitePermissionState } from './browser-site-permissions.js'

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
/** The Browser Profile a normal page uses: its id and the label Main lists for it. */
export type AgentMuxBrowserProfileRef = { id: string; label: string }

export type AgentMuxBrowserDialogType = 'alert' | 'confirm' | 'prompt' | 'beforeunload'

export type AgentMuxBrowserTarget = {
  id: string
  workspaceId: string | null
  source: 'embedded' | 'external' | 'standalone'
  /** Only present when the original page owner knows its storage mode. */
  mode?: AgentMuxBrowserMode
  /** A normal embedded page's Profile; absent for private pages, Capsules, external tabs and unknown ownership. */
  profile?: AgentMuxBrowserProfileRef
  status: 'ready' | 'disconnected' | 'revoked' | 'closed' | 'unavailable'
  url: string
  /** Stable original resource reference when known; url remains the actual document address. */
  objectLink?: string
  title: string
  /** Absent when an embedded durable description has no native document yet. */
  navigationId?: string
  openedFrom?: AgentMuxBrowserSource
  /** Host-supported native dialog kinds; absent is unknown, not approval or current readiness. */
  dialogTypes?: readonly AgentMuxBrowserDialogType[]
  capabilities: readonly string[]
  /** Present when the target exposes a bounded CDP subset rather than all engine commands. */
  cdpMethods?: readonly string[]
  control?: AgentMuxBrowserControl
  certificateRequest?: AgentMuxBrowserCertificateRequest | null
  /** Native requests and saved choices are observations, never a public approval channel. */
  sitePermissions?: import('./browser-site-permissions.js').BrowserSitePermissionState
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
