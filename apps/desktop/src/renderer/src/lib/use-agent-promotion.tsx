import { useRef, useState } from 'react'
import type { AgentPromotionApply } from '@agentmux/core/agent-promotion'
import type { SessionSnapshot } from '../../../shared/contracts'
import type { WorkbenchProjectionSelection } from './workbench-projection'
import { focusAgentMenuLocation, requireFocusAgentMenuLocation } from './focus-agent-menu-location'
import { useAppStore } from '../store'
import { AgentPromotionDialog, type AgentPromotionSelection } from '../components/AgentPromotionDialog'

/** Resolve only the invoking Agent's exact occurrence, never the user's current focus. */
export function useAgentPromotion(session: Extract<SessionSnapshot, { kind: 'agent' }> | null | undefined,
  title: string, reference?: WorkbenchProjectionSelection, regionId?: string) {
  const [selection, setSelection] = useState<AgentPromotionSelection | null>(null)
  const intents = useRef(new Map<string, AgentPromotionApply>())
  const currentTarget = useRef<string | null>(null)
  currentTarget.current = session ? JSON.stringify({ hostId: session.control.hostId, agentSessionId: session.control.agentSessionId }) : null
  const selectedKey = selection ? JSON.stringify(selection.target) : null
  const [promoted, setPromoted] = useState<string | null>(null)
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
    dialog: selection ? <AgentPromotionDialog key={selectedKey} selection={selection} initialIntent={intents.current.get(selectedKey!) ?? null}
      onIntent={input => intents.current.set(JSON.stringify(input.target), input)} onClose={() => setSelection(null)} onPromoted={result => {
        const key = JSON.stringify(result.target), held = intents.current.get(key)
        if (!held || held.operationId !== result.operationId) return
        intents.current.delete(key)
        if (currentTarget.current === key) setPromoted(key)
      }} /> : null,
    feedback: promoted && promoted === currentTarget.current ? <span className="agent-promotion-feedback" role="status">已加入 Club<button type="button" className="icon-button" aria-label="关闭晋升提示" onClick={() => setPromoted(null)}>×</button></span> : null }
}
