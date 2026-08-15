import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import type { NotificationDelivery, NotificationModeId } from '../shared/contracts.js'
import { presentationForMode, resolveNotificationMode } from '../shared/notification-presentation.js'

// Desktop main owns native notifications, because only main can reach the OS and the renderer is
// sandboxed. The renderer decides WHETHER something deserves attention (see the renderer's
// attention-event decision) and WHICH dwell mode the user picked; this module only delivers, and
// reports honestly when it cannot present in the requested mode.
//
// The delivery result matters: a caller must be able to tell "shown as requested" from "the platform
// downgraded a persistent request to an ordinary banner" from "this platform will not show it at all".
// Returning void would let the app believe it had told the user something it never did.

export type NotificationRequest = {
  // The Session this is about; handed back on click so the caller can route to it without a second map.
  sessionId: string
  title: string
  body: string
  // The dwell tier the user chose. `off` never reaches here — the renderer drops it before the IPC.
  mode: NotificationModeId
  /**
   * Whether to ask the OS to play its notification sound.
   *
   * Spelled positively even though Electron's option is the negative `silent`, and the inversion is
   * done once, at the `new Notification` call below. A boolean that means the opposite of its name on
   * one side of an IPC is the shape that eventually ships backwards; naming it for what the user asked
   * for ("play a sound") keeps every layer above this one reading the same direction.
   *
   * Required, not optional. Its predecessor was an OPTIONAL negative field with a default of "stay
   * silent" applied right here — and in the whole codebase NOTHING ever passed it. A capability
   * declared on a request type, honoured by delivery, and reachable by no caller is a promise with no
   * way to keep it. Making this one required means the compiler asks the question at every call site
   * instead of letting one silently inherit a default nobody chose.
   * (notification-sound-reachable.test.ts bans the old optional spelling from coming back.)
   */
  sound: boolean
}

export type { NotificationDelivery }

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
 *
 * `platform` is injected (defaulting to the real host) so the downgrade decision is testable without a
 * real OS — the same reason the presentation policy takes a platform string.
 */
export function createAgentNotifier(input: {
  window: BrowserWindow
  onActivate: (sessionId: string) => void
  platform?: string
}): AgentNotifier {
  const platform = input.platform ?? process.platform
  // Every live notification, so dispose can detach their listeners rather than leaving them to be
  // collected whenever. A notification outlives the call that created it — it sits in the OS centre —
  // so its click handler must not point at a torn-down window.
  const live = new Set<Notification>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let disposed = false

  return {
    notify(request) {
      if (disposed) return { status: 'unsupported', reason: 'The notifier was disposed.' }
      // Electron reports platform support at runtime; on a system where the user disabled notifications
      // for this app, this is how we learn we cannot speak.
      if (!Notification.isSupported()) {
        return { status: 'unsupported', reason: 'This system does not support notifications.' }
      }

      const mode = resolveNotificationMode(request.mode)
      const presentation = presentationForMode(mode, platform)

      const notification = new Notification({
        title: request.title,
        body: request.body,
        // The one place the positive `sound` becomes Electron's negative `silent`. Everything above
        // this line — settings, config, IPC — says "play a sound"; only the platform call says not.
        silent: !request.sound,
        // Ask the platform to pin it open only when the mode wants persistence AND the platform can
        // honour it; otherwise a default (self-dismissing) banner. macOS ignores this entirely, which
        // is exactly why `presentation` above reports the downgrade rather than pretending it stuck.
        timeoutType: mode.kind === 'until-acknowledged' && presentation === 'as-requested'
          ? 'never'
          : 'default'
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

      // A dwell mode asks for a bounded banner. The OS owns the real floor, but where it lets us we
      // close it after the chosen dwell so "brief" and "patient" are actually different.
      if (mode.kind === 'dwell') {
        const timer = setTimeout(() => {
          timers.delete(timer)
          if (!disposed && !input.window.isDestroyed()) notification.close()
        }, mode.dwellMs)
        timers.add(timer)
      }

      return { status: 'shown', presentation }
    },

    dispose() {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      for (const notification of live) {
        notification.removeAllListeners()
        // Close what is still on screen: a click after teardown would reach a window that is gone.
        notification.close()
      }
      live.clear()
    }
  }
}
