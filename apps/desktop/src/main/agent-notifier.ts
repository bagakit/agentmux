import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'

// Desktop main owns native notifications, because only main can reach the OS and the renderer is
// sandboxed. The renderer decides WHETHER something deserves attention (see the renderer's
// attention-event decision); this module only delivers, and reports honestly when it cannot.
//
// The delivery result matters: a caller must be able to tell "shown" from "this platform will not show
// it". Returning void would let the app believe it had told the user something it never did.

export type NotificationRequest = {
  // The Session this is about; handed back on click so the caller can route to it without a second map.
  sessionId: string
  title: string
  body: string
  // Attention notifications are informational, not alarms — no sound. The user asked for a heads-up,
  // not an interruption they have to silence.
  silent?: boolean
}

export type NotificationDelivery =
  | { status: 'shown' }
  // The OS or the user's system settings will not show it. Explicit, so the caller can fall back to the
  // in-window signal instead of assuming delivery.
  | { status: 'unsupported'; reason: string }

export type AgentNotifier = {
  notify(request: NotificationRequest): NotificationDelivery
  dispose(): void
}

/**
 * Create the window's notifier.
 *
 * `onActivate` is invoked with the Session id when the user clicks a notification. Focusing the window
 * is done here because that is a main-side capability; WHERE to go inside the window stays with the
 * renderer, which owns the View and Region truth.
 */
export function createAgentNotifier(input: {
  window: BrowserWindow
  onActivate: (sessionId: string) => void
}): AgentNotifier {
  // Every live notification, so dispose can detach their listeners rather than leaving them to be
  // collected whenever. A notification outlives the call that created it — it sits in the OS centre —
  // so its click handler must not point at a torn-down window.
  const live = new Set<Notification>()
  let disposed = false

  return {
    notify(request) {
      if (disposed) return { status: 'unsupported', reason: 'The notifier was disposed.' }
      // Electron reports platform support at runtime; on a system where the user disabled notifications
      // for this app, this is how we learn we cannot speak.
      if (!Notification.isSupported()) {
        return { status: 'unsupported', reason: 'This system does not support notifications.' }
      }

      const notification = new Notification({
        title: request.title,
        body: request.body,
        silent: request.silent ?? true
      })

      const onClick = (): void => {
        if (disposed || input.window.isDestroyed()) return
        // Restore first: a minimised window cannot take focus, so clicking would appear to do nothing.
        if (input.window.isMinimized()) input.window.restore()
        input.window.focus()
        input.onActivate(request.sessionId)
      }
      const onClose = (): void => {
        notification.off('click', onClick)
        live.delete(notification)
      }

      notification.on('click', onClick)
      notification.once('close', onClose)
      live.add(notification)
      notification.show()
      return { status: 'shown' }
    },

    dispose() {
      disposed = true
      for (const notification of live) {
        notification.removeAllListeners()
        // Close what is still on screen: a click after teardown would reach a window that is gone.
        notification.close()
      }
      live.clear()
    }
  }
}
