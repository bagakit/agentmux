import { useEffect, useRef, useState } from 'react'
import type { AgentSessionControl, SessionRestartResult } from '../../../shared/contracts'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useAppStore } from '../store'
import { originalSessionRestart } from '../lib/session-original-recovery'
import { ConfirmationDialog } from './ConfirmationDialog'

/** Local confirmation only; the original Core lifecycle owns progress and reconciliation. */
export function useSessionRestart(active = true) {
  const [request, setRequest] = useState<{
    control: AgentSessionControl; name: string; operationId: string; submitted: boolean; canRetry: boolean; failed?: boolean
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const flight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!active && !flight.current) setRequest(null) }, [active])

  function requestRestart(sessionId: string, name: string, origin: HTMLElement | null = null) {
    const state = useAppStore.getState()
    const session = state.sessions.find(item => item.id === sessionId)
    if (session?.kind !== 'agent') {
      state.reportError(new Error('The original Agent Run is not confirmed. Re-read this Session before restarting it.'), { kind: 'indeterminate' })
      return
    }
    let pending
    try { pending = originalSessionRestart(session) }
    catch (error) { state.reportError(error, { kind: 'indeterminate', subject: session.control }); return }
    origin?.focus({ preventScroll: true })
    setFeedback(pending ? 'An original restart is retained. Check its result before sending another request.' : null)
    setRequest({ control: { ...session.control, run: { ...(pending?.previousRun ?? session.control.run) } },
      name, operationId: pending?.operationId ?? crypto.randomUUID(), submitted: Boolean(pending), canRetry: false })
  }

  async function confirmRestart() {
    if (!request || flight.current) return
    const original = request
    const state = useAppStore.getState()
    const current = state.sessions.find(item => item.id === original.control.agentSessionId)
    if (original.failed) {
      if (current?.kind !== 'agent' || current.control.hostId !== original.control.hostId) return
      setRequest({ control: { ...current.control, run: { ...current.control.run } }, name: original.name,
        operationId: crypto.randomUUID(), submitted: false, canRetry: false })
      setFeedback('The previous startup failed. Review this new restart before confirming it.')
      return
    }
    if (!original.submitted && (current?.kind !== 'agent' || current.control.hostId !== original.control.hostId ||
        current.control.run.runId !== original.control.run.runId)) {
      setFeedback('The Run changed while this confirmation was open. No restart was sent. Close and review the current Session.')
      return
    }
    flight.current = true
    setBusy(true)
    try {
      const result: SessionRestartResult = await state.restartSession(original.control, original.operationId,
        original.submitted && !original.canRetry)
      if (!mounted.current) return
      if (result.phase === 'restarted') { setRequest(null); setFeedback(null); return }
      setRequest({ ...original, submitted: true, canRetry: result.canRetry, failed: result.phase === 'failed' })
      setFeedback(result.detail ?? (result.phase === 'not-found'
        ? 'Core has not recorded this restart. You can retry the same request.'
        : 'Restart is not yet confirmed. Your original Session and request are retained.'))
    } catch (error) {
      if (mounted.current) {
        setRequest({ ...original, submitted: true, canRetry: false })
        setFeedback(`${presentError(error)} Check the original restart before trying again.`)
      }
    } finally {
      flight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return {
    requestRestart,
    dialog: <ConfirmationDialog open={request !== null} title={request?.submitted ? 'Session restart' : 'Restart Session?'}
      {...(request ? { subject: request.name } : {})}
      description={request?.submitted
        ? 'This checks the original operation. Your conversation, drafts and work surface stay here.'
        : 'Stop this Session’s current Run and restore the same conversation. Running work will be interrupted; previous messages will not be sent again.'}
      confirmLabel={request?.failed ? 'Review new restart' : request?.submitted ? request.canRetry ? 'Retry original restart' : 'Check restart' : 'Restart Session'}
      intent={request?.submitted ? 'neutral' : 'danger'} busy={busy}
      feedback={feedback ? <p role="status" className="confirmation-dialog__description">{feedback}</p> : undefined}
      onCancel={() => setRequest(null)} onConfirm={() => { void confirmRestart() }} />
  }
}
