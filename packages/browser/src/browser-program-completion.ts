import type { BrowserOperationJournal } from './browser-operation-journal.js'
import type { BrowserOperation } from './model/browser-operation.js'

export function appendBrowserWarning(current: string | undefined, warning: string): string {
  return current && (`\n${current}\n`).includes(`\n${warning}\n`) ? current : [current, warning].filter(Boolean).join('\n')
}

/** Each step releases its own resource. A failure must leave the next release and receipt reachable. */
export async function finishBrowserProgramStep(
  operation: BrowserOperation | null,
  step: string,
  release: () => void | string | null | Promise<void | string | null>
): Promise<void> {
  let warning: string | null | void
  try { warning = await release() }
  catch { warning = `Browser ${step} could not be confirmed. Inspect the original Browser and operation before repeating an action.` }
  if (warning && operation) operation.warning = appendBrowserWarning(operation.warning, warning)
}

export async function finishBrowserProgramReceipt(journal: BrowserOperationJournal, operation: BrowserOperation): Promise<void> {
  const phase = operation.phase
  const finalPhase = phase === 'completed' || phase === 'failed' || phase === 'stopped' ? phase : 'indeterminate'
  await finishBrowserProgramStep(operation, 'operation history write', async () => {
    const finished = await journal.finish(operation.id, finalPhase, {
      summary: operation.summary,
      ...(operation.warning ? { warning: operation.warning } : {})
    })
    return journal.getPersistenceWarning() ?? (finished ? undefined : 'The original Browser operation history could not be confirmed. Inspect its original operation ID before repeating an action.')
  })
}
