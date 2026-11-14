import { rpcRecord } from './rpc-data.js'
import type { AgentMuxBrowserControl, AgentMuxBrowserSource, AgentMuxBrowserTarget, AgentMuxBrowserTargetsResult, AgentMuxBrowserResource, AgentMuxBrowserReleaseReceipt, AgentMuxBrowserRetention, AgentMuxBrowserNavigationObservation } from './browser-targets.js'
import { BROWSER_PAGE_CAPABILITY_NAMES } from './browser-page-capability.js'
import { AgentMuxError } from './errors.js'
import { parseAmuxObjectLink } from './sharing.js'
import type { AgentMuxBrowserCertificateRequest } from './browser-targets.js'

function parseBrowserCertificateRequest(value: unknown): AgentMuxBrowserCertificateRequest {
  const row = record(value)
  const keys = ['requestId', 'navigationId', 'url', 'error', 'fingerprint', 'subject', 'issuer', 'validFrom', 'validTo', 'scope']
  if (Object.keys(row).some(key => !keys.includes(key)) || row.scope !== 'profile-connections' ||
    typeof row.fingerprint !== 'string' || !/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(row.fingerprint)) {
    throw new AgentMuxError('Browser certificate request is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  const url = text(row.url, 8192)
  try { if (new URL(url).protocol !== 'https:') throw new Error() }
  catch { throw new AgentMuxError('Browser certificate URL is invalid.', 'CONTROL_PROTOCOL_ERROR') }
  return { requestId: text(row.requestId, 200), navigationId: text(row.navigationId, 200), url,
    error: text(row.error, 2000), fingerprint: row.fingerprint, subject: text(row.subject, 65536, true),
    issuer: text(row.issuer, 65536, true), validFrom: text(row.validFrom, 200), validTo: text(row.validTo, 200), scope: 'profile-connections' }
}

const sources = new Set(['embedded', 'external', 'standalone'])
const statuses = new Set(['ready', 'disconnected', 'revoked', 'closed', 'unavailable'])
const capabilities = new Set(BROWSER_PAGE_CAPABILITY_NAMES)
const BROWSER_TARGET_TITLE_LIMIT = 512

/** Bounded display title for a public target; the source keeps the original title. */
export function projectBrowserTargetTitle(title: string): string {
  if (title.length <= BROWSER_TARGET_TITLE_LIMIT) return title
  return title.slice(0, BROWSER_TARGET_TITLE_LIMIT).replace(/[\uD800-\uDBFF]$/u, '')
}

function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new AgentMuxError('Browser target fact is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
function parseBrowserNavigation(value: unknown, navigationId: unknown): AgentMuxBrowserNavigationObservation {
  const row = record(value), keys = ['requestedUrl', 'documentUrl', 'navigationId', 'committedNavigationId', 'loading', 'error']
  if (!keys.every(key => Object.hasOwn(row, key)) ||
    typeof row.requestedUrl !== 'string' || typeof row.documentUrl !== 'string' ||
    typeof row.loading !== 'boolean' || row.navigationId !== navigationId ||
    row.committedNavigationId !== null && row.committedNavigationId !== row.navigationId ||
    row.error !== null && typeof row.error !== 'string') {
    throw new AgentMuxError('Browser navigation observation is invalid for this target.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { requestedUrl: row.requestedUrl, documentUrl: row.documentUrl,
    navigationId: text(row.navigationId, 200), committedNavigationId: row.committedNavigationId === null ? null : text(row.committedNavigationId, 200),
    loading: row.loading, error: row.error }
}
export function parseBrowserControl(value: unknown): AgentMuxBrowserControl {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Browser control fact is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const row = value as Record<string, unknown>
  if (Object.keys(row).some(key => !['owner', 'activeOperationId', 'revision', 'inputIsolation', 'agent'].includes(key)) ||
    !['agent', 'human', 'unknown'].includes(String(row.owner)) ||
    !['inactive', 'preparing', 'isolated', 'unconfirmed', 'unsupported'].includes(String(row.inputIsolation)) ||
    !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) throw new AgentMuxError('Browser control fact is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const activeOperationId = row.activeOperationId
  if (activeOperationId !== null && (typeof activeOperationId !== 'string' || !activeOperationId.trim())) throw new AgentMuxError('Browser control operation identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (['preparing', 'isolated'].includes(String(row.inputIsolation)) && row.owner !== 'agent') throw new AgentMuxError('Browser isolation requires its current Agent owner.', 'CONTROL_PROTOCOL_ERROR')
  let agent: AgentMuxBrowserControl['agent']
  if (row.agent === null) agent = null
  else if (row.agent !== undefined) {
    if (!row.agent || typeof row.agent !== 'object' || Array.isArray(row.agent) ||
      Object.keys(row.agent).some(key => !['hostId', 'agentSessionId'].includes(key))) throw new AgentMuxError('Browser Agent association is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const identity = row.agent as Record<string, unknown>
    agent = { hostId: text(identity.hostId, 200), agentSessionId: text(identity.agentSessionId, 200) }
  }
  return { owner: row.owner as AgentMuxBrowserControl['owner'], activeOperationId, revision: Number(row.revision), inputIsolation: row.inputIsolation as AgentMuxBrowserControl['inputIsolation'],
    ...(agent === undefined ? {} : { agent }) }
}

export function parseBrowserSource(value: unknown): AgentMuxBrowserSource {
  const row = record(value)
  if (Object.keys(row).some(key => !['browserId', 'navigationId', 'location'].includes(key))) throw new AgentMuxError('Browser source is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const source: AgentMuxBrowserSource = { browserId: text(row.browserId, 200), navigationId: text(row.navigationId, 200) }
  if (row.location !== undefined) {
    const location = record(row.location)
    if (Object.keys(location).some(key => !['displayWorkspaceId', 'groupId', 'tabId', 'regionId'].includes(key))) throw new AgentMuxError('Browser source position is invalid.', 'CONTROL_PROTOCOL_ERROR')
    source.location = { displayWorkspaceId: text(location.displayWorkspaceId, 200), groupId: text(location.groupId, 200), tabId: text(location.tabId, 200), regionId: text(location.regionId, 200) }
  }
  return source
}
/** Discovery facts carry no pairing secret, profile or credential store. */
export function parseBrowserTargetsResult(value: unknown): AgentMuxBrowserTargetsResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Browser target discovery is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const input = value as Record<string, unknown>, coverage = input.coverage
  if (coverage !== 'complete' && coverage !== 'partial') throw new AgentMuxError('Browser target discovery coverage is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(input.targets)) throw new AgentMuxError('Browser target discovery is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const ids = new Set<string>()
  const targets = input.targets.map(raw => {
    const target = parseBrowserTarget(raw)
    if (ids.has(target.id)) throw new AgentMuxError('Browser target identity or status is invalid.', 'CONTROL_PROTOCOL_ERROR')
    ids.add(target.id)
    return target
  })
  return { targets, coverage, ...(input.warning === undefined ? {} : { warning: text(input.warning, 2000) }) }
}

/** {id,label} of one Browser Profile; nothing else about its storage crosses the wire. */
export function parseBrowserProfileRef(raw: unknown): import('./browser-targets.js').AgentMuxBrowserProfileRef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'id' && key !== 'label')) throw new AgentMuxError('Browser Profile reference is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const row = raw as Record<string, unknown>
  return { id: text(row.id, 200), label: text(row.label, 512) }
}

/** A single exact owner result is not a complete discovery catalog. */
export function parseBrowserTarget(raw: unknown): AgentMuxBrowserTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentMuxError('Browser target is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const row = raw as Record<string, unknown>
  const id = text(row.id, 200)
  if (!sources.has(String(row.source)) || !statuses.has(String(row.status))) throw new AgentMuxError('Browser target identity or status is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(row.capabilities) || row.capabilities.length > capabilities.size || row.capabilities.some(item => typeof item !== 'string' || !capabilities.has(item))) throw new AgentMuxError('Browser target capabilities are invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (row.dialogTypes !== undefined && (!Array.isArray(row.dialogTypes) || row.dialogTypes.length > 4 || new Set(row.dialogTypes).size !== row.dialogTypes.length || row.dialogTypes.some(type => typeof type !== 'string' || !['alert','confirm','prompt','beforeunload'].includes(type)))) throw new AgentMuxError('Browser target dialog types are invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (row.cdpMethods !== undefined && (!Array.isArray(row.cdpMethods) || row.cdpMethods.length > 128 || row.cdpMethods.some(item => typeof item !== 'string' || !/^[A-Z][A-Za-z]+\.[A-Za-z]+$/.test(item)))) throw new AgentMuxError('Browser target CDP subset is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const workspaceId = row.source !== 'external' && row.workspaceId === null ? null : text(row.workspaceId, 200)
  if (row.mode !== undefined && row.mode !== 'normal' && row.mode !== 'private') throw new AgentMuxError('Browser target mode is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (row.navigationId === undefined && (row.source === 'external' || row.status !== 'unavailable' || row.capabilities.length !== 0 || row.cdpMethods !== undefined)) throw new AgentMuxError('A live Browser target requires its actual navigation identity.', 'CONTROL_PROTOCOL_ERROR')
  if (row.resource !== undefined && row.source !== 'embedded') throw new AgentMuxError('External Browser resource management is unavailable.', 'CONTROL_PROTOCOL_ERROR')
  const profile = row.profile === undefined ? undefined : parseBrowserProfileRef(row.profile)
  if (profile && (row.source !== 'embedded' || row.mode === 'private')) throw new AgentMuxError('Only a normal embedded Browser has a Profile.', 'CONTROL_PROTOCOL_ERROR')
  const certificateRequest = row.certificateRequest === undefined ? undefined : row.certificateRequest === null ? null : parseBrowserCertificateRequest(row.certificateRequest)
  if (certificateRequest && (row.source !== 'embedded' || certificateRequest.navigationId !== row.navigationId)) throw new AgentMuxError('Browser certificate request belongs to another document.', 'CONTROL_PROTOCOL_ERROR')
  const sitePermissions = row.sitePermissions === undefined ? undefined : parseBrowserSitePermissionState(row.sitePermissions)
  const navigation = row.navigation === undefined ? undefined : parseBrowserNavigation(row.navigation, row.navigationId)
  if (sitePermissions && (row.source !== 'embedded' || sitePermissions.requests.some(request => request.browserId !== id ||
    request.navigationId !== row.navigationId || request.profileId !== (profile?.id ?? null)))) {
    throw new AgentMuxError('Browser permission request belongs to another native target.', 'CONTROL_PROTOCOL_ERROR')
  }
  const objectLink = row.objectLink === undefined ? undefined : text(row.objectLink, 8192)
  if (objectLink !== undefined) {
    try { parseAmuxObjectLink(objectLink) }
    catch { throw new AgentMuxError('Browser object link is invalid.', 'CONTROL_PROTOCOL_ERROR') }
  }
  return { id, workspaceId, source: row.source as AgentMuxBrowserTarget['source'],
    ...(row.mode === undefined ? {} : { mode: row.mode as 'normal' | 'private' }),
    ...(profile ? { profile } : {}),
    status: row.status as AgentMuxBrowserTarget['status'], url: text(row.url, 8192, true), title: text(row.title, BROWSER_TARGET_TITLE_LIMIT, true),
    ...(objectLink === undefined ? {} : { objectLink }),
    ...(row.navigationId === undefined ? {} : { navigationId: text(row.navigationId, 200) }), capabilities: [...row.capabilities] as string[],
    ...(navigation === undefined ? {} : { navigation }),
    ...(row.dialogTypes === undefined ? {} : { dialogTypes: [...row.dialogTypes as import('./browser-targets.js').AgentMuxBrowserDialogType[]] }),
    ...(row.openedFrom === undefined ? {} : { openedFrom: parseBrowserSource(row.openedFrom) }),
    ...(row.cdpMethods === undefined ? {} : { cdpMethods: [...row.cdpMethods as string[]] }),
    ...(row.control === undefined ? {} : { control: parseBrowserControl(row.control) }),
    ...(certificateRequest === undefined ? {} : { certificateRequest }),
    ...(sitePermissions === undefined ? {} : { sitePermissions }),
    ...(row.resource === undefined ? {} : { resource: parseBrowserResource(row.resource) }),
    ...(row.warning === undefined ? {} : { warning: text(row.warning, 2000) }) }
}

function parseBrowserSitePermissionState(value: unknown): import('./browser-site-permissions.js').BrowserSitePermissionState {
  const state = record(value)
  if (!Array.isArray(state.requests) || !Array.isArray(state.decisions)) throw new AgentMuxError('Browser site permissions are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const permission = (value: unknown): import('./browser-site-permissions.js').BrowserSitePermission => {
    if (!['camera', 'microphone', 'geolocation', 'notifications'].includes(String(value))) throw new AgentMuxError('Browser site permission is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return value as import('./browser-site-permissions.js').BrowserSitePermission
  }
  const origin = (value: unknown): string => {
    const result = text(value, 8192)
    try { const url = new URL(result); if (['https:', 'http:'].includes(url.protocol) && url.origin === result) return result } catch { /* Invalid protocol fact. */ }
    throw new AgentMuxError('Browser site permission origin is invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return { requests: state.requests.map(value => {
    const row = record(value)
    if (!Array.isArray(row.permissions) || row.permissions.length === 0 || new Set(row.permissions).size !== row.permissions.length) throw new AgentMuxError('Browser requested permissions are invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { requestId: text(row.requestId, 200), browserId: text(row.browserId, 200), navigationId: text(row.navigationId, 200),
      profileId: row.profileId === null ? null : text(row.profileId, 200), origin: origin(row.origin), embeddingOrigin: origin(row.embeddingOrigin), permissions: row.permissions.map(permission) }
  }), decisions: state.decisions.map(value => {
    const row = record(value)
    if (typeof row.allow !== 'boolean' || !['document', 'profile'].includes(String(row.scope))) throw new AgentMuxError('Browser site permission decision is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { origin: origin(row.origin), embeddingOrigin: origin(row.embeddingOrigin), permission: permission(row.permission), allow: row.allow,
      scope: row.scope as 'document' | 'profile' }
  }), ...(state.warning === undefined ? {} : { warning: text(state.warning, 2000) }) }
}

const reasons = new Set(['visible', 'presentation', 'operation', 'loading', 'profile-switch', 'selection', 'media', 'download', 'upload', 'debugger', 'document-used', 'document-unconfirmed', 'source-changed', 'close-unconfirmed', 'beforeunload', 'owner-unavailable'])
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Browser resource fact is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value as Record<string, unknown>
}
function retentionReasons(value: unknown): AgentMuxBrowserRetention['reasons'] {
  if (!Array.isArray(value) || value.length > reasons.size || new Set(value).size !== value.length || value.some(reason => typeof reason !== 'string' || !reasons.has(reason))) throw new AgentMuxError('Browser retention reasons are invalid.', 'CONTROL_PROTOCOL_ERROR')
  return [...value] as AgentMuxBrowserRetention['reasons']
}
export function parseBrowserReleaseReceipt(value: unknown): AgentMuxBrowserReleaseReceipt {
  const row = record(value), status = row.status
  if (status !== 'released' && status !== 'retained' && status !== 'unknown') throw new AgentMuxError('Browser release result is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const reasons = retentionReasons(row.reasons)
  if (status === 'released' && reasons.length) throw new AgentMuxError('Released Browser cannot have retention reasons.', 'CONTROL_PROTOCOL_ERROR')
  return { browserId: text(row.browserId, 200), navigationId: text(row.navigationId, 200), status, reasons }
}
function parseBrowserResource(value: unknown): AgentMuxBrowserResource {
  const row = record(value)
  if (!['live', 'released', 'cold', 'unknown'].includes(String(row.state)) || !Array.isArray(row.locations)) throw new AgentMuxError('Browser resource state or positions are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const locations = row.locations.map(value => {
    const location = record(value)
    return { workspaceId: location.workspaceId === null ? null : text(location.workspaceId, 200), tabId: text(location.tabId, 200), regionId: text(location.regionId, 200) }
  })
  if (new Set(locations.map(location => location.regionId)).size !== locations.length) throw new AgentMuxError('Browser positions are duplicated.', 'CONTROL_PROTOCOL_ERROR')
  if (row.processes !== null && !Array.isArray(row.processes)) throw new AgentMuxError('Browser process ownership is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const processes = row.processes === null ? null : (row.processes as unknown[]).map(value => {
    const process = record(value)
    if (!Number.isSafeInteger(process.pid) || (process.pid as number) <= 0 || typeof process.creationTime !== 'number' || !Number.isFinite(process.creationTime) || process.creationTime <= 0) throw new AgentMuxError('Browser process identity is invalid.', 'CONTROL_PROTOCOL_ERROR')
    return { pid: process.pid as number, creationTime: process.creationTime }
  })
  if (processes && new Set(processes.map(process => process.pid)).size !== processes.length) throw new AgentMuxError('Browser process ownership is duplicated.', 'CONTROL_PROTOCOL_ERROR')
  let retention: AgentMuxBrowserRetention | undefined
  if (row.retention !== undefined) {
    const held = record(row.retention)
    if (held.status !== 'eligible' && held.status !== 'retained' && held.status !== 'unknown') throw new AgentMuxError('Browser retention is invalid.', 'CONTROL_PROTOCOL_ERROR')
    retention = { status: held.status, reasons: retentionReasons(held.reasons) }
    if (retention.status === 'eligible' && retention.reasons.length) throw new AgentMuxError('Eligible Browser has retention reasons.', 'CONTROL_PROTOCOL_ERROR')
  }
  if ((row.state === 'cold' || row.state === 'released') && processes?.length) throw new AgentMuxError('Unloaded Browser has native processes.', 'CONTROL_PROTOCOL_ERROR')
  return { state: row.state as AgentMuxBrowserResource['state'], locations, processes, ...(retention ? { retention } : {}) }
}

/** These original IDs remain queryable; this mismatch grants no cleanup authority. */
export function parseBrowserOpenMismatch(value: unknown): import('./browser-targets.js').AgentMuxBrowserOpenMismatch {
  const row = rpcRecord(value, ['kind', 'operationId', 'browserId', 'profileId', 'mode', 'requestedProfileId',
    'requestedBrowserId', 'returnedBrowserId', 'creation'], 'CONTROL_PROTOCOL_ERROR')
  if (row.kind === 'browser-open-identity-mismatch') {
    if (Object.keys(row).length !== 5 || row.creation !== 'unconfirmed' || row.requestedBrowserId === row.returnedBrowserId) {
      throw new AgentMuxError('Browser open mismatch facts are invalid.', 'CONTROL_PROTOCOL_ERROR')
    }
    return {
      kind: 'browser-open-identity-mismatch',
      operationId: text(row.operationId, 16384),
      requestedBrowserId: text(row.requestedBrowserId, 16384),
      returnedBrowserId: text(row.returnedBrowserId, 16384),
      creation: 'unconfirmed'
    }
  }
  if (Object.keys(row).length !== 6 || row.kind !== 'browser-open-profile-mismatch' ||
      row.mode !== 'normal' && row.mode !== 'private' ||
      row.mode === 'private' && row.profileId !== null ||
      row.mode === 'normal' && row.profileId === row.requestedProfileId) {
    throw new AgentMuxError('Browser open mismatch facts are invalid.', 'CONTROL_PROTOCOL_ERROR')
  }
  return {
    kind: 'browser-open-profile-mismatch',
    operationId: text(row.operationId, 16384),
    browserId: text(row.browserId, 16384),
    profileId: row.profileId === null ? null : text(row.profileId, 16384),
    mode: row.mode,
    requestedProfileId: text(row.requestedProfileId, 16384)
  }
}
