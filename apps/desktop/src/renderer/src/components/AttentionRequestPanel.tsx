import { ArrowRight, ArrowUpRight, CheckCircle2, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AgentMuxInteractionResponse } from '@agentmux/core'
import { useAppStore } from '../store'
import { nextAttentionSessionId } from '../lib/agent-attention'
import { presentError } from '../lib/error-presentation'
import { AgentInteractionCard } from './AgentInteractionCard'

type SubmittedInteraction = {
  requestId: string
  runId: string | undefined
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
  onSessionChange
}: {
  sessionId: string
  onClose: () => void
  onSessionChange?: (sessionId: string) => void
}) {
  const panelRef = useRef<HTMLElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [activeSessionId, setActiveSessionId] = useState(sessionId)
  const [submitted, setSubmitted] = useState<SubmittedInteraction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [caughtUp, setCaughtUp] = useState(false)

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
    setActionError(null)
    setCaughtUp(false)
  }, [sessionId])

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
      setSubmitted(null)
      setActionError('This Session is temporarily unavailable. Its request was not marked complete.')
      return
    }
    const currentRequestId = session.pendingInteraction?.id
    const currentRunId = session.pendingInteraction ? interactionRunId(session, session.pendingInteraction) : runIdFor(session)
    if (currentRequestId === undefined) {
      setSubmitted(null)
      setActionError(null)
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
      setSubmitted(null)
      setActionError('The request changed while it was being answered. Showing the current request.')
    }
  }, [activeSessionId, session, sessions, submitted, onSessionChange])

  function close(): void {
    onClose()
    requestAnimationFrame(() => {
      const opener = openerRef.current
      if (opener && opener.isConnected) opener.focus()
    })
  }

  async function respond(response: AgentMuxInteractionResponse): Promise<void> {
    if (!session || session.kind !== 'agent' || !request || submitted) return
    const claim = { requestId: request.id, runId: interactionRunId(session, request) }
    setSubmitted(claim)
    setActionError(null)
    setCaughtUp(false)
    try {
      await respondInteraction(activeSessionId, response)
    } catch (error) {
      // A replacement can arrive at the same time as a rejected old response. Read the latest
      // projection before deciding whether this was an answer failure or a stale target.
      const latest = useAppStore.getState().sessions.find((item) => item.id === activeSessionId)
      const latestRequest = latest?.kind === 'agent' ? latest.pendingInteraction : undefined
      const latestRunId = latest?.kind === 'agent' && latestRequest ? interactionRunId(latest, latestRequest) : undefined
      if (!latest || !latestRequest) {
        // The Store already confirmed the old request (or the Session disappeared while recovering).
        // Do not let a late promise rejection paint an error onto the next request.
        setSubmitted(null)
      } else if (latestRequest.id !== claim.requestId || latestRunId !== claim.runId) {
        setSubmitted(null)
        setActionError('The request changed before the answer was accepted. Showing the current request.')
      } else {
        setSubmitted(null)
        setActionError(presentError(error))
      }
    }
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
    return (
      <aside ref={panelRef} className="attention-request-panel" aria-label="Attention request" tabIndex={-1} onKeyDown={handleKeyDown}>
        <header className="attention-request-panel__header">
          <div><span>Needs you</span><strong>Session unavailable</strong></div>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Close request" title="Close request" onClick={close}><X size={14} /></button>
        </header>
        <div className="attention-request-panel__empty" role="status">The Session is not currently available. Return to Agents and try again.</div>
      </aside>
    )
  }

  const submitting = submitted !== null
  return (
    <aside ref={panelRef} className="attention-request-panel" aria-label={`Request from ${session.label}`} tabIndex={-1} onKeyDown={handleKeyDown}>
      <header className="attention-request-panel__header">
        <div><span>Needs you</span><strong>{session.label}</strong><small>{session.workspacePath}</small></div>
        <div className="attention-request-panel__actions">
          <button type="button" className="small-button" onClick={() => selectSession(session.id)}><ArrowUpRight size={12} /> Open Session</button>
          <button ref={closeButtonRef} type="button" className="icon-button" aria-label="Close request" title="Close request" onClick={close}><X size={14} /></button>
        </div>
      </header>
      {actionError ? <div className="attention-request-panel__error" role="alert" aria-live="polite">{actionError}</div> : null}
      {caughtUp ? (
        <div className="attention-request-panel__empty" role="status" tabIndex={-1}>
          <CheckCircle2 size={15} aria-hidden="true" /> <span>All caught up. No other Agent is waiting for you.</span>
        </div>
      ) : request ? (
        <AgentInteractionCard
          request={request}
          disabled={session.processState !== 'running' || session.status.state === 'disconnected' || submitting}
          onRespond={respond}
        />
      ) : (
        <div className="attention-request-panel__empty" role="status">This Session needs attention, but Core has not exposed a typed request. Open the Session to inspect it.</div>
      )}
      {caughtUp ? <button type="button" className="small-button attention-request-panel__next" onClick={close}><ArrowRight size={12} /> Return to Agents</button> : null}
    </aside>
  )
}
