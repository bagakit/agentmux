import { useRef, useState } from 'react'
import { notebookFingerprint, type NotebookChange } from '@agentmux/core/notebook-catalog'
import { changeNotebook } from '../lib/notebook-library'
import { presentError } from '@agentmux/client-ui/error-presentation'

/** Retain the exact metadata operation until its original owner confirms the result. */
export function useNotebookOperation() {
  const held = useRef<{ operationId: string; change: NotebookChange; complete?: () => void } | null>(null)
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [issue, setIssue] = useState<string | null>(null)
  async function run(change: NotebookChange, complete?: () => void): Promise<boolean> {
    if (running.current) return false
    if (held.current && notebookFingerprint(held.current.change) !== notebookFingerprint(change)) {
      setIssue('The previous change is unconfirmed. Retry it before changing this metadata again. Your Note is kept.')
      return false
    }
    const original = held.current ?? { operationId: crypto.randomUUID(), change, ...(complete ? { complete } : {}) }
    held.current = original
    running.current = true
    setBusy(true)
    setIssue(null)
    try {
      await changeNotebook(original.change, original.operationId)
      held.current = null
      original.complete?.()
      return true
    } catch (error) {
      setIssue(presentError(error))
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { run, busy, issue, pending: held.current, retry: () => held.current ? run(held.current.change) : Promise.resolve(false) }
}

export function NotebookOperationIssue({ operation }: { operation: ReturnType<typeof useNotebookOperation> }) {
  return operation.issue ? <div className="notebook-change-issue" role="status">{operation.issue}<button className="note-text-button" disabled={operation.busy} onClick={() => void operation.retry()}>Retry change</button></div> : null
}
