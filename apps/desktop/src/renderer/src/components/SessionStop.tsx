import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { agentMenuSession, agentMenuRunMatches, retainAgentMenuTarget, type AgentMenuTarget } from '../lib/agent-menu-target'
import { api } from '../lib/api'
import {
  mintSessionStopIntent, retainUnconfirmedStop, sessionStopErrorCode, sessionStopFailedStage, sessionStopInspectCommand,
  sessionStopIntentFor, settleSessionStop, STALE_STOP_CODE, type SessionStopIntent
} from '../lib/session-stop-intent'
import { useSessionStopElapsed } from '../lib/use-session-stop-elapsed'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'

/**
 * `failed`: the Stop was sent and its result is unconfirmed; Continue Stop resends the same intent.
 * `run-changed`: Core refused the named Run as stale; the intent is fresh, for the current Run.
 * `run-unread`: Core refused the named Run as stale and the current Run could not be read yet.
 */
type Phase = 'confirm' | 'failed' | 'run-changed' | 'run-unread'
type StopRequest = { target: { id: string; hostId: string }; name: string; intent: SessionStopIntent; phase: Phase; feedback?: string }

/** Confirmation state only. Core owns stopping, retirement and the resulting Run events. */
export function useSessionStop(active = true) {
  const [request, setRequest] = useState<StopRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { if (!active) setRequest(null) }, [active])
  const elapsed = useSessionStopElapsed(busy)
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
    // One user intent, one operation id: Continue Stop resends exactly this pair.
    setRequest({ target: { id, hostId }, name, intent: sessionStopIntentFor(control), phase: 'confirm' })
  }

  /** Core said the named Run is stale: read the Session's current Run and offer a new Stop for it. */
  async function readCurrentRun(original: StopRequest) {
    const { control } = original.intent
    try {
      const session = await api.sessions.refresh(control)
      if (session.kind !== 'agent' || session.control.hostId !== control.hostId || session.control.agentSessionId !== control.agentSessionId) {
        throw new Error('The refreshed Session belongs to another Agent.')
      }
      const feedback = `Current Run: ${session.control.run.runId}. Stop current Run sends a new Stop for it.`
      if (mounted.current) setRequest(value => value === original ? { ...original, intent: mintSessionStopIntent(session.control), phase: 'run-changed', feedback } : value)
    } catch (error) {
      const feedback = `The current Run could not be read: ${presentError(error)}`
      if (mounted.current) setRequest(value => value === original ? { ...original, phase: 'run-unread', feedback } : value)
    }
  }

  async function confirmStop() {
    if (!request || flight.current) return
    const original = request, { intent } = original
    flight.current = true
    setBusy(true)
    try {
      if (original.phase === 'run-unread') { await readCurrentRun(original); return }
      // Continue Stop passes the same frozen control and operation id. Core continues that Stop
      // or answers its retained receipt; this observer never creates a second one.
      retainUnconfirmedStop(intent)
      await api.sessions.stop(intent.control, intent.operationId)
      settleSessionStop(intent)
      if (mounted.current) setRequest(value => value === original ? null : value)
    } catch (error) {
      if (sessionStopErrorCode(error) === STALE_STOP_CODE) {
        settleSessionStop(intent)
        await readCurrentRun(original)
        return
      }
      const summary = `Stop ${intent.operationId} is unconfirmed. Its Session, history and drafts are kept. Continue Stop to check and finish that same operation.`
      useAppStore.getState().reportError(error, { kind: 'indeterminate', subject: intent.control, summary })
      const stage = sessionStopFailedStage(error), code = sessionStopErrorCode(error)
      const feedback = `${stage ? `Failed stage: ${stage}` : 'Failed stage: not recorded'}${code ? ` (${code})` : ''}. ${presentError(error)}`
      if (mounted.current) setRequest(value => value === original ? { ...original, phase: 'failed', feedback } : value)
    } finally {
      flight.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const copy = request ? stopDialogCopy(request.phase, ended) : null
  return {
    requestStop,
    dialog: request !== null && copy ? <ConfirmationDialog open title={copy.title} subject={request.name}
      description={copy.description} confirmLabel={copy.confirm} intent={copy.intent} busy={busy}
      feedback={<div className="confirmation-dialog__description" role="status" data-session-stop-status="">
        <p>{observation}</p>
        {elapsed ? <p data-session-stop-elapsed="">Stopping · {elapsed}</p> : null}
        {request.feedback ? <p>{request.feedback}</p> : null}
        {request.phase === 'failed' || busy ? <p data-session-stop-operation={request.intent.operationId}>
          Operation {request.intent.operationId} · <code>{sessionStopInspectCommand(request.intent)}</code>
        </p> : null}
      </div>}
      onCancel={() => setRequest(null)} onConfirm={() => { void confirmStop() }} /> : null
  }
}

function stopDialogCopy(phase: Phase, ended: boolean): { title: string; description: string; confirm: string; intent: 'danger' | 'neutral' } {
  switch (phase) {
    case 'failed': return { title: 'Stop not confirmed', intent: 'neutral', confirm: 'Continue Stop',
      description: 'Continue Stop sends this same operation again so Core checks and finishes it. Conversation history and drafts are kept. Cancel only closes this notice.' }
    case 'run-changed': return { title: 'Run changed', intent: 'danger', confirm: 'Stop current Run',
      description: 'The Run changed; stop the current Run. Nothing was stopped yet. Conversation history and drafts are kept.' }
    case 'run-unread': return { title: 'Run changed', intent: 'neutral', confirm: 'Read current Run',
      description: 'The Run changed and its current Run is not confirmed yet. Read it again before stopping. Nothing was stopped.' }
    case 'confirm': return ended
      ? { title: 'Close Agent?', intent: 'neutral', confirm: 'Close Agent',
        description: 'This Run has already ended. Close this retained Agent; its conversation history stays available for viewing and recovery.' }
      : { title: 'Stop Agent?', intent: 'danger', confirm: 'Stop Agent',
        description: 'Stop this Agent’s current Run. Its conversation history is kept for viewing and recovery.' }
  }
}
