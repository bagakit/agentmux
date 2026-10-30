import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { agentMenuSession, agentMenuRunMatches, retainAgentMenuTarget, type AgentMenuTarget } from '../lib/agent-menu-target'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Confirmation state only. Core owns stopping, retirement and the resulting Run events. */
export function useSessionStop(active = true) {
  const [request, setRequest] = useState<{ target: ReturnType<typeof retainAgentMenuTarget>; name: string; submitted: boolean; feedback?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!active) setRequest(null) }, [active])
  const subscribe = useCallback((listener: () => void) => request ? useAppStore.subscribe(listener) : () => {}, [request])
  const readSession = useCallback(() => request ? agentMenuSession(useAppStore.getState().sessions, request.target) : undefined, [request])
  const current = useSyncExternalStore(subscribe, readSession, readSession)
  const sameRun = Boolean(request && agentMenuRunMatches(current, request.target.control))
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
    setRequest({ target: retainAgentMenuTarget({ ...target, control: target.control }), name, submitted: false })
  }

  async function confirmStop() {
    if (!request || flight.current) return
    const original = request, { control } = original.target
    const state = useAppStore.getState()
    const current = agentMenuSession(state.sessions, original.target)
    if (!agentMenuRunMatches(current, control)) {
      const detail = 'The original Run is no longer confirmed for this Agent. No stop request was sent. Close this notice and review the current Agent.'
      setRequest(value => value === original ? { ...original, feedback: detail } : value)
      state.reportError(new Error('The Agent’s Run changed after confirmation opened. No stop request was sent.'), {
        kind: 'indeterminate', subject: control, summary: 'The current Agent is kept. Open Stop Agent again to review its current Run.'
      })
      return
    }
    flight.current = true
    setBusy(true)
    try {
      // Explicit continuation passes the same frozen control. Core reconciles its
      // retained lifecycle/Runtime operation; this observer never creates a new one.
      await api.sessions.stop(control)
      if (mounted.current) setRequest(value => value === original ? null : value)
    } catch (error) {
      const summary = 'The original Stop result is unconfirmed. Its Session, history and drafts are kept. Continue Stop to check and finish that same operation.'
      useAppStore.getState().reportError(error, { kind: 'indeterminate', subject: control, summary })
      if (mounted.current) {
        setRequest(value => value === original ? { ...original, submitted: true, feedback: presentError(error) } : value)
      }
    } finally {
      flight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return {
    requestStop,
    dialog: request !== null ? <ConfirmationDialog open title={request.submitted ? 'Stop not confirmed' : ended ? 'Close Agent?' : 'Stop Agent?'} subject={request.name}
      description={request.submitted
        ? 'Continue the original Stop to check and finish its result. Conversation history and drafts are kept. Cancel only closes this notice.'
        : ended
          ? 'This Run has already ended. Close this retained Agent; its conversation history stays available for viewing and recovery.'
          : 'Stop this Agent’s current Run. Its conversation history is kept for viewing and recovery.'}
      confirmLabel={request.submitted ? 'Continue Stop' : ended ? 'Close Agent' : 'Stop Agent'} intent={request.submitted || ended ? 'neutral' : 'danger'} busy={busy}
      feedback={<div className="confirmation-dialog__description" role="status" data-session-stop-status="">
        <p>{observation}</p>{request.feedback ? <p>{request.feedback}</p> : null}
      </div>}
      onCancel={() => setRequest(null)} onConfirm={() => { void confirmStop() }} /> : null
  }
}
