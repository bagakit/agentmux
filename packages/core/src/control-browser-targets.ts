import type { AgentMuxBrowserControl, AgentMuxBrowserSource, AgentMuxBrowserTarget, AgentMuxBrowserTargetsResult, AgentMuxBrowserResource, AgentMuxBrowserReleaseReceipt, AgentMuxBrowserRetention } from './browser-targets.js'
import { BROWSER_PAGE_CAPABILITY_NAMES } from './browser-page-capability.js'
import { AgentMuxError } from './errors.js'
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

const sources = new Set(['embedded', 'external'])
const statuses = new Set(['ready', 'disconnected', 'revoked', 'closed', 'unavailable'])
const capabilities = new Set(BROWSER_PAGE_CAPABILITY_NAMES)
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new AgentMuxError('Browser target fact is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
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

/** A single exact owner result is not a complete discovery catalog. */
export function parseBrowserTarget(raw: unknown): AgentMuxBrowserTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentMuxError('Browser target is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const row = raw as Record<string, unknown>
  const id = text(row.id, 200)
  if (!sources.has(String(row.source)) || !statuses.has(String(row.status))) throw new AgentMuxError('Browser target identity or status is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (!Array.isArray(row.capabilities) || row.capabilities.length > capabilities.size || row.capabilities.some(item => typeof item !== 'string' || !capabilities.has(item))) throw new AgentMuxError('Browser target capabilities are invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (row.cdpMethods !== undefined && (!Array.isArray(row.cdpMethods) || row.cdpMethods.length > 128 || row.cdpMethods.some(item => typeof item !== 'string' || !/^[A-Z][A-Za-z]+\.[A-Za-z]+$/.test(item)))) throw new AgentMuxError('Browser target CDP subset is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const workspaceId = row.source === 'embedded' && row.workspaceId === null ? null : text(row.workspaceId, 200)
  if (row.mode !== undefined && row.mode !== 'normal' && row.mode !== 'private') throw new AgentMuxError('Browser target mode is invalid.', 'CONTROL_PROTOCOL_ERROR')
  if (row.navigationId === undefined && (row.source !== 'embedded' || row.status !== 'unavailable' || row.capabilities.length !== 0 || row.cdpMethods !== undefined)) throw new AgentMuxError('A live Browser target requires its actual navigation identity.', 'CONTROL_PROTOCOL_ERROR')
  if (row.resource !== undefined && row.source !== 'embedded') throw new AgentMuxError('External Browser resource management is unavailable.', 'CONTROL_PROTOCOL_ERROR')
  const certificateRequest = row.certificateRequest === undefined ? undefined : row.certificateRequest === null ? null : parseBrowserCertificateRequest(row.certificateRequest)
  if (certificateRequest && (row.source !== 'embedded' || certificateRequest.navigationId !== row.navigationId)) throw new AgentMuxError('Browser certificate request belongs to another document.', 'CONTROL_PROTOCOL_ERROR')
  return { id, workspaceId, source: row.source as AgentMuxBrowserTarget['source'],
    ...(row.mode === undefined ? {} : { mode: row.mode as 'normal' | 'private' }),
    status: row.status as AgentMuxBrowserTarget['status'], url: text(row.url, 8192, true), title: text(row.title, 512, true),
    ...(row.navigationId === undefined ? {} : { navigationId: text(row.navigationId, 200) }), capabilities: [...row.capabilities] as string[],
    ...(row.openedFrom === undefined ? {} : { openedFrom: parseBrowserSource(row.openedFrom) }),
    ...(row.cdpMethods === undefined ? {} : { cdpMethods: [...row.cdpMethods as string[]] }),
    ...(row.control === undefined ? {} : { control: parseBrowserControl(row.control) }),
    ...(certificateRequest === undefined ? {} : { certificateRequest }),
    ...(row.resource === undefined ? {} : { resource: parseBrowserResource(row.resource) }),
    ...(row.warning === undefined ? {} : { warning: text(row.warning, 2000) }) }
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
