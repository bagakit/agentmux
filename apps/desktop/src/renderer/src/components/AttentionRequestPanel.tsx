import { usePathDisplay } from '../hooks/usePathDisplay'
import { semanticIconComponent } from '@agentmux/client-ui/icons'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentMuxInteractionResponse } from '@agentmux/core'
import { useAppStore } from '../store'
import { nextAttentionSessionId } from '../lib/agent-attention'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { AgentInteractionCard } from '@agentmux/client-ui/components/AgentInteractionCard'
import { isNeedsYouState } from '../lib/attention-vocabulary'
import { api } from '../lib/api'
import type { SessionSnapshot } from '../../../shared/contracts'

const ThemeActionCloseIcon = semanticIconComponent('action.close')
const ThemeActionOpenExternalIcon = semanticIconComponent('action.open-external')
const ThemeStatusCompletedIcon = semanticIconComponent('status.completed')
const ThemeNavigationForwardIcon = semanticIconComponent('navigation.forward')


type SubmittedInteraction = {
  hostId: string
  requestId: string
  runId: string | undefined
}

type FailedClose = {
  sessionId: string
  hostId: string
  runId: string
  label: string
  phase: 'requesting' | 'unconfirmed' | 'confirmed'
}

function canCloseFailure(session: SessionSnapshot | undefined): boolean {
  return session?.kind === 'agent' && session.status.state === 'error' && session.processState === 'exited'
}

function runIdFor(session: { control: { kind: string; run?: { runId?: string } } }): string | undefined {
  return session.control.kind === 'agent' ? session.control.run?.runId : undefined
}

function interactionRunId(
  session: { control: { kind: string; run?: { runId?: string } } },
  request: { evidence?: { run?: { runId?: string } } }
): string | undefined {
  return request.evidence?.run?.runId ?? runIdFor(session)
}

/**
 * The in-place answer surface for one Core-owned request.
 *
 * This component deliberately does not keep a queue of requests. The queue is derived from the
 * Store's current Session projection, and a response is only considered complete once that
 * projection no longer contains the exact request that was answered. That distinction matters for
 * a slow native hook: a resolved IPC call means bytes were accepted, not that the Agent has settled
 * the request. It also keeps a late response from an old Run from advancing a newer request.
 */
