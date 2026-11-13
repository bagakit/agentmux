import { useRef, useState } from 'react'
import { presentError } from '@agentmux/client-ui/error-presentation'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { FocusContext } from '../lib/focus-context'
import { api } from '../lib/api'
import {
  mintSessionStopIntent, retainUnconfirmedStop, sessionStopErrorCode, sessionStopFailedStage, sessionStopInspectCommand,
  sessionStopIntentFor, settleSessionStop, STALE_STOP_CODE
} from '../lib/session-stop-intent'
import { useSessionStopElapsed } from '../lib/use-session-stop-elapsed'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'

/**
 * One selected Agent's Stop intent. `operationId` is minted once per intent and resent unchanged by
 * Continue Stop. `retry` says why it is still listed: `failed` resends the same intent; `run-changed`
 * already holds a fresh intent for the Session's current Run.
 */
type Target = { name: string; presentation: { id: string; hostId: string }; control: AgentSessionControl; operationId: string
  retry?: 'failed' | 'run-changed'; note?: string }
type Result = { target: Target; completed: boolean; message: string }
type Outcome = { result: Result; retry?: Target }

/** Selection is presentation state; every close still goes through the original Core stop path. */
export function useWorkspaceAgentClose() {
  const [request, setRequest] = useState<Target[] | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)
  const elapsed = useSessionStopElapsed(busy)

  function requestClose(contexts: readonly FocusContext[]) {
    if (contexts.some(context => !context.control)) {
      useAppStore.getState().reportError(new Error('The original Agent control is unobserved. No close request was sent.'), {
        kind: 'indeterminate', summary: 'The original workface and selection are kept. Refresh this list to review its exact current Runs.'
      })
      return
    }
    setRequest(contexts.map(context => ({ name: context.name, presentation: { id: context.id, hostId: context.hostId },
      ...sessionStopIntentFor(context.control!) })))
  }

  /** Core refused the named Run as stale: read the current Run and list a fresh intent for it. */
  async function currentRunTarget(target: Target): Promise<Outcome> {
    const { control } = target
    try {
      const session = await api.sessions.refresh(control)
      if (session.kind !== 'agent' || session.control.hostId !== control.hostId || session.control.agentSessionId !== control.agentSessionId) {
        throw new Error('The refreshed Session belongs to another Agent.')
      }
      const note = `The Run changed; stop the current Run ${session.control.run.runId}. The current Run was not stopped.`
      return { result: { target, completed: false, message: note },
        retry: { ...target, ...mintSessionStopIntent(session.control), retry: 'run-changed', note } }
    } catch (error) {
      return { result: { target, completed: false,
        message: `The Run changed and its current Run could not be read: ${presentError(error)} The current Run was not stopped; select it again to review its current Run.` } }
    }
  }

  async function stopTarget(target: Target): Promise<Outcome> {
    const { control, operationId } = target
    try {
      // Core checks the exact expected Run; a stale selection comes back as STALE_AGENT_SESSION.
      retainUnconfirmedStop(target)
      await api.sessions.stop(control, operationId)
      settleSessionStop(target)
      return { result: { target, completed: true, message: 'Stop completed. Conversation history is kept.' } }
    } catch (error) {
      if (sessionStopErrorCode(error) === STALE_STOP_CODE) { settleSessionStop(target); return await currentRunTarget(target) }
      useAppStore.getState().reportError(error, {
        kind: 'indeterminate', subject: control,
        summary: `Stop ${operationId} is unconfirmed; the original workface is kept. Continue Stop sends that same operation again.`
      })
      const stage = sessionStopFailedStage(error), code = sessionStopErrorCode(error)
      const note = `${stage ? `Failed stage: ${stage}` : 'Failed stage: not recorded'}${code ? ` (${code})` : ''}. ${presentError(error)}`
      return { result: { target, completed: false, message: `Stop unconfirmed. ${note} Operation ${operationId}.` },
        retry: { ...target, retry: 'failed', note } }
    }
  }

  async function confirmClose() {
    if (!request || flight.current) return
    flight.current = true
    setBusy(true)
    try {
      const outcomes = await Promise.all(request.map(stopTarget))
      setResults(outcomes.map(outcome => outcome.result))
      // Unconfirmed and changed Runs stay in this dialog with their intents; confirmed ones leave.
      const retries = outcomes.flatMap(outcome => outcome.retry ? [outcome.retry] : [])
      setRequest(retries.length ? retries : null)
    } finally {
      setBusy(false)
      flight.current = false
    }
  }

  const retrying = Boolean(request?.some(target => target.retry))
  const continuing = Boolean(request?.some(target => target.retry === 'failed'))
  return {
    requestClose, busy, results, clearResults: () => setResults([]),
    dialog: <ConfirmationDialog open={request !== null}
      title={retrying ? (continuing ? 'Stop not confirmed' : 'Run changed') : `Close ${request?.length ?? 0} Agents?`}
      description={retrying
        ? 'Continue Stop sends each unconfirmed operation again and stops each changed Agent’s current Run. Conversation history and work surfaces are kept. Cancel only closes this notice.'
        : 'Stop the selected current Runs. Conversation history and work surfaces are kept for viewing and recovery.'}
      confirmLabel={retrying ? (continuing ? 'Continue Stop' : 'Stop current Runs') : 'Close Agents'} intent={continuing ? 'neutral' : 'danger'}
      busy={busy} onCancel={() => setRequest(null)} onConfirm={() => { void confirmClose() }}
      feedback={<>
        {elapsed ? <p className="confirmation-dialog__description" role="status" data-session-stop-elapsed="">Stopping · {elapsed}</p> : null}
        <ul className="workspace-agents-tool__close-targets">{request?.map(target => <li key={JSON.stringify([target.control.hostId, target.control.agentSessionId])}
          data-session-stop-operation={target.operationId}>
          <strong>{target.name}</strong><small>{target.control.hostId} · {target.control.agentSessionId} · Run {target.control.run.runId}</small>
          {target.note ? <small>{target.note}</small> : null}
          {target.retry === 'failed' ? <small><code>{sessionStopInspectCommand(target)}</code></small> : null}
        </li>)}</ul>
      </>} />
  }
}
