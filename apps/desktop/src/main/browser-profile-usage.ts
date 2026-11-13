import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { BrowserProfileDeleteApproval } from '../shared/contracts.js'

export type SavedBrowserUse = { browserId: string; workspaceId?: string; title: string; url: string }

/** One Browser that holds a Profile: open has a native owner now, saved restores into it later. */
export type BrowserProfileUse = { browserId: string; workspaceId?: string; title: string; url: string; state: 'open' | 'saved' }
/** complete is false when saved Tabs could not be read; the list then names only open Browsers. */
export type BrowserProfileUsage = { browsers: BrowserProfileUse[]; complete: boolean }

/**
 * Saved Browser Regions that still name a Profile. A Region that has not been
 * shown since restart has no native owner yet, so only the spatial graph knows
 * it needs this Profile to restore. Private and Capsule pages never use one, and
 * a Region outside any Tab cannot be shown, so it does not hold the Profile.
 */
export function savedBrowsersUsingProfile(graph: AgentMuxSpatialGraph, profileId: string): SavedBrowserUse[] {
  return graph.regions.flatMap(region => {
    if (region.kind !== 'browser' || !region.browserId) return []
    if (!graph.tabs.some(tab => tab.tabId === region.tabId && tab.regionIds.includes(region.regionId))) return []
    const data = graph.resources['region:' + region.regionId]
    if (!data || typeof data !== 'object' || Array.isArray(data)) return []
    if (data.mode === 'private' || data.capsuleId !== undefined || data.profileId !== profileId) return []
    return [{ browserId: region.browserId, ...(typeof data.workspaceId === 'string' ? { workspaceId: data.workspaceId } : {}),
      title: typeof data.title === 'string' ? data.title : '', url: typeof data.url === 'string' ? data.url : '' }]
  })
}

export type BrowserProfileUsagePorts = {
  /** Native owners holding the Profile now, including pages switching into it or still closing. */
  open(profileId: string): { browserId: string; workspaceId: string | null; title: string; url: string }[]
  /** null means no saved Tabs exist yet (known empty); a rejection means the saved Tabs are unknown. */
  readSaved(): Promise<{ graph: AgentMuxSpatialGraph } | null>
  deleteProfile(profileId: string, approval: BrowserProfileDeleteApproval): Promise<void>
  clearPreviews(profileId: string): Promise<{ status: 'removed' | 'unavailable'; warning?: string }>
}

function profileError(message: string, code: string, extra: Record<string, unknown> = {}, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, ...extra })
}

function openUses(ports: BrowserProfileUsagePorts, profileId: string): BrowserProfileUse[] {
  return ports.open(profileId).map(use => ({ browserId: use.browserId, ...(use.workspaceId ? { workspaceId: use.workspaceId } : {}),
    title: use.title, url: use.url, state: 'open' as const }))
}

function savedUses(graph: AgentMuxSpatialGraph, profileId: string, open: ReadonlySet<string>): BrowserProfileUse[] {
  const uses = new Map<string, BrowserProfileUse>()
  // One Browser shown in several Regions is one user of the Profile.
  for (const use of savedBrowsersUsingProfile(graph, profileId)) if (!open.has(use.browserId) && !uses.has(use.browserId)) uses.set(use.browserId, { ...use, state: 'saved' })
  return [...uses.values()]
}

/** The one owner of "who uses this Profile" and of deleting it; GUI and public control both call these. */
export function createBrowserProfileUsage(ports: BrowserProfileUsagePorts) {
  return {
    async usage(profileId: string): Promise<BrowserProfileUsage> {
      let saved: { graph: AgentMuxSpatialGraph } | null, complete = true
      try { saved = await ports.readSaved() } catch { saved = null; complete = false }
      // Read open owners after the saved read so a Browser that starts using the Profile meanwhile is seen.
      const open = openUses(ports, profileId)
      const ids = new Set(open.map(use => use.browserId))
      return { browsers: [...open, ...(saved ? savedUses(saved.graph, profileId, ids) : [])], complete }
    },

    async deleteProfile(profileId: string, approval: BrowserProfileDeleteApproval): Promise<void> {
      let saved: { graph: AgentMuxSpatialGraph } | null
      try { saved = await ports.readSaved() }
      catch (cause) {
        throw profileError('Saved Tabs could not be read, so it is unknown whether a Browser still needs this Profile. Nothing was deleted; try again.',
          'BROWSER_PROFILE_USAGE_UNKNOWN', {}, cause)
      }
      // Checked after the read and in the same turn as the manager's synchronous removal, so a
      // Browser that starts using this Profile while saved Tabs are read is still seen.
      const open = openUses(ports, profileId)
      const ids = new Set(open.map(use => use.browserId))
      const savedList = saved ? savedUses(saved.graph, profileId, ids) : []
      const browsers = [...open, ...savedList]
      if (open.length) {
        throw profileError('Browser Profile is still used by an open Browser', 'BROWSER_PROFILE_IN_USE', { details: { browsers } })
      }
      if (savedList.length) {
        const name = savedList[0]!.title || savedList[0]!.url
        throw profileError(`Browser Profile is still used by the saved Browser "${name}"${savedList.length > 1 ? ` and ${savedList.length - 1} more` : ''}. Open it and switch it to another Profile, or close it, then delete again.`,
          'BROWSER_PROFILE_IN_USE', { details: { browsers } })
      }
      const clearPreviews = async () => {
        const cleared = await ports.clearPreviews(profileId)
        if (cleared.status === 'unavailable') console.warn('Browser Profile was deleted; its historical preview cleanup is unconfirmed:', cleared.warning)
      }
      try { await ports.deleteProfile(profileId, approval) }
      catch (error) {
        // Deleted, with its site data still to clear: the deleted Profile's previews go now as well.
        if ((error as { code?: unknown } | null)?.code === 'BROWSER_PROFILE_DATA_CLEAR_PENDING') await clearPreviews()
        throw error
      }
      await clearPreviews()
    }
  }
}
export type BrowserProfileUsageOwner = ReturnType<typeof createBrowserProfileUsage>
