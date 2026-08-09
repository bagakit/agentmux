import type { WorkbenchTab } from './workbench-tabs'
import { workbenchSurfaces } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import type { WorkspaceLayout } from '@agentmux/layout'
import { surfaceNavigationVisibility } from './surface-navigation-visibility'
import type { AttentionVisibility } from './attention-event'

// Which Sessions the user can actually see right now.
//
// This exists so a notification is never raised for something happening in front of the user. That
// requires a real answer, not a guess: "the Store is projecting this Session" is not the same as "it is
// on screen". A Session in a background tab, a collapsed pane, another tab group, OR behind another
// Scratch Topic is projected and invisible, and notifying only for unprojected Sessions would mean
// never notifying at all.
//
// THE CONTRACT this file decides, and why it is NOT the same as the rail's:
//   A Topic-hidden Agent is OFF SCREEN, so its completion SHOULD notify. An OS notification is a
//   one-shot "this finished while you were looking elsewhere" — announcing an off-screen completion is
//   the whole point of the feature. That is deliberately the opposite of `row-attention.ts:51`, which
//   drops `done` from the PERSISTENT rail ink: a permanent mark for routine completion would drown the
//   one signal that must stay legible on the rail — "someone is waiting on you". Different surface,
//   different rule, stated here so the difference is a decision rather than an accident.
//
// THE AUTHORITY this file reads, and why it must be the only one:
//   "Is this Tab on screen right now" is answered in exactly ONE place — `surfaceNavigationVisibility`
//   (see its file header). The recyclers (terminal cold-parking, surface memory budget) already read it;
//   this path used to answer the same question a THIRD time by reading `layouts[ws].groups` RAW, and
//   because a raw group's stored `activeTabId` is never Topic-rewritten (`layoutForActiveTopic` is a
//   read-only projection), the two answers had already diverged: on a Scratch workspace the recyclers
//   treated a Topic-hidden Agent as off screen while THIS path treated it as on screen — so an Agent
//   finishing behind another Topic fired no notification. Delegating to the authority folds this path in
//   as its third consumer; the Topic projection now happens in one spot for all three.

/**
 * The Session ids currently on screen, for a given tab/layout projection.
 *
 * Every Tab is asked through the single authority whether it is visible (`tabVisible`), which applies
 * the active workspace, the workbench/board switch, AND the Scratch Topic projection. A Tab is on
 * screen when it is the active Tab of its (projected) group; a split shows every group's active Tab at
 * once, so every Region of each visible Tab counts. An empty or un-hydrated store yields an empty set
 * rather than throwing — the same startup robustness the quick switcher needs.
 */
export function visibleSessionIds(input: {
  tabs: Readonly<Record<string, WorkbenchTab>> | undefined
  layouts: Readonly<Record<string, WorkspaceLayout>> | undefined
  activeWorkspaceId: string | null
  workbenchVisible: boolean
}): Set<string> {
  const visible = new Set<string>()
  const tabs = input.tabs
  if (!tabs) return visible
  for (const tab of Object.values(tabs)) {
    const layout = input.layouts?.[tab.workspaceId]
    if (!layout) continue
    const { tabVisible } = surfaceNavigationVisibility(tab, layout, tabs, {
      activeWorkspaceId: input.activeWorkspaceId,
      workbenchVisible: input.workbenchVisible
    })
    if (!tabVisible) continue
    // Every Region of a visible Tab is on screen simultaneously — a split shows both sides.
    for (const surface of workbenchSurfaces(tab)) {
      if (isSessionSurface(surface)) visible.add(surface.sessionId)
    }
  }
  return visible
}

/**
 * The on-screen Session ids for the whole window, read straight from the Store projection.
 *
 * The attention hook cannot see App-local route state, so "is the workbench showing" is derived from
 * `mainSurface` alone: on the Board (`mainSurface !== 'workbench'`) the workbench is replaced entirely
 * and no Session Region is mounted, so nothing is visible. Keeping this extraction here — rather than
 * inlined at the hook — is what lets the same "state in, on-screen answer out" step be tested without a
 * window, exactly as the recyclers' `collect…Candidates` functions are.
 */
export function visibleSessionIdsForState(state: {
  mainSurface: string
  activeWorkspaceId?: string | null
  tabs?: Readonly<Record<string, WorkbenchTab>>
  layouts?: Readonly<Record<string, WorkspaceLayout>>
}): Set<string> {
  return visibleSessionIds({
    tabs: state.tabs,
    layouts: state.layouts,
    activeWorkspaceId: state.activeWorkspaceId ?? null,
    // The Board replaces the workbench, so no Region is on screen there.
    workbenchVisible: state.mainSurface === 'workbench'
  })
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
