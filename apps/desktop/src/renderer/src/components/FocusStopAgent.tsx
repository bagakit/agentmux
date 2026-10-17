import { useEffect, useRef, useState } from 'react'
import { agentMenuSession, agentMenuRunMatches, retainAgentMenuTarget, type AgentMenuTarget } from '../lib/agent-menu-target'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Confirmation state only. Core owns stopping, retirement and the resulting Run events. */
export function useFocusStopAgent(active = true) {
  const [request, setRequest] = useState<{ target: ReturnType<typeof retainAgentMenuTarget>; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!active) setRequest(null) }, [active])

  function requestStop(target: AgentMenuTarget | null | undefined, name: string, origin: HTMLElement | null) {
    const state = useAppStore.getState()
    const session = agentMenuSession(state.sessions, target)
    if (!target?.control || !agentMenuRunMatches(session, target.control)) {
      state.reportError(new Error('This Agent’s current Run identity is unavailable. No stop request was sent.'), {
        kind: 'indeterminate', ...(target?.control ? { subject: target.control } : {}), summary: 'The original work surface is kept. Refresh this Agent’s observation, then retry Stop Agent.'
      })
      return
    }
    // Give the existing dialog a durable return target instead of a disappearing menu item.
    origin?.focus({ preventScroll: true })
    setRequest({ target: retainAgentMenuTarget({ ...target, control: target.control }), name })
  }

  async function confirmStop() {
    if (!request || flight.current) return
    const { control } = request.target
    const state = useAppStore.getState()
    const current = agentMenuSession(state.sessions, request.target)
    if (!agentMenuRunMatches(current, control)) {
      state.reportError(new Error('The Agent’s Run changed after confirmation opened. No stop request was sent.'), {
        kind: 'indeterminate', subject: control, summary: 'The current Agent is kept. Open Stop Agent again to review its current Run.'
      })
      setRequest(null)
      return
    }
    flight.current = true
    setBusy(true)
    try {
      // The original public stop path also owns its timeout. An ACK is not a local status update.
      await api.sessions.stop(control)
    } catch (error) {
      useAppStore.getState().reportError(error, {
        kind: 'indeterminate', subject: control,
        summary: 'Stop Agent did not complete. Its current state is unconfirmed; the original work surface and draft are kept. Review its status, then retry Stop Agent.'
      })
    } finally {
      flight.current = false
      if (mounted.current) { setBusy(false); setRequest(null) }
    }
  }

  return {
    requestStop,
    dialog: request !== null ? <ConfirmationDialog open={request !== null} title="Stop Agent?" {...(request ? { subject: request.name } : {})}
      description="Stop this Agent’s current Run. Its conversation history is kept for viewing and recovery."
      confirmLabel="Stop Agent" busy={busy} onCancel={() => setRequest(null)} onConfirm={() => { void confirmStop() }} /> : null
  }
}
