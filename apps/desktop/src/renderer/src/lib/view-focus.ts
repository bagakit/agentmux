import { resolveAgentMuxViewFocus, type AgentMuxOpenView } from '@agentmux/core/runtime'
import type {
  DesktopViewFocusResult,
  DesktopViewFocusTarget,
  SessionSnapshot
} from '../../../shared/contracts'
import { findGroupForTab, type WorkspaceLayout } from './workbench-layout'
import type { WorkbenchTab } from './workbench-tabs'

export function resolveWorkbenchViewFocus(input: {
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  layouts: Readonly<Record<string, WorkspaceLayout>>
  target: DesktopViewFocusTarget
}): DesktopViewFocusResult {
  const sessions = new Map(input.sessions.map((session) => [session.id, session]))
  const openTabIds = new Set(Object.values(input.layouts).flatMap((layout) => (
    layout.groups.flatMap((group) => group.tabOrder)
  )))
  const views = Object.values(input.tabs).reduce<AgentMuxOpenView[]>((result, tab) => {
    if (
      !openTabIds.has(tab.id) ||
      (tab.kind !== 'agent' && tab.kind !== 'terminal') ||
      tab.phase !== 'attached'
    ) return result
    const session = sessions.get(tab.sessionId)
    if (!session || session.kind !== tab.kind) return result
    result.push(tab.kind === 'agent'
      ? { viewId: tab.id, kind: 'agent', agentSessionId: tab.sessionId }
      : { viewId: tab.id, kind: 'terminal' })
    return result
  }, [])
  const resolved = resolveAgentMuxViewFocus(views, input.target)
  const tab = input.tabs[resolved.viewId]
  if (!tab || (tab.kind !== 'agent' && tab.kind !== 'terminal')) {
    throw new Error('Resolved Desktop View is no longer open.')
  }
  const layout = input.layouts[tab.workspaceId]
  const pane = layout ? findGroupForTab(layout, tab.id) : null
  if (!pane) throw new Error('Resolved Desktop View is no longer in an open Pane.')
  return {
    ...resolved,
    workspaceId: tab.workspaceId,
    paneId: pane.id
  }
}
