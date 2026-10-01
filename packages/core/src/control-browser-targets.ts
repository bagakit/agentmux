import type { AgentMuxBrowserTarget } from './browser-targets.js'
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
    return { id, workspaceId, source: row.source as AgentMuxBrowserTarget['source'],
      status: row.status as AgentMuxBrowserTarget['status'], url: text(row.url, 8192, true), title: text(row.title, 512, true),
      navigationId: text(row.navigationId, 200), capabilities: [...row.capabilities] as string[],
      ...(row.cdpMethods === undefined ? {} : { cdpMethods: [...row.cdpMethods as string[]] }),
      ...(row.warning === undefined ? {} : { warning: text(row.warning, 2000) }) }
  })
  return { targets, ...(input.warning === undefined ? {} : { warning: text(input.warning, 2000) }) }
}
