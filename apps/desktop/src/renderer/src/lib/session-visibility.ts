import type { WorkbenchTab } from './workbench-tabs'
import { workbenchSurfaces } from './workbench-tabs'
import type { AttentionVisibility } from './attention-event'

// Which Sessions the user can actually see right now.
//
// This exists so a notification is never raised for something happening in front of the user. That
// requires a real answer, not a guess: "the Store is projecting this Session" is not the same as "it is
// on screen". A Session in a background tab, a collapsed pane, or another tab group is projected and
// invisible, and notifying only for unprojected Sessions would mean never notifying at all.
//
// Visible means: the Session occupies a Region in a tab that is the ACTIVE tab of its tab group. Split
// panes are all on screen at once, so every Region of an active tab counts.

/**
 * The Session ids currently on screen.
 *
 * Reads the same tab/tab-group projection the workbench renders from, so it cannot drift from what is
 * actually displayed. An empty or un-hydrated store yields an empty set rather than throwing — the same
 * startup robustness the quick switcher needs.
 */
export function visibleSessionIds(input: {
  tabs: Readonly<Record<string, WorkbenchTab>> | undefined
  // Every tab group in the window, each naming the tab it currently shows.
  tabGroups: readonly { activeTabId: string | null }[] | undefined
}): Set<string> {
  const visible = new Set<string>()
  const activeTabIds = new Set(
    (input.tabGroups ?? []).flatMap((group) => (group.activeTabId ? [group.activeTabId] : []))
  )
  for (const tabId of activeTabIds) {
    const tab = input.tabs?.[tabId]
    if (!tab) continue
    // Every Region of an active tab is on screen simultaneously — a split shows both sides.
    for (const surface of workbenchSurfaces(tab)) {
      if (surface.kind === 'agent' || surface.kind === 'terminal') visible.add(surface.sessionId)
    }
  }
  return visible
}

/**
 * Build the visibility answer the attention decision needs.
 *
 * Window focus is an OS fact the caller supplies; on-screen-ness is derived here. Keeping them separate
 * is what lets a focused window still notify about a Session sitting in a background tab.
 */
export function sessionVisibility(input: {
  windowFocused: boolean
  visibleSessionIds: ReadonlySet<string>
}): (sessionId: string) => AttentionVisibility {
  return (sessionId) => ({
    windowFocused: input.windowFocused,
    sessionVisible: input.visibleSessionIds.has(sessionId)
  })
}
