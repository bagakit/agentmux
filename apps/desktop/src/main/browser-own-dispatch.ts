import type { WebContents } from 'electron'

/**
 * Main's own receipt for trusted native input it sends into one page.
 *
 * Agent page actions use CDP `Input.*`, so the page sees `isTrusted === true` and Electron emits
 * `input-event` for them exactly as it does for a person. `isTrusted` therefore only separates
 * browser-generated input from page-forged events; it says nothing about who sent it. The fact
 * that does is Main's receipt: an `Input.*` command Main sent on this exact WebContents and has not
 * yet seen acknowledged. Electron emits `input-event` while it handles that command, so the
 * events of Main's own input are observed while the command is in flight, and nothing else is.
 *
 * Consumers that react to human input (feedback cleanup, document-used, native chrome forwarding,
 * demonstration capture, element selection) ask this module first. The registry is keyed by the
 * WebContents that received the dispatch, so an input shield or any other surface never inherits
 * the page's receipt.
 */

type OwnDispatch = { actions: number; throttled: boolean; inFlight: number; changes: number }

const dispatches = new WeakMap<WebContents, OwnDispatch>()

/** Native event families observed from this engine’s original Input command acknowledgements. */
const OWN_INPUT_TYPES = new Set(['mouseMove', 'mouseEnter', 'mouseLeave', 'mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'keyUp', 'char',
  'touchStart', 'touchMove', 'touchEnd', 'touchCancel', 'gestureTapDown', 'gestureShowPress', 'gestureTap', 'gestureTapCancel',
  'gestureScrollBegin', 'gestureScrollUpdate', 'gestureScrollEnd', 'gestureFlingStart', 'gestureFlingCancel',
  'gesturePinchBegin', 'gesturePinchUpdate', 'gesturePinchEnd'])

/** One Agent action's native input on one page. `end` must be called exactly once, in a finally. */
export type BrowserOwnDispatch = import('@agentmux/browser/page').BrowserNativeInput

/**
 * Begin one Agent action's native input on `contents`.
 *
 * A hidden WebContents does not process CDP input while background throttling is on: the command
 * waits for its acknowledgement timeout and the page never sees the event, so an acknowledged Agent
 * click would be a silent no-op. Only this page is woken, by lifting its throttling for the action.
 * When the last overlapping action on it ends, throttling is restored and the page returns to its
 * real visibility: restoring throttling alone leaves Chromium rendering a hidden page, while
 * releasing one `stayHidden` capture makes Chromium recompute it (hidden stays hidden, shown stays
 * shown). Concurrent actions in one program share that single wake.
 */
export function beginOwnDispatch(contents: WebContents): BrowserOwnDispatch {
  const state = dispatches.get(contents) ?? { actions: 0, throttled: false, inFlight: 0, changes: 0 }
  dispatches.set(contents, state)
  if (state.actions === 0 && !contents.isDestroyed()) {
    state.throttled = contents.getBackgroundThrottling()
    if (state.throttled) contents.setBackgroundThrottling(false)
  }
  state.actions += 1
  let open = true
  return {
    async input(command) {
      if (!open) throw new Error('This native input already ended. Nothing was sent.')
      state.inFlight += 1
      state.changes += 1
      try { return await command() } finally {
        state.inFlight -= 1
        state.changes += 1
      }
    },
    end() {
      if (!open) return
      open = false
      state.actions -= 1
      if (state.actions > 0 || !state.throttled) return
      state.throttled = false
      if (contents.isDestroyed()) return
      contents.setBackgroundThrottling(true)
      // Resource cleanup only: the action already has its receipt. A failed capture leaves this one
      // page rendering until it is next shown and hidden; it never fails or repeats the action.
      try { void contents.capturePage({ x: 0, y: 0, width: 1, height: 1 }, { stayHidden: true }).catch(() => {}) }
      catch { /* Same as above. */ }
    }
  }
}

/** True only while Main's own `Input.*` command is in flight on this exact WebContents and the input is one it sends. */
export function isOwnDispatch(contents: WebContents, input: { type: string }): boolean {
  return (dispatches.get(contents)?.inFlight ?? 0) > 0 && OWN_INPUT_TYPES.has(input.type)
}

/**
 * A mark for consumers whose answer arrives later from the page.
 *
 * Page-side listeners cannot ask Main per event. A consumer that waits for a person's input in the
 * page takes a mark when it starts and asks {@link ownDispatchSince} when the page answers.
 */
export function ownDispatchMark(contents: WebContents): number {
  return dispatches.get(contents)?.changes ?? 0
}

/** True when Main's own native input was in flight on this WebContents at any time since `mark`. */
export function ownDispatchSince(contents: WebContents, mark: number): boolean {
  const state = dispatches.get(contents)
  return state !== undefined && (state.changes !== mark || state.inFlight > 0)
}
