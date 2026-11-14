import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { BrowserInputHistoryAppearance, BrowserInputHistoryScope, BrowserInputHistorySnapshot } from '../shared/browser-input-history.js'
import type { BrowserPageMemoryReadResult } from '../shared/browser-page-memory.js'
import type { BrowserRecoveryPreviewScope } from '../shared/browser-recovery-preview.js'
import { resolveBrowserInput } from '../shared/browser-address.js'
import { browserColdDescriptor } from './browser-cold-descriptor.js'
import type { BrowserInputHistoryStore } from './browser-input-history.js'

type Sources = {
  history: Pick<BrowserInputHistoryStore, 'list' | 'fillAppearance'>
  graph(): Promise<AgentMuxSpatialGraph | null>
  knownScopes(): ReadonlyMap<string, BrowserRecoveryPreviewScope | null>
  readPage(scope: BrowserRecoveryPreviewScope): Promise<BrowserPageMemoryReadResult>
}

/** Enrich an existing history read from original saved facts; never acquire a page. */
export async function listBrowserInputHistoryWithAppearance(scope: BrowserInputHistoryScope, sources: Sources): Promise<BrowserInputHistorySnapshot> {
  if (scope.profileId === null) return { scope, entries: [] }
  // A damaged human-history file retains its original explicit error path.
  const original = await sources.history.list(scope), wanted = new Set<string>()
  for (const entry of original.entries) {
    if (entry.appearance?.title && entry.appearance.faviconDataUrl) continue
    try {
      const resolved = resolveBrowserInput(entry.text)
      if (resolved.kind === 'address') wanted.add(entry.appearance?.url ?? resolved.url)
    } catch { /* An unknown address keeps its exact original text; optional details cannot rewrite it. */ }
  }
  if (!wanted.size) return original

  let failed = false, graph: AgentMuxSpatialGraph | null = null
  try { graph = await sources.graph() } catch { failed = true }
  // Read live/released authority after the await: an owner created or switched meanwhile wins.
  let known: ReturnType<Sources['knownScopes']> | null = null
  try { known = sources.knownScopes() } catch { failed = true }
  const scopes = new Map<string, BrowserRecoveryPreviewScope>()
  const sameScope = (candidate: BrowserRecoveryPreviewScope) => candidate.mode === 'normal' &&
    candidate.workspaceId === scope.workspaceId && candidate.profileId === scope.profileId
  for (const [id, candidate] of known ?? []) if (candidate && sameScope(candidate)) scopes.set(id, candidate)
  const coldIds = new Set(graph?.regions.filter(region => region.kind === 'browser' && region.browserId).map(region => region.browserId!) ?? [])
  for (const id of coldIds) {
    if (!known || known.has(id)) continue
    try {
      const saved = browserColdDescriptor(graph, id)
      if (saved.mode === 'normal' && !saved.capsuleId && saved.profileId) {
        const candidate: BrowserRecoveryPreviewScope = { browserId: id, workspaceId: saved.workspaceId, mode: 'normal', profileId: saved.profileId }
        if (sameScope(candidate)) scopes.set(id, candidate)
      }
    } catch { /* The original saved identity is unknown; do not borrow a default or a display binding. */ }
  }

  const patches = new Map<string, BrowserInputHistoryAppearance>()
  await Promise.all([...scopes.values()].map(async candidate => {
    try {
      const result = await sources.readPage(candidate)
      if (result.warning) failed = true
      if (result.status === 'unavailable') { failed = true; return }
      if (result.status !== 'available') return
      const memory = result.memory
      for (const entry of memory.history?.entries ?? []) if (wanted.has(entry.url) && entry.title) {
        const patch = patches.get(entry.url) ?? { url: entry.url, title: '' }
        if (!patch.title) patches.set(entry.url, { ...patch, title: entry.title })
      }
      // A historical navigation entry has its own title, never the current document's favicon.
      if (wanted.has(memory.url) && memory.favicon) {
        const patch = patches.get(memory.url) ?? { url: memory.url, title: '' }
        if (!patch.faviconDataUrl) patches.set(memory.url, { ...patch, faviconDataUrl: memory.favicon.dataUrl })
      }
    } catch { failed = true }
  }))

  let current: BrowserInputHistorySnapshot
  try { current = await sources.history.fillAppearance(scope, [...patches.values()]) }
  catch {
    failed = true
    // Read the latest original rows, including a concurrent deletion. Never return a stale saved array.
    current = await sources.history.list(scope)
  }
  return failed ? { ...current, warning: 'Some saved page details could not be read or saved. Your original inputs and browsing remain available; retry history here.' } : current
}
