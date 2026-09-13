import { workbenchSurfaces, type WorkbenchTab } from './workbench-tabs'
import { isSessionSurface } from './workbench-surface-kinds'
import type { WorkspaceLayout } from '@agentmux/layout'

/** Resolve the durable Tab that owns a focused execution session. */
export function tabForFocusedSession(
  tabs: Readonly<Record<string, WorkbenchTab>>,
  sessionId: string | null
): WorkbenchTab | null {
  if (!sessionId) return null
  // isSessionSurface is the SSOT for "agent-or-terminal": routing through it means a sixth
  // session-bearing surface kind added to WorkbenchSurface would break this call site at compile
  // time (via the exhaustiveness backstop in workbench-surface-kinds.ts), not silently drop the
  // new kind from focus routing — the failure mode workbench-surface-kind-exhaustiveness.test.ts
  // is guarding against.
  return Object.values(tabs).find((tab) => workbenchSurfaces(tab).some((surface) => (
    isSessionSurface(surface) && surface.sessionId === sessionId
  ))) ?? null
}

/** Render the selected Tab through the normal Workbench tree without creating a second Run owner. */
export function focusLayoutForTab(tab: WorkbenchTab): WorkspaceLayout {
  return {
    root: { type: 'leaf', groupId: `focus:${tab.id}` },
    groups: [{ id: `focus:${tab.id}`, activeTabId: tab.id, tabOrder: [tab.id], recentTabIds: [tab.id] }],
    activeGroupId: `focus:${tab.id}`
  }
}
