import { useRef, useState } from 'react'
import type { AgentSessionControl } from '../../../shared/contracts'
import type { FocusContext } from '../lib/focus-context'
import { api } from '../lib/api'
import { useAppStore } from '../store'
import { ConfirmationDialog } from './ConfirmationDialog'

type Target = { name: string; presentation: { id: string; hostId: string }; control: AgentSessionControl }
type Result = { target: Target; completed: boolean; message: string }

/** Selection is presentation state; every close still goes through the original Core stop path. */
export function useWorkspaceAgentClose() {
  const [request, setRequest] = useState<Target[] | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [busy, setBusy] = useState(false)
  const flight = useRef(false)

  function requestClose(contexts: readonly FocusContext[]) {
    if (contexts.some(context => !context.control)) {
      useAppStore.getState().reportError(new Error('The original Agent control is unobserved. No close request was sent.'), {
        kind: 'indeterminate', summary: 'The original workface and selection are kept. Refresh this list to review its exact current Runs.'
      })
      return
    }
    setRequest(contexts.map(context => ({ name: context.name, presentation: { id: context.id, hostId: context.hostId },
      control: { ...context.control!, run: { ...context.control!.run } } })))
  }

  async function confirmClose() {
    if (!request || flight.current) return
    flight.current = true
    setBusy(true)
    const next = await Promise.all(request.map(async (target: Target): Promise<Result> => {
      const { control } = target
      const current = useAppStore.getState().sessions.find(session => session.kind === 'agent' &&
        session.hostId === target.presentation.hostId && session.id === target.presentation.id)
      // Refuse only the stale selected operation; keep the new Run and its workface available.
      if (current?.kind !== 'agent' || current.control.hostId !== control.hostId || current.control.agentSessionId !== control.agentSessionId || current.control.run.runId !== control.run.runId) {
        useAppStore.getState().reportError(new Error('The selected Agent Run changed or is unobserved. No close request was sent.'), {
          kind: 'indeterminate', subject: control, summary: 'The original workface is kept. Select the current Run to review Close Agents again.'
        })
        return { target, completed: false, message: 'Run changed or is unobserved. No close request sent; select its current Run to try again.' }
      }
      try {
        await api.sessions.stop(control)
        return { target, completed: true, message: 'Stop completed. Conversation history is kept.' }
      } catch (error) {
        useAppStore.getState().reportError(error, {
          kind: 'indeterminate', subject: control,
          summary: 'Close Agent did not complete. Its current state is unconfirmed; the original workface is kept. Review the original Agent before retrying.'
        })
        return { target, completed: false, message: `Close unconfirmed. ${error instanceof Error ? error.message : String(error)} Review this Agent before retrying; its workface is kept.` }
      }
    }))
    setResults(next)
    setRequest(null)
    setBusy(false)
    flight.current = false
  }

  return {
    requestClose, busy, results, clearResults: () => setResults([]),
    dialog: <ConfirmationDialog open={request !== null} title={`Close ${request?.length ?? 0} Agents?`}
      description="Stop the selected current Runs. Conversation history and work surfaces are kept for viewing and recovery."
      confirmLabel="Close Agents" busy={busy} onCancel={() => setRequest(null)} onConfirm={() => { void confirmClose() }}
      feedback={<ul className="workspace-agents-tool__close-targets">{request?.map(({ name, control }) => <li key={JSON.stringify([control.hostId, control.agentSessionId])}>
        <strong>{name}</strong><small>{control.hostId} · {control.agentSessionId} · Run {control.run.runId}</small>
      </li>)}</ul>} />
  }
}
