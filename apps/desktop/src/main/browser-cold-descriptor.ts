import type { AgentMuxBrowserTarget } from '@agentmux/core'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { cloneBrowserViewport, isBrowserViewport, type BrowserViewport } from '../shared/browser-viewport.js'

/** Host resource metadata stays in Core; only Main interprets it as a page to acquire. */
export type BrowserColdDescriptor = {
  id: string
  workspaceId: string
  url: string
  title: string
  mode: 'normal' | 'private'
  profileId?: string
  /** Older records did not save a viewport. Absence is not a confirmed responsive setting. */
  viewport?: BrowserViewport
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
    (data.viewport !== undefined && !isBrowserViewport(data.viewport))) {
    throw new Error('The original Browser resource descriptor is incomplete. Its Region is kept; restore its saved resource before retrying.')
  }
  const privateMode = data.mode === 'private'
  return { id, workspaceId: data.workspaceId, url: privateMode ? 'about:blank' : data.url,
    title: privateMode ? 'Private page' : typeof data.title === 'string' ? data.title : '', mode: privateMode ? 'private' : 'normal',
    ...(!privateMode && data.profileId ? { profileId: data.profileId as string } : {}),
    ...(data.viewport !== undefined ? { viewport: cloneBrowserViewport(data.viewport as BrowserViewport) } : {}) }
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
        status: 'unavailable' as const, url: saved.url, title: saved.title, capabilities: [],
        warning: 'The saved page has no confirmed native owner. Display it or run a Browser operation to restore this same identity.' }]
    } catch (error) {
      return [{ id, workspaceId: null, source: 'embedded' as const, status: 'unavailable' as const,
        url: '', title: '', capabilities: [], warning: error instanceof Error ? error.message : String(error) }]
    }
  })
}
