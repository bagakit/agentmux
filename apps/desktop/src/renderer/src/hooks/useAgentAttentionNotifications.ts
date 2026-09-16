import { useEffect } from 'react'
import {
  resolveNotificationModeId,
  resolveNotificationSound
} from '../../../shared/notification-presentation'
import { api } from '../lib/api'
import { createAttentionNotifier } from '../lib/attention-notifier'
import { summarizeAgentAttention } from '../lib/agent-attention'
import { visibleSessionIdsForState } from '../lib/session-visibility'
import { useAppStore } from '../store'

// Wires the attention decision to the OS.
//
// A hook because it has real lifetime: a subscription to Session changes, a window-focus listener, and a
// notification-click route. The decision, the sequencing, and the on-screen answer are all plain
// functions elsewhere and tested there; this only holds them together and cleans up after itself.

export function useAgentAttentionNotifications(): void {
  const reportError = useAppStore((state) => state.reportError)
  const selectSession = useAppStore((state) => state.selectSession)
  useEffect(() => {
    const notifier = createAttentionNotifier({
      notify: (input) => api.ui.notifyAgentAttention(input),
      // Surfaced through the same error seam as everything else, so a platform that will not notify says
      // so once instead of the feature silently doing nothing.
      onUnsupported: (reason) => reportError(new Error(`Agent notifications are unavailable: ${reason}`)),
      // A downgrade is not a failure — the banner showed — but the user asked for a persistent one and
      // did not get it, so tell them once through the same seam instead of quietly not honouring it.
      onDowngraded: () => reportError(new Error(
        'This platform cannot keep a notification open until dismissed; it was shown as a normal banner.'
      ))
    })

    // Seed from whatever is already projected, WITHOUT notifying: Agents that finished before this window
    // opened are not news, and announcing them would train the user to ignore the channel.
    notifier.seed(useAppStore.getState().sessions)

    // The Store owns attention facts. These values only track the one native side effect, so repeated
    // status observations don't repeat IPC and a failed setter never masquerades as a delivered badge.
    let disposed = false
    let badgeCount: number | undefined
    let publishingBadge = false
    const publishBadge = async (): Promise<void> => {
      if (disposed || publishingBadge) return
      const count = summarizeAgentAttention(useAppStore.getState().sessions).needsYou
      if (count === badgeCount) return
      publishingBadge = true
      try {
        // false explicitly means this platform has no Dock; it is handled without inventing delivery.
        await api.ui.setAgentAttentionCount(count)
        if (!disposed) badgeCount = count
      } catch (error) {
        if (!disposed) reportError(new Error(
          'Updating the Dock badge did not complete. Agent attention remains visible in this window; the next Agent status update will retry.',
          { cause: error }
        ))
      } finally {
        publishingBadge = false
      }
      // A status may change while IPC is pending. Read its existing owner, not a second pending queue.
      // Do not automatically repeat a failed same-value request: the next relevant update retries it.
      if (!disposed && summarizeAgentAttention(useAppStore.getState().sessions).needsYou !== count) void publishBadge()
    }
    void publishBadge()

    let windowFocused = document.hasFocus()
    const onFocus = (): void => { windowFocused = true }
    const onBlur = (): void => { windowFocused = false }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    const reconcile = (): void => {
      const state = useAppStore.getState()
      void notifier
        .reconcile({
          sessions: state.sessions,
          windowFocused,
          // The on-screen answer comes from ONE authority (surface-navigation-visibility, via
          // session-visibility), the same one the terminal cold-parking and memory-budget recyclers
          // read. It applies the active workspace, the workbench/board switch, AND the Scratch Topic
          // projection — so an Agent finishing behind another Topic is correctly seen as off screen and
          // its completion is announced, instead of being suppressed as "on screen" by a raw read of
          // `layouts[ws].groups` that never Topic-rewrites the stored active tab.
          visibleSessionIds: visibleSessionIdsForState(state),
          // The chosen dwell tier, defaulting when unset. `off` makes reconcile raise nothing while
          // still advancing its baseline.
          mode: resolveNotificationModeId(state.config),
          // Resolved here, next to the mode, from the same config projection: both are answers the
          // renderer owns, and sending the answer (not the config) keeps main from holding a second
          // default that could disagree with this one.
          sound: resolveNotificationSound(state.config),
          // The body's conversation summary comes from the Activity timelines already in the Store — no
          // second message record is kept for notifications.
          timelines: state.timelines
        })
        // The reconcile itself must never become a silent failure: it is exactly the kind of
        // fire-and-forget path the renderer's net was added for, but a local catch says more.
        .catch((error: unknown) => reportError(error))
    }

    // Only Session identity/status changes can produce an attention event, so the subscription is scoped
    // to that slice rather than firing on every store write.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.sessions === previous.sessions) return
      // Initial history is a baseline, not news. Thereafter the accepted Session projection is the
      // single fact owner, including membership replay and new members that crashed during launch.
      if (!state.loading && !previous.loading) {
        const previousSessions = new Map(previous.sessions.map((session) => [session.id, session]))
        for (const session of state.sessions) {
          if (session.kind !== 'agent' || session.processState !== 'exited' || session.status.exitReason !== 'crashed') continue
          const before = previousSessions.get(session.id)
          if (before?.kind === 'agent' && before.hostId === session.hostId
            && before.control.run.runId === session.control.run.runId
            && before.processState === 'exited' && before.status.exitReason === 'crashed') continue
          const facts = [session.status.detail, session.status.exitCode === undefined ? undefined : `exit code ${session.status.exitCode}`]
            .filter(Boolean).join(', ')
          reportError(new Error(
            `Agent "${session.label}" crashed${facts ? ` (${facts})` : ''}. Its Session and history are kept. Open the Session to review its available recovery actions.`
          ), { kind: 'agent-broken', subject: session.control })
        }
      }
      void publishBadge()
      reconcile()
    })

    return () => {
      disposed = true
      unsubscribe()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [reportError])

  // Clicking a notification focuses the window in main; where to go inside it is decided here, because
  // the renderer owns View and Region truth.
  useEffect(
    () => api.ui.onAgentAttentionActivate((sessionId) => void selectSession(sessionId)),
    [selectSession]
  )
}
