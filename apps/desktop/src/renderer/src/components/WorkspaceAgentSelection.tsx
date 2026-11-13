import { useEffect, useRef, useState } from 'react'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { FocusContext } from '../lib/focus-context'
import { agentOperationKey } from '../lib/agent-operation'
import { sessionStopIntentFor } from '../lib/session-stop-intent'
import { stopSessionInBackground } from '../lib/session-stop-background'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'

type Target = { name: string; presentation: { id: string; hostId: string }; control: AgentSessionControl; operationId: string }
type Result = { target: Target; completed: boolean; message: string }

/** Selection is presentation state; each confirmed original Stop proceeds independently. */
export function useWorkspaceAgentClose() {
  const [request, setRequest] = useState<Target[] | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const submitted = useRef<Target[] | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])

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

  function confirmClose() {
    if (!request || submitted.current === request) return
    submitted.current = request
    setRequest(null)
    for (const target of request) {
      void stopSessionInBackground(target).then(completed => {
        if (!mounted.current) return
        const operation = useAppStore.getState().agentOperations[agentOperationKey({ kind: 'stop', operationId: target.operationId,
          subject: { hostId: target.control.hostId, agentSessionId: target.control.agentSessionId } })]
        const result = { target, completed, message: completed ? 'Stop completed. Conversation history is kept.'
          : operation?.message ?? 'Stop unconfirmed. Check the original operation on this Agent.' }
        setResults(previous => [...previous.filter(item => item.target.operationId !== target.operationId ||
          item.target.control.hostId !== target.control.hostId), result])
      })
    }
  }

  return {
    requestClose, results, clearResults: () => setResults([]),
    dialog: request !== null ? <ConfirmationDialog open title={`Close ${request.length} Agents?`}
      description="Stop the selected current Runs. Conversation history is kept for viewing and recovery."
      confirmLabel="Close Agents" intent="danger" onCancel={() => setRequest(null)} onConfirm={confirmClose}
      feedback={<ul className="workspace-agents-tool__close-targets">{request.map(target => <li key={JSON.stringify([target.control.hostId, target.control.agentSessionId])}
        data-session-stop-operation={target.operationId}>
        <strong>{target.name}</strong><small>{target.control.hostId} · {target.control.agentSessionId} · Run {target.control.run.runId}</small>
      </li>)}</ul>} /> : null
  }
}
