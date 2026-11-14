import { useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { focusAgentMenuLocation, requireFocusAgentMenuLocation } from './focus-agent-menu-location'
import { agentMenuRunMatches, agentMenuSession } from './agent-menu-target'
import type { TakeoverSource } from './session-takeover'
import { SessionTakeoverSurface } from '../components/SessionTakeoverSurface'
import { FocusWorkspaceStage } from '../components/FocusWorkspaceStage'
import { useAppStore } from '../store'

/** Promotion selects a Club in the original Takeover surface; it has no separate creation path. */
export function useAgentPromotion(session: Extract<SessionSnapshot, { kind: 'agent' }> | null | undefined,
  title: string, reference?: WorkbenchProjectionSelection, regionId?: string) {
  const [source, setSource] = useState<TakeoverSource | null>(null)
  function open() {
    if (!session) return
    try {
      const state = useAppStore.getState(), current = agentMenuSession(state.sessions, session)
      if (!current || !agentMenuRunMatches(current, session.control)) throw new Error('The original Agent or Run changed. Reopen its menu to choose the current work.')
      const location = focusAgentMenuLocation(state, session, reference)
      const candidates = location.references.filter(value => !regionId || value.regionId === regionId)
      const exact = reference ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (exact) {
        requireFocusAgentMenuLocation(state, session, exact)
        if (!state.focusExecutionSession(current.id, exact)) return
        state.requestRegionDerivedAction({ tabId: exact.tabId, regionId: exact.regionId, sessionId: current.id,
          runId: current.control.run.runId, actionId: 'mote-promotion' })
        return
      }
      setSource({ kind: 'session', agentSessionId: current.control.agentSessionId, presentationSessionId: current.id,
        hostId: current.control.hostId, expectedRun: { ...current.control.run }, cwd: current.workspacePath,
        executorId: current.executorId, label: title, diagnostic: current.status.detail ?? '',
        origin: { sessionId: current.id }, destinationKind: 'club' })
    } catch (cause) { useAppStore.getState().reportError(cause) }
  }
  return { open: session ? open : undefined, feedback: null,
    dialog: source ? <FocusWorkspaceStage><SessionTakeoverSurface source={source} active onClose={() => setSource(null)} /></FocusWorkspaceStage> : null }
}
