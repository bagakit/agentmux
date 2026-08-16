import { useRef, useState } from 'react'
import { presentError } from '../lib/error-presentation'

type Action = () => void | Promise<void>
type Failure = { generation: number; message: string; retry?: () => void }

/** Local user actions own their feedback; delivery/Runtime facts remain with their existing owners. */
export function useComposerFeedback(scope: string) {
  const currentScope = useRef({ scope, generation: 0 })
  if (currentScope.current.scope !== scope) {
    currentScope.current = { scope, generation: currentScope.current.generation + 1 }
  }
  const generation = currentScope.current.generation
  const [failure, setFailure] = useState<Failure | null>(null)
  function report(error: unknown, retry?: Action) {
    if (currentScope.current.generation !== generation) return
    setFailure({ generation, message: presentError(error), ...(retry ? { retry: () => { void run(retry) } } : {}) })
  }
  async function run(action: Action): Promise<void> {
    setFailure(null)
    try { await action() } catch (error) { report(error, action) }
  }
  return { failure: failure?.generation === generation ? failure : null, report, run, dismiss: () => setFailure(null) }
}

export function ComposerFeedback({ failure, onDismiss }: { failure: Failure | null; onDismiss(): void }) {
  return failure ? <div className="composer-feedback" role="alert">
    <span>{failure.message}</span>
    {failure.retry ? <button type="button" onClick={failure.retry}>Retry</button> : null}
    <button type="button" onClick={onDismiss} aria-label="Dismiss message tool error">Dismiss</button>
  </div> : null
}
