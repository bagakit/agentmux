import type { AgentMuxBrowserTarget } from '@agentmux/core'
import { parseBrowserSource } from '@agentmux/core'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { CapsuleInspection } from '@agentmux/core/capsule'
import { cloneBrowserViewport, isBrowserViewport, type BrowserViewport } from '../shared/browser-viewport.js'

/** Host resource metadata stays in Core; only Main interprets it as a page to acquire. */
export type BrowserColdDescriptor = {
  id: string
  workspaceId: string
  url: string
  title: string
  mode: 'normal' | 'private'
  profileId?: string
  /** Container provenance survives navigation; it does not grant the current document a bridge. */
  capsuleId?: string
  capsuleOrigin?: string
  /** Original presentation requests associated by Main; membership is not completion evidence. */
  capsuleOpenOperationIds?: string[]
  /** Resolved by the original Host when acquiring this exact cold owner; never persisted here. */
  capsule?: CapsuleInspection
  /** Older records did not save a viewport. Absence is not a confirmed responsive setting. */
  viewport?: BrowserViewport
  agent?: import('@agentmux/core').AgentMuxBrowserControl['agent']
  source?: import('@agentmux/core').AgentMuxBrowserSource
  warning?: string
}

export function browserColdDescriptor(graph: AgentMuxSpatialGraph | null, id: string): BrowserColdDescriptor {
  if (!graph) throw new Error('Saved Browser ownership is unconfirmed. The original Region is kept; retry its connection.')
  const regions = graph.regions.filter(region => region.kind === 'browser' && region.browserId === id)
  if (regions.length !== 1) throw new Error('The exact saved Browser Region is unavailable or ambiguous. Keep the original page and retry its connection.')
  const region = regions[0]!
  const tab = graph.tabs.find(tab => tab.tabId === region.tabId && tab.regionIds.includes(region.regionId))
  const data = graph.resources['region:' + region.regionId]
  if (!tab || !data || typeof data !== 'object' || Array.isArray(data) || data.browserId !== id ||
    typeof data.workspaceId !== 'string' || !data.workspaceId || typeof data.url !== 'string' || !data.url ||
    (data.mode !== undefined && data.mode !== 'normal' && data.mode !== 'private') ||
    (data.profileId !== undefined && data.profileId !== null && typeof data.profileId !== 'string') ||
    (data.capsuleId !== undefined && (typeof data.capsuleId !== 'string' || !data.capsuleId.trim())) ||
    (data.capsuleId !== undefined && (typeof data.capsuleOrigin !== 'string' || !isCapsuleOrigin(data.capsuleOrigin))) ||
    (data.capsuleOrigin !== undefined && data.capsuleId === undefined) ||
    (data.capsuleOpenOperationIds !== undefined && (data.capsuleId === undefined || !Array.isArray(data.capsuleOpenOperationIds) ||
      data.capsuleOpenOperationIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(data.capsuleOpenOperationIds).size !== data.capsuleOpenOperationIds.length)) ||
    (data.capsuleId !== undefined && (data.mode === 'private' || data.profileId != null)) ||
    (data.viewport !== undefined && !isBrowserViewport(data.viewport))) {
    throw new Error('The original Browser resource descriptor is incomplete. Its Region is kept; restore its saved resource before retrying.')
  }
  // The saved association is metadata, never restored input permission or a live Run.
  let agent: BrowserColdDescriptor['agent']
  let warning: string | undefined = data.agent === undefined
    ? 'The saved Browser Agent association is unconfirmed. The page remains usable; ask the original Agent to read this exact Browser through its Browser tools before returning control.' : undefined
  if (data.agent === null) agent = null
  else if (data.agent !== undefined) {
    if (!data.agent || typeof data.agent !== 'object' || Array.isArray(data.agent) ||
      Object.keys(data.agent).some(key => !['hostId', 'agentSessionId'].includes(key)) ||
      typeof data.agent.hostId !== 'string' || !data.agent.hostId.trim() ||
      typeof data.agent.agentSessionId !== 'string' || !data.agent.agentSessionId.trim()) {
      warning = 'The saved Browser Agent association is unconfirmed. The page remains usable; restore its original association before returning control.'
    } else agent = { hostId: data.agent.hostId, agentSessionId: data.agent.agentSessionId }
  }
  const privateMode = data.mode === 'private'
  let source: BrowserColdDescriptor['source']
  if (data.source !== undefined) {
    try { source = parseBrowserSource(data.source) }
    catch { warning = [warning, 'The saved Browser source is unconfirmed. The original page remains usable; inspect its source before returning.'].filter(Boolean).join(' ') }
  }
  return { id, workspaceId: data.workspaceId, url: privateMode ? 'about:blank' : data.url,
    title: privateMode ? 'Private page' : typeof data.title === 'string' ? data.title : '', mode: privateMode ? 'private' : 'normal',
    ...(!privateMode && data.profileId ? { profileId: data.profileId as string } : {}),
    ...(data.capsuleId ? { capsuleId: data.capsuleId as string, capsuleOrigin: data.capsuleOrigin as string } : {}),
    ...(Array.isArray(data.capsuleOpenOperationIds) ? { capsuleOpenOperationIds: [...data.capsuleOpenOperationIds] as string[] } : {}),
    ...(data.viewport !== undefined ? { viewport: cloneBrowserViewport(data.viewport as BrowserViewport) } : {}),
    ...(source ? { source } : {}), ...(agent === undefined ? {} : { agent }), ...(warning ? { warning } : {}) }
}

function isCapsuleOrigin(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === value }
  catch { return false }
}

/** Discovery never acquires a native page and never replaces an existing Main fact. */
export function coldBrowserTargets(graph: AgentMuxSpatialGraph | null, live: readonly AgentMuxBrowserTarget[]): AgentMuxBrowserTarget[] {
  if (!graph) return []
  const known = new Set(live.map(target => target.id))
  return graph.regions.flatMap<AgentMuxBrowserTarget>(region => {
    const id = region.browserId
    if (region.kind !== 'browser' || !id || known.has(id)) return []
    known.add(id)
    try {
      const saved = browserColdDescriptor(graph, id)
      return [{ id, workspaceId: saved.workspaceId, source: 'embedded' as const, mode: saved.mode,
        ...(saved.source ? { openedFrom: saved.source } : {}),
        status: 'unavailable' as const, url: saved.url, title: saved.title, capabilities: [],
        control: { owner: 'unknown', activeOperationId: null, revision: 0, inputIsolation: 'unconfirmed',
          ...(saved.agent === undefined ? {} : { agent: saved.agent }) },
        warning: [saved.warning, 'The saved page has no confirmed native owner. Display it or run a Browser operation to restore this same identity.'].filter(Boolean).join(' ') }]
    } catch (error) {
      return [{ id, workspaceId: null, source: 'embedded' as const, status: 'unavailable' as const,
        url: '', title: '', capabilities: [], warning: error instanceof Error ? error.message : String(error) }]
    }
  })
}
