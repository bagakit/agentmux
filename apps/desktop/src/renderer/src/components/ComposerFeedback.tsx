import { useEffect, useRef, useState } from 'react'
import { describeError, presentError } from '@agentmux/client-ui/error-presentation'
import { presentMessageDeliveryFailure } from '@agentmux/client-ui/message-delivery-presentation'
import { MessageDeliveryFailure } from '@agentmux/client-ui/components/MessageDeliveryFailure'
import { copyTextToClipboard } from '../lib/clipboard-copy'
import { messageDeliveryDiagnostics } from '../lib/message-delivery-diagnostics'

type Action = () => void | Promise<void>
type Failure = { generation: number; message: string; error: unknown; retry?: () => void }

/** Local user actions own their feedback; delivery/Runtime facts remain with their existing owners. */
export function useComposerFeedback(scope: string) {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const currentScope = useRef({ scope, generation: 0 })
  if (currentScope.current.scope !== scope) {
    currentScope.current = { scope, generation: currentScope.current.generation + 1 }
  }
  const generation = currentScope.current.generation
  const [failure, setFailure] = useState<Failure | null>(null)
  const isCurrent = () => mounted.current && currentScope.current.generation === generation
  function report(error: unknown, retry?: Action) {
    if (!isCurrent()) return
    const presented = presentError(error)
    setFailure({ generation, message: presentMessageDeliveryFailure({ error, context: 'tool' }).state || presented,
      error, ...(retry ? { retry: () => { void run(retry) } } : {}) })
  }
  async function run(action: Action): Promise<void> {
    setFailure(null)
    try { await action() } catch (error) { report(error, action) }
  }
  return { failure: failure?.generation === generation ? failure : null, isCurrent, report, run, dismiss: () => setFailure(null) }
}

export function ComposerFeedback({ failure, onDismiss }: { failure: Failure | null; onDismiss(): void }) {
  const logId = failure ? describeError(failure.error).logId : undefined
  const [log, setLog] = useState(() => logId ? messageDeliveryDiagnostics.get(logId) : undefined)
  useEffect(() => {
    const update = () => setLog(logId ? messageDeliveryDiagnostics.get(logId) : undefined)
    update()
    return messageDeliveryDiagnostics.subscribe(update)
  }, [logId])
  return failure ? <div className="composer-feedback"><MessageDeliveryFailure error={failure.error} context="tool"
    logId={logId} log={log?.record.logId === logId ? log : undefined} copyText={async text => {
      let issue: unknown
      const copied = await copyTextToClipboard(text, error => { issue = error })
      if (!copied) throw issue
      return copied
    }} onRetry={failure.retry} onDismiss={onDismiss} /></div> : null
}
