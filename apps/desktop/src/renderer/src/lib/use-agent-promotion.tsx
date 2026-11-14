import { useState } from 'react'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { focusAgentMenuLocation, requireFocusAgentMenuLocation } from './focus-agent-menu-location'
import { useAppStore } from '../store'
import { AgentPromotionDialog, type AgentPromotionSelection } from '../components/AgentPromotionDialog'

/** Resolve only the invoking Agent's exact occurrence, never the user's current focus. */
export function useAgentPromotion(session: Extract<SessionSnapshot, { kind: 'agent' }> | null | undefined,
  title: string, reference?: WorkbenchProjectionSelection, regionId?: string) {
  const [selection, setSelection] = useState<AgentPromotionSelection | null>(null)
  const [promoted, setPromoted] = useState(false)
  function open() {
    if (!session) return
    try {
      const state = useAppStore.getState()
      const location = focusAgentMenuLocation(state, session, reference)
      const candidates = location.references.filter(value => !regionId || value.regionId === regionId)
      const exact = reference ?? (candidates.length === 1 ? candidates[0] : undefined)
      if (!exact) throw new Error('This Agent has no unique confirmed location. Open its exact workface to promote it; its work is retained.')
      requireFocusAgentMenuLocation(state, session, exact)
      setSelection({ target: { hostId: session.control.hostId, agentSessionId: session.control.agentSessionId },
        source: { hostId: session.control.hostId, sessionId: session.control.agentSessionId, ...exact }, title })
    } catch (cause) { useAppStore.getState().reportError(cause) }
  }
  return { open: session ? open : undefined,
    dialog: selection ? <AgentPromotionDialog key={JSON.stringify(selection.target)} selection={selection} onClose={() => setSelection(null)} onPromoted={() => setPromoted(true)} /> : null,
    feedback: promoted ? <span className="agent-promotion-feedback" role="status">已晋升为 Mote<button type="button" className="icon-button" aria-label="关闭晋升提示" onClick={() => setPromoted(false)}>×</button></span> : null }
}
