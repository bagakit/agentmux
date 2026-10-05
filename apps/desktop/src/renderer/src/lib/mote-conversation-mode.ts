import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { MoteWorkfaceScope } from './mote-workface'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { confirmedMoteReference } from './mote-materials-actions'
import { effectiveSessionViewMode, sessionPresentationById } from './session-presentation'
import { useAppStore } from '../store'

/** An entry changes presentation only. Original resource and occurrence checks stay shared. */
export function showMoteConversation(scope: MoteWorkfaceScope, options: {
  floating?: boolean; reference?: WorkbenchProjectionSelection | null | undefined
} = {}): boolean {
  const state = useAppStore.getState()
  const reference = confirmedMoteReference(state, scope, options)
  if (!reference) return false
  const region = state.tabs[reference.tabId]?.regions[reference.regionId]
  const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
  if (!session || session.kind !== 'agent') return false
  if (effectiveSessionViewMode(state, session.id) !== 'activity') state.setViewMode(session.id, 'activity', { focus: false })
  return true
}

/** Cold metadata may finish this entry; later human input, closing or a new entry wins. */
export function useMoteConversationMode(scope: MoteWorkfaceScope | null, entry: {
  workspaceId: string; topicId?: string | undefined; active: boolean; floating: boolean
  reference?: WorkbenchProjectionSelection | null | undefined
  conversationEntry?: number | undefined
}) {
  const selection = useAppStore(state => entry.active && !entry.floating ? state.workbenchSpaceSelection : null)
  const reference = entry.floating ? entry.reference : selection?.groupId && selection.tabId && selection.regionId
    ? { displayWorkspaceId: selection.workspaceId, groupId: selection.groupId, tabId: selection.tabId, regionId: selection.regionId } : null
  const active = entry.active && (!entry.floating || entry.conversationEntry !== undefined)
  const key = JSON.stringify([active, entry.workspaceId, entry.topicId ?? selection?.topicId, entry.floating, entry.conversationEntry])
  const target = reference === undefined ? undefined : JSON.stringify(reference)
  const attempt = useRef<{ key: string; done: boolean; target?: string | undefined }>({ key, done: false, target })
  const facts = useAppStore(useShallow(state => {
    if (!active || !reference) return null
    const tab = state.tabs[reference.tabId], region = tab?.regions[reference.regionId]
    const session = region?.kind === 'agent' ? sessionPresentationById(state.sessions).get(region.sessionId) : undefined
    return { tab, layout: state.layouts[reference.displayWorkspaceId], bindings: state.spaceZoneBindings,
      workspace: scope ? state.config?.workspaces.find(item => item.id === scope.workspace.id) : undefined,
      session: session?.kind === 'agent' ? JSON.stringify([session.id, session.control.hostId, session.control.agentSessionId]) : null }
  }))
  useEffect(() => {
    if (attempt.current.key !== key) attempt.current = { key, done: false, target }
    const current = attempt.current
    if (current.target === undefined) current.target = target
    else if (current.target !== target) current.done = true
    if (!active || current.done) return
    if (scope && !scope.issue && showMoteConversation(scope, { floating: entry.floating, reference })) {
      current.done = true
      return
    }
    const cancel = () => { current.done = true }
    // Only pending entry preparation observes input; resolved and hidden instances do no work.
    document.addEventListener('pointerdown', cancel, true)
    document.addEventListener('keydown', cancel, true)
    document.addEventListener('input', cancel, true)
    return () => {
      document.removeEventListener('pointerdown', cancel, true)
      document.removeEventListener('keydown', cancel, true)
      document.removeEventListener('input', cancel, true)
    }
  }, [key, target, scope, facts, active, entry.floating, reference?.displayWorkspaceId, reference?.groupId, reference?.tabId, reference?.regionId])
}
