import type { AgentMuxBrowserTarget, AgentMuxBrowserResource, AgentMuxBrowserReleaseReceipt, AgentMuxBrowserRetention } from './browser-targets.js'
import { BROWSER_PAGE_CAPABILITY_NAMES } from './browser-page-capability.js'
import { AgentMuxError } from './errors.js'

const sources = new Set(['embedded', 'external'])
const statuses = new Set(['ready', 'disconnected', 'revoked', 'closed', 'unavailable'])
const capabilities = new Set(BROWSER_PAGE_CAPABILITY_NAMES)
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!empty && !value.trim())) throw new AgentMuxError('Browser target fact is invalid.', 'CONTROL_PROTOCOL_ERROR')
  return value
}
/** Discovery facts carry no pairing secret, profile or credential store. */
export function parseBrowserTargetsResult(value: unknown): { targets: AgentMuxBrowserTarget[]; warning?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentMuxError('Browser target discovery is invalid.', 'CONTROL_PROTOCOL_ERROR')
  const input = value as Record<string, unknown>
  if (!Array.isArray(input.targets) || input.targets.length > 256) throw new AgentMuxError('Browser target discovery exceeds its bound.', 'CONTROL_PROTOCOL_ERROR')
  const ids = new Set<string>()
  const targets = input.targets.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AgentMuxError('Browser target is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const row = raw as Record<string, unknown>
    const id = text(row.id, 200)
    if (ids.has(id) || !sources.has(String(row.source)) || !statuses.has(String(row.status))) throw new AgentMuxError('Browser target identity or status is invalid.', 'CONTROL_PROTOCOL_ERROR')
    ids.add(id)
    if (!Array.isArray(row.capabilities) || row.capabilities.length > capabilities.size || row.capabilities.some(item => typeof item !== 'string' || !capabilities.has(item))) throw new AgentMuxError('Browser target capabilities are invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (row.cdpMethods !== undefined && (!Array.isArray(row.cdpMethods) || row.cdpMethods.length > 128 || row.cdpMethods.some(item => typeof item !== 'string' || !/^[A-Z][A-Za-z]+\.[A-Za-z]+$/.test(item)))) throw new AgentMuxError('Browser target CDP subset is invalid.', 'CONTROL_PROTOCOL_ERROR')
    const workspaceId = row.source === 'embedded' && row.workspaceId === null ? null : text(row.workspaceId, 200)
    if (row.mode !== undefined && row.mode !== 'normal' && row.mode !== 'private') throw new AgentMuxError('Browser target mode is invalid.', 'CONTROL_PROTOCOL_ERROR')
    if (row.navigationId === undefined && (row.source !== 'embedded' || row.status !== 'unavailable' || row.capabilities.length !== 0 || row.cdpMethods !== undefined)) throw new AgentMuxError('A live Browser target requires its actual navigation identity.', 'CONTROL_PROTOCOL_ERROR')
    if (row.resource !== undefined && row.source !== 'embedded') throw new AgentMuxError('External Browser resource management is unavailable.', 'CONTROL_PROTOCOL_ERROR')
    return { id, workspaceId, source: row.source as AgentMuxBrowserTarget['source'],
      ...(row.mode === undefined ? {} : { mode: row.mode as 'normal' | 'private' }),
      status: row.status as AgentMuxBrowserTarget['status'], url: text(row.url, 8192, true), title: text(row.title, 512, true),
      ...(row.navigationId === undefined ? {} : { navigationId: text(row.navigationId, 200) }), capabilities: [...row.capabilities] as string[],
      ...(row.cdpMethods === undefined ? {} : { cdpMethods: [...row.cdpMethods as string[]] }),
      ...(row.resource === undefined ? {} : { resource: parseBrowserResource(row.resource) }),
      ...(row.warning === undefined ? {} : { warning: text(row.warning, 2000) }) }
  })
  return { targets, ...(input.warning === undefined ? {} : { warning: text(input.warning, 2000) }) }
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
  if (!['live', 'released', 'cold', 'unknown'].includes(String(row.state)) || !Array.isArray(row.locations) || row.locations.length > 256) throw new AgentMuxError('Browser resource state or positions are invalid.', 'CONTROL_PROTOCOL_ERROR')
  const locations = row.locations.map(value => {
    const location = record(value)
    return { workspaceId: location.workspaceId === null ? null : text(location.workspaceId, 200), tabId: text(location.tabId, 200), regionId: text(location.regionId, 200) }
  })
  if (new Set(locations.map(location => location.regionId)).size !== locations.length) throw new AgentMuxError('Browser positions are duplicated.', 'CONTROL_PROTOCOL_ERROR')
  if (row.processes !== null && (!Array.isArray(row.processes) || row.processes.length > 256)) throw new AgentMuxError('Browser process ownership is invalid.', 'CONTROL_PROTOCOL_ERROR')
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
