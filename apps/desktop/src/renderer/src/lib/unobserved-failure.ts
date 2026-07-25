import type { AppStore } from '../store'

// The renderer's last-resort net for failures nobody observed.
//
// Almost every action in this UI is fired from a JSX handler as `void action()` — there are dozens of
// such call sites, and more get added. Each one that forgets its own try/catch turns a real failure
// into "I clicked and nothing happened": no banner, no log, nothing the user can act on. That is the
// exact defect this net exists to stop, and one of them (a pasted image that failed to save) shipped.
//
// This is a NET, not a strategy. Every action still owes its own catch, because only the action knows
// what to say and what to preserve — a draft to keep, a selection to restore. What arrives here has
// already escaped that, so all this can honestly do is make sure it reaches the same error surface the
// rest of the app uses instead of vanishing into the console.
//
// Deliberately not an ErrorBoundary: a boundary catches render-phase throws and replaces the tree. An
// unobserved promise rejection is not a render fault and must not blank the workbench — the window is
// still usable, so the failure belongs in the banner, not in a crash screen.

export type UnobservedFailureHost = Pick<Window, 'addEventListener' | 'removeEventListener'>

/**
 * Route unobserved promise rejections to the store's single error surface.
 *
 * Returns its own disposer: the listener is owned by whoever installed it, so a test (or a future
 * teardown path) can remove it rather than leaking a global handler.
 */
export function installUnobservedFailureReporter(input: {
  host: UnobservedFailureHost
  reportError: AppStore['reportError']
}): () => void {
  const { host, reportError } = input

  const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    // preventDefault only silences the console's "Uncaught (in promise)" noise; it does not swallow the
    // failure, because the same failure is being handed to the error surface on the next line.
    event.preventDefault()
    reportError(unobservedFailure(event.reason))
  }

  host.addEventListener('unhandledrejection', onUnhandledRejection as EventListener)
  return () => host.removeEventListener('unhandledrejection', onUnhandledRejection as EventListener)
}

/**
 * Present an escaped rejection honestly.
 *
 * The message is marked as unexpected on purpose. A failure that reached this net had no handler, so
 * nobody chose these words for the user — saying so is more truthful than dressing it up as a
 * deliberate error message, and it makes the missing catch visible instead of hiding the gap.
 */
export function unobservedFailure(reason: unknown): Error {
  const detail = reason instanceof Error ? reason.message : String(reason)
  const error = new Error(
    detail.trim() === ''
      ? 'Something failed unexpectedly. No further detail was reported.'
      : `Something failed unexpectedly: ${detail}`
  )
  // Keep the original for anyone reading the console; the banner only ever shows the message.
  if (reason instanceof Error) error.cause = reason
  return error
}
