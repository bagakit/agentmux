import { Notification } from 'electron'
import type { BrowserWindow } from 'electron'
import type { NotificationDelivery, NotificationModeId } from '../shared/contracts.js'
import { presentationForMode, resolveNotificationMode } from '../shared/notification-presentation.js'

export type NotificationRequest = {
  sessionId: string
  title: string
  body: string
  mode: NotificationModeId
  sound: boolean
}
export type { NotificationDelivery }
export type AgentNotifier = {
  notify(request: NotificationRequest): Promise<NotificationDelivery>
  dispose(): void
}

// Bounds this IPC observation, not OS delivery. A missing native event leaves the result unknown.
const DISPLAY_OBSERVATION_MS = 5_000
const unknown = (reason: string): NotificationDelivery => ({ status: 'unknown', reason })
const failure = (error: unknown): NotificationDelivery => ({ status: 'failed', reason: error instanceof Error ? error.message : String(error) })

/** Main owns native resources and window activation; qualification, content and Session navigation stay with the client. */
export function createAgentNotifier(input: {
  window: BrowserWindow
  onActivate: (sessionId: string) => void
  platform?: string
}): AgentNotifier {
  const platform = input.platform ?? process.platform
  const live = new Set<() => void>()
  let disposed = false

  return {
    async notify(request) {
      if (disposed || input.window.isDestroyed()) return unknown('The original notification window was closed before delivery.')
      if (!Notification.isSupported()) return { status: 'unsupported', reason: 'This system does not support notifications.' }
      const mode = resolveNotificationMode(request.mode)
      const presentation = presentationForMode(mode, platform)
      let notification: Notification
      try {
        notification = new Notification({ title: request.title, body: request.body, silent: !request.sound,
          timeoutType: mode.kind === 'until-acknowledged' && presentation === 'as-requested' ? 'never' : 'default' })
      } catch (error) { return failure(error) }

      return new Promise<NotificationDelivery>(resolve => {
        let settled = false, released = false, displayed = false
        let dwell: ReturnType<typeof setTimeout> | undefined
        const observation = setTimeout(() => settle(unknown('No native display confirmation arrived during this observation. The notification may still appear; it was not resent.')), DISPLAY_OBSERVATION_MS)
        const settle = (result: NotificationDelivery): void => {
          if (settled) return
          settled = true
          clearTimeout(observation)
          resolve(result)
        }
        const clearDwell = (): void => { if (dwell !== undefined) { clearTimeout(dwell); dwell = undefined } }
        const release = (): void => {
          if (released) return
          released = true
          clearDwell()
          settle(unknown('The native notification closed before display was confirmed.'))
          notification.off('show', onShow)
          notification.off('failed', onFailed)
          notification.off('click', onClick)
          notification.off('close', onClose)
          live.delete(close)
        }
        const close = (): void => {
          release()
          notification.close()
        }
        const onShow = (): void => {
          if (released || displayed) return
          displayed = true
          settle({ status: 'shown', presentation })
          // Start the user's dwell only once the native banner actually appears.
          if (mode.kind === 'dwell') dwell = setTimeout(close, mode.dwellMs)
        }
        const onFailed = (_event: unknown, error: string): void => {
          settle(failure(error || 'The system could not display this notification.'))
          release()
        }
        const onClick = (): void => {
          close()
          if (disposed || input.window.isDestroyed()) return
          if (input.window.isMinimized()) input.window.restore()
          input.window.focus()
          input.onActivate(request.sessionId)
        }
        const onClose = (details?: { reason?: string }): void => {
          clearDwell()
          // Windows can hide a banner while its original item remains clickable in Action Center.
          if (platform === 'win32' && details?.reason === 'timedOut') return
          release()
        }
        notification.on('show', onShow)
        notification.on('failed', onFailed)
        notification.on('click', onClick)
        notification.on('close', onClose)
        live.add(close)
        try { notification.show() } catch (error) { settle(failure(error)); close() }
      })
    },
    dispose() {
      disposed = true
      for (const close of [...live]) close()
    }
  }
}
