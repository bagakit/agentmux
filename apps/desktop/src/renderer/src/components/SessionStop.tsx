import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { agentMenuSession, agentMenuRunMatches, retainAgentMenuTarget, type AgentMenuTarget } from '../lib/agent-menu-target'
import { sessionStopIntentFor, type SessionStopIntent } from '../lib/session-stop-intent'
import { stopSessionInBackground } from '../lib/session-stop-background'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'

type StopRequest = { target: { id: string; hostId: string }; name: string; intent: SessionStopIntent }

/** Confirmation owns no lifecycle work; the shared original operation outlives this presentation. */
export function useSessionStop(active = true) {
  const [request, setRequest] = useState<StopRequest | null>(null)
  const submitted = useRef<StopRequest | null>(null)
  useEffect(() => { if (!active) setRequest(null) }, [active])
  const subscribe = useCallback((listener: () => void) => request ? useAppStore.subscribe(listener) : () => {}, [request])
  const readSession = useCallback(() => request
    ? agentMenuSession(useAppStore.getState().sessions, { ...request.target, control: request.intent.control }) : undefined, [request])
  const current = useSyncExternalStore(subscribe, readSession, readSession)
  const sameRun = Boolean(request && agentMenuRunMatches(current, request.intent.control))
  const process = sameRun && !current?.runUnobserved ? current?.processState : undefined
  const ended = process === 'exited' || process === 'interrupted'
  const observation = process ? `Current Run: ${process}.` : 'The original Run’s current state is unknown.'

  function requestStop(target: AgentMenuTarget | null | undefined, name: string, origin: HTMLElement | null) {
    const state = useAppStore.getState()
    const session = agentMenuSession(state.sessions, target)
    if (!target?.control || !agentMenuRunMatches(session, target.control)) {
      state.reportError(new Error('This Agent’s current Run identity is unavailable. No stop request was sent.'), {
        kind: 'indeterminate', ...(target?.control ? { subject: target.control } : {}), summary: 'The original work surface is kept. Refresh this Agent’s observation, then retry Stop Agent.'
      })
      return
    }
    origin?.focus({ preventScroll: true })
    const { id, hostId, control } = retainAgentMenuTarget({ ...target, control: target.control })
    setRequest({ target: { id, hostId }, name, intent: sessionStopIntentFor(control) })
  }

  function confirmStop() {
    if (!request || submitted.current === request) return
    submitted.current = request
    setRequest(null)
    void stopSessionInBackground(request.intent)
  }

  return {
    requestStop,
    dialog: request !== null ? <ConfirmationDialog open title={ended ? 'Close Agent?' : 'Stop Agent?'} subject={request.name}
      description={ended
        ? 'This Run has already ended. Close this retained Agent; its conversation history stays available for viewing and recovery.'
        : 'Stop this Agent’s current Run. Its conversation history is kept for viewing and recovery.'}
      confirmLabel={ended ? 'Close Agent' : 'Stop Agent'} intent={ended ? 'neutral' : 'danger'}
      feedback={<p className="confirmation-dialog__description" data-session-stop-status="">{observation}</p>}
      onCancel={() => setRequest(null)} onConfirm={confirmStop} /> : null
  }
}