export function AttentionRequestPanel({
  sessionId,
  onClose,
  onReturnFocus,
  onSessionChange
}: {
  sessionId: string
  onClose: () => void
  onReturnFocus?: () => void
  onSessionChange?: (sessionId: string) => void
}) {
  const panelRef = useRef<HTMLElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [activeSessionId, setActiveSessionId] = useState(sessionId)
  const [submitted, setSubmitted] = useState<SubmittedInteraction | null>(null)
  const submittedRef = useRef<SubmittedInteraction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [caughtUp, setCaughtUp] = useState(false)
  const [failedClose, setFailedClose] = useState<FailedClose | null>(null)
  const failedCloseRef = useRef<FailedClose | null>(null)
  const closeDeadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const displayPath = usePathDisplay()
  const sessions = useAppStore((state) => state.sessions)
  const session = sessions.find((item) => item.id === activeSessionId)
  const selectSession = useAppStore((state) => state.selectSession)
  const respondInteraction = useAppStore((state) => state.respondInteraction)
  const request = session?.kind === 'agent' ? session.pendingInteraction : undefined

  // The parent owns whether the panel is mounted. Keep the initial opener so closing the panel
  // returns focus to the Review here control instead of leaving it on a detached node.
  useEffect(() => {
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement ? active : null
  }, [])

  // A new parent target starts a new review sequence. This is intentionally keyed to the parent
  // identity: changing the Store's request object must not reset the panel to a stale Session.
  useEffect(() => {
    setActiveSessionId(sessionId)
    setSubmitted(null)
    submittedRef.current = null
    setActionError(null)
    setCaughtUp(false)
    failedCloseRef.current = null
    setFailedClose(null)
    clearTimeout(closeDeadline.current)
  }, [sessionId])

  // Observe the existing semantic event owner only while this failed Session is being reviewed.
  // Its dispatcher excludes terminal bytes. Absence or a fulfilled stop promise is not retirement.
  const failed = session?.kind === 'agent' && session.status.state === 'error'
  useEffect(() => {
    if (!failed) return
    return api.sessions.onEvent((event) => {
      const claim = failedCloseRef.current
      const core = event.event
      if (!claim || core.type !== 'run-removed' || event.hostId !== claim.hostId
        || core.agentSessionId !== claim.sessionId || core.run.runId !== claim.runId) return
      const latest = useAppStore.getState().sessions.find(item => item.id === claim.sessionId)
      if (latest && (latest.kind !== 'agent' || latest.hostId !== claim.hostId || runIdFor(latest) !== claim.runId)) return
      clearTimeout(closeDeadline.current)
      const confirmed = { ...claim, phase: 'confirmed' as const }
      failedCloseRef.current = confirmed
      setFailedClose(confirmed)
    })
  }, [activeSessionId, failed])

  useEffect(() => () => {
    failedCloseRef.current = null
    clearTimeout(closeDeadline.current)
  }, [])

  function clearSubmission(claim: SubmittedInteraction): boolean {
    if (submittedRef.current !== claim) return false
    submittedRef.current = null
    setSubmitted(null)
    return true
  }

  // Local answer errors belong to the card that produced them, even after its attempt ended.
  useEffect(() => {
    setActionError(null)
    setCaughtUp(false)
  }, [activeSessionId, session?.hostId, session?.kind === 'agent' ? session.control.run.runId : undefined, request?.id])

  useEffect(() => {
    const claim = failedCloseRef.current
    if (!claim || claim.phase === 'confirmed' || !session) return
    if (session.kind === 'agent' && session.hostId === claim.hostId && runIdFor(session) === claim.runId) return
    failedCloseRef.current = null
    setFailedClose(null)
    clearTimeout(closeDeadline.current)
    setActionError('The Session or Run changed. The current Session was kept; the old close was not confirmed.')
  }, [session])

  // Focus the first useful action when a request changes. Do not steal focus from an action inside
  // this panel while the Store is merely repainting a Session status.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || (document.activeElement instanceof HTMLElement && panel.contains(document.activeElement))) return
    const target = panel.querySelector<HTMLElement>('button:not([disabled])')
    target?.focus()
  }, [activeSessionId, request?.id, caughtUp])

  // Core confirmation is the only success signal. A response promise can resolve before the hook
  // event has cleared pendingInteraction, so keep the card disabled until this effect observes the
  // projection converge. Replacing the request (or its Run) is a distinct path: show the new
  // request in place and discard the old submission claim.
  useEffect(() => {
    if (!submitted) return
    if (!session || session.kind !== 'agent') {
      clearSubmission(submitted)
      setActionError('This Session is temporarily unavailable. Its request was not marked complete.')
      return
    }
    const currentRequestId = session.pendingInteraction?.id
    const currentRunId = session.pendingInteraction ? interactionRunId(session, session.pendingInteraction) : runIdFor(session)
    if (session.hostId !== submitted.hostId || currentRunId !== submitted.runId) {
      clearSubmission(submitted)
      setActionError('The Session or Run changed. Showing its current request without confirming the old answer.')
      return
    }
    if (currentRequestId === undefined) {
      setActionError(null)
      // Removing the answered typed request confirms that answer, not the Provider's semantic
      // state. Keep this Session visible while Core still says it needs attention.
      if (isNeedsYouState(session.status.state) || session.status.state === 'error') {
        setCaughtUp(false)
        return
      }
      clearSubmission(submitted)
      const next = nextAttentionSessionId(sessions.filter((item) => item.id !== activeSessionId), null)
      if (next) {
        setActiveSessionId(next)
        onSessionChange?.(next)
        setCaughtUp(false)
        return
      }
      setCaughtUp(true)
      requestAnimationFrame(() => closeButtonRef.current?.focus())
      return
    }
    if (currentRequestId !== submitted.requestId || currentRunId !== submitted.runId) {
      clearSubmission(submitted)
      setActionError('The request changed while it was being answered. Showing the current request.')
    }
  }, [activeSessionId, session, sessions, submitted, onSessionChange])

  function close(): void {
    const restoreFocus = panelRef.current?.contains(document.activeElement)
    onClose()
    if (!restoreFocus) return
    requestAnimationFrame(() => {
      // A later control selection owns focus. BODY means closing removed its current owner.
      if (document.activeElement !== document.body) return
      const opener = openerRef.current
      if (opener && opener !== document.body && opener.isConnected) opener.focus()
      else onReturnFocus?.()
    })
  }

  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (!session || session.kind !== 'agent' || !request || submitted) return
    const claim = { hostId: session.hostId, requestId: request.id, runId: interactionRunId(session, request) }
    submittedRef.current = claim
    setSubmitted(claim)
    setActionError(null)
    setCaughtUp(false)
    try {
      await respondInteraction(activeSessionId, response)
    } catch (error) {
      if (submittedRef.current !== claim) return
      // A replacement can arrive at the same time as a rejected old response. Read the latest
      // projection before deciding whether this was an answer failure or a stale target.
      const latest = useAppStore.getState().sessions.find((item) => item.id === activeSessionId)
      const latestRequest = latest?.kind === 'agent' ? latest.pendingInteraction : undefined
      const latestRunId = latest?.kind === 'agent' && latestRequest ? interactionRunId(latest, latestRequest) : undefined
      if (!latest || !latestRequest) {
        // The Store already confirmed the old request (or the Session disappeared while recovering).
        // Do not let a late promise rejection paint an error onto the next request.
        clearSubmission(claim)
      } else if (latest.hostId !== claim.hostId || latestRequest.id !== claim.requestId || latestRunId !== claim.runId) {
        clearSubmission(claim)
        setActionError('The request changed before the answer was accepted. Showing the current request.')
      } else {
        clearSubmission(claim)
        setActionError(presentError(error))
      }
    }
  }

  async function closeFailedSession(): Promise<void> {
    if (!canCloseFailure(session) || !session || failedCloseRef.current?.phase === 'requesting') return
    const latest = useAppStore.getState().sessions.find(item => item.id === activeSessionId)
    // Recheck the displayed identity immediately before the existing control owner reads it.
    if (!canCloseFailure(latest) || !latest || latest.hostId !== session.hostId || runIdFor(latest) !== runIdFor(session)) {
      setActionError('The Session changed. Its current Run was kept; review the current facts before closing it.')
      return
    }
    const claim: FailedClose = { sessionId: latest.id, hostId: latest.hostId, runId: latest.control.run.runId, label: latest.label, phase: 'requesting' }
    failedCloseRef.current = claim
    setFailedClose(claim)
    setActionError(null)
    const unconfirmed = (): void => {
      if (failedCloseRef.current !== claim) return
      const waiting = { ...claim, phase: 'unconfirmed' as const }
      failedCloseRef.current = waiting
      setFailedClose(waiting)
      clearTimeout(closeDeadline.current)
    }
    // The existing service window reports stop failures. A deadline restores the retry action
    // without guessing whether a slow IPC stopped anything, or hiding the original work surface.
    closeDeadline.current = setTimeout(unconfirmed, 5_000)
    try { await useAppStore.getState().stopSession(claim.sessionId) }
    catch (error) {
      if (failedCloseRef.current === claim) setActionError(presentError(error))
    } finally { unconfirmed() }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    // The panel is a keyboard stop of its own. ArrowRight moves only after Core has confirmed the
    // current answer; while submitting it must never skip a still-pending request.
    if (event.key === 'ArrowRight' && caughtUp) {
      event.preventDefault()
      close()
    }
  }

  if (!session || session.kind !== 'agent') {
    const confirmed = failedClose?.phase === 'confirmed'
    return (
      <aside ref={panelRef} className="attention-request-panel" aria-label="Attention request" tabIndex={-1} onKeyDown={handleKeyDown}>
        <header className="attention-request-panel__header">
          <div><span>{confirmed ? 'Session closed' : 'Needs you'}</span><strong>{confirmed ? failedClose.label : 'Session unavailable'}</strong></div>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Close request" title="Close request" onClick={close}><ThemeActionCloseIcon size={14} /></button>
        </header>
        <div className="attention-request-panel__empty" role="status">{confirmed ? 'Core confirmed that this failed Session was closed. Your other work remains open.' : 'The Session is not currently available. Its close has not been confirmed. Return to Agents and try again.'}</div>
      </aside>
    )
  }

  const submitting = submitted !== null
  const resolved = !request && !isNeedsYouState(session.status.state)
  const failureTitle = canCloseFailure(session) ? 'Failed Session' : 'Session attention'
  const requestCard = request ? (
    <AgentInteractionCard
      key={JSON.stringify([session.hostId, session.id, session.control.run.runId, request.id])}
      request={request}
      responseUnavailableReason={session.interactionResponseUnavailableReason}
      onOpenTerminal={() => {
        useAppStore.getState().setViewMode(session.id, 'terminal')
        selectSession(session.id)
      }}
      disabled={session.processState !== 'running' || session.status.state === 'disconnected' || submitting}
      onRespond={respond}
    />
  ) : null
  return (
    <aside ref={panelRef} className="attention-request-panel" aria-label={`Request from ${session.label}`} tabIndex={-1} onKeyDown={handleKeyDown}>
      <header className="attention-request-panel__header">
        <div><span>{failed ? failureTitle : request ? 'Needs you' : 'No current request'}</span><strong>{session.label}</strong><small title={displayPath(session.workspacePath, session.hostId)}>{displayPath(session.workspacePath, session.hostId)}</small></div>
        <div className="attention-request-panel__actions">
          <button type="button" className="small-button" onClick={() => selectSession(session.id)}><ThemeActionOpenExternalIcon size={12} /> Open Session</button>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Close request" title="Close request" onClick={close}><ThemeActionCloseIcon size={14} /></button>
        </div>
      </header>
      {actionError ? <div className="attention-request-panel__error" role="alert" aria-live="polite">{actionError}</div> : null}
      {failed ? (
        <>
          <div className="attention-request-panel__error" role="status">{[
            session.status.detail?.trim(),
            session.status.exitCode === undefined ? null : `Exit code ${session.status.exitCode}`,
            session.status.exitReason === 'crashed' ? 'Process crashed' : session.status.exitReason === 'user-stopped' ? 'Stopped by you' : null
          ].filter(Boolean).join(' · ') || 'Core reported a Session error. Open the Session to inspect it.'}</div>
          <div className="attention-request-panel__empty" role="status">{failedClose?.phase === 'requesting'
            ? 'Closing this failed Session. Waiting for Core confirmation; its work surface stays here.'
            : failedClose?.phase === 'unconfirmed' ? 'Close is not confirmed. The Session remains here. Check the service message or retry.'
              : canCloseFailure(session) ? 'Core reports that this process exited. You can close this failed Session.'
                : session.processState === 'running' ? 'The Run is still alive. Open the Session to inspect the error; its input remains available.'
                  : 'The process state is not confirmed as exited. The Session and its work surface are kept.'}</div>
          {canCloseFailure(session) ? <button type="button" className="small-button attention-request-panel__next" disabled={failedClose?.phase === 'requesting'} onClick={() => void closeFailedSession()}>{failedClose?.phase === 'requesting' ? 'Closing…' : failedClose?.phase === 'unconfirmed' ? 'Retry closing failed Session' : 'Close failed Session'}</button> : null}
          {session.processState === 'running' ? requestCard : null}
        </>
      ) : caughtUp ? (
        <div className="attention-request-panel__empty" role="status" tabIndex={-1}>
          <ThemeStatusCompletedIcon size={15} aria-hidden="true" /> <span>All caught up. No other Agent is waiting for you.</span>
        </div>
      ) : resolved ? (
        <div className="attention-request-panel__empty" role="status">No current request. This view follows the same Core facts as the Session.</div>
      ) : request ? (
        requestCard
      ) : (
        <div className="attention-request-panel__empty" role="status">This Session needs attention, but Core has not exposed a typed request. Open the Session to inspect it.</div>
      )}
      {caughtUp ? <button type="button" className="small-button attention-request-panel__next" onClick={close}><ThemeNavigationForwardIcon size={12} /> Return to Agents</button> : null}
    </aside>
  )
}
