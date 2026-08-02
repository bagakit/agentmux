import { insertTabAfter, type WorkspaceLayout } from './workbench-layout'
import {
  createWorkbenchTab,
  removeWorkbenchRegion,
  type WorkbenchTab
} from './workbench-tabs'

// Promoting a Region turns one split inside a Tab into its own Tab (#487, 「单独变成一个 tab」). It is a
// pure relocation of one projection: the Region's surface leaves the source Tab's split tree and becomes
// the sole Region of a brand-new Tab. Nothing about the surface itself changes — same workspace, same
// content, and deliberately the SAME regionId. The regionId is kept (not minted anew) because a Region's
// content is keyed by it: a browser's `browserId === regionId`, the editor diff cache, and the live view
// registry all look the surface up by regionId. Detaching the leaf from the source frees that id, so
// carrying it onto the new Tab keeps it globally unique while every consumer keeps finding the same
// content. (Contrast move-session-view.ts, which mints a fresh regionId because it also changes workspace
// — a Session's identity is its sessionId, so its projection can be reprojected; here we relocate the
// projection whole and must not orphan its content.)
//
// Two invariants tracker #487 recorded as prose-only, pinned by promote-region-to-tab.test.ts and the
// promote case of workbench-region-invariant.test.ts:
//   1. Tree ↔ regions correspondence on BOTH Tabs. The source loses exactly the promoted leaf and its
//      regions entry together (removeWorkbenchRegion does both); the destination is born with exactly one
//      leaf and one regions entry (createWorkbenchTab). Neither side can end with a tree leaf lacking a
//      regions entry or vice versa.
//   2. No Tab ever has zero Regions. Promoting the ONLY Region of a Tab is a no-op — there is nothing to
//      promote, it already IS its own Tab. removeWorkbenchRegion returns null in exactly that case, and we
//      surface it as { kind: 'unchanged' }. Promoting one of N>1 leaves the source with N-1 and a valid
//      activeRegionId (removeWorkbenchRegion → closeWorkbenchRegion reassigns it to the sibling).

export type PromoteRegionToTabInput = {
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
  // The workspace that owns the source Tab. Guards a stale caller from promoting a Region across projects.
  workspaceId: string
  tabId: string
  // The Region to promote, keyed by its globally-unique id.
  regionId: string
  // The id for the Tab that will be created. Injected so the reducer stays pure. A new Tab is ALWAYS
  // created (unlike move-session-view, which may reuse an existing target View), so there is always
  // exactly one id to mint. The new Tab reuses the promoted surface's regionId, so no region id is minted.
  mint: { tabId: string }
}

export type PromoteRegionToTabResult =
  | { kind: 'unchanged' }
  | {
      kind: 'promoted'
      tabs: Record<string, WorkbenchTab>
      layouts: Record<string, WorkspaceLayout>
      // Where the promoted Region now lives, so the caller can navigate with the existing focus actions.
      target: { workspaceId: string; tabId: string; regionId: string }
    }

export function promoteRegionToTab(input: PromoteRegionToTabInput): PromoteRegionToTabResult {
  const sourceTab = input.tabs[input.tabId]
  // Ownership: the named Tab must exist and belong to the named workspace; the Region must be one of its.
  if (!sourceTab || sourceTab.workspaceId !== input.workspaceId) return { kind: 'unchanged' }
  const surface = sourceTab.regions[input.regionId]
  if (!surface) return { kind: 'unchanged' }
  // A file surface is exempt — the one Region kind that cannot be relocated to a fresh Tab. A file's
  // Tab is addressed by a canonical id derived from its path (fileTabId), and file-workbench-state.ts's
  // reduceDocumentAttached / reduceDocumentLoadFailed / reduceFileOpened all look the surface up by that
  // canonical id. Moving a file Region into a `view:…` Tab puts a `kind:'file'` surface into a Tab whose
  // id ≠ fileTabId(...) — exactly the change that file's invariant comment names as silently degrading
  // (re-opening the file would spawn a duplicate; a re-attach/load-failure would miss the surface). This
  // is the same reason move-session-view relocates only agent/terminal Regions. Every other kind is safe:
  // a browser's browserId equals its (here preserved) regionId, and agent/terminal/launcher carry no
  // Tab-id coupling.
  if (surface.kind === 'file') return { kind: 'unchanged' }
  // The new Tab lands inside the source Tab's own group, so that group must exist in the layout.
  const layout = input.layouts[input.workspaceId]
  if (!layout) return { kind: 'unchanged' }

  // Detach the Region from the source Tab. removeWorkbenchRegion returns null exactly when this is the
  // Tab's only Region (invariant #2's no-op case): there is nothing to promote, so leave everything as-is.
  const detachedTab = removeWorkbenchRegion(sourceTab, input.regionId)
  if (!detachedTab) return { kind: 'unchanged' }

  // The promoted surface becomes the sole Region of a fresh Tab, keeping its own regionId and workspace.
  // The new Tab inherits the source Tab's Topic binding: same workspace, same Topic — otherwise a Scratch
  // Topic's projection would drop the new Tab out of its Topic (see WorkbenchTab.topicId).
  const newTab: WorkbenchTab = {
    ...createWorkbenchTab(input.mint.tabId, surface),
    ...(sourceTab.topicId ? { topicId: sourceTab.topicId } : {})
  }

  // Land the new Tab adjacent to its source (immediately after it in the group's tabOrder) and make it
  // active — the user asked for this Region to become its own Tab, so they want to see it. Adjacency reads
  // better than the far end: the new Tab sits next to the split it came from. insertTabAfter finds the
  // source Tab's group, inserts after the anchor, sets the new Tab active, and focuses that group.
  const nextLayout = insertTabAfter(layout, input.tabId, input.mint.tabId)
  // insertTabAfter is a no-op (returns the SAME layout reference) exactly when the source Tab is in no
  // group — a Tab that lives in `tabs` but no layout group. Promoting from it would append the new Tab to
  // `tabs` while leaving it out of every group: an orphan that never renders and can never be closed (the
  // shape addTabPlacement's JSDoc describes). Refuse rather than strand it.
  if (nextLayout === layout) return { kind: 'unchanged' }

  return {
    kind: 'promoted',
    tabs: { ...input.tabs, [input.tabId]: detachedTab, [input.mint.tabId]: newTab },
    layouts: { ...input.layouts, [input.workspaceId]: nextLayout },
    target: { workspaceId: input.workspaceId, tabId: input.mint.tabId, regionId: input.regionId }
  }
}
