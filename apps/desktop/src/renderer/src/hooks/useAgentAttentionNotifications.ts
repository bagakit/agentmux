import { mintObjectId } from '@agentmux/core/object-id'
import { presentError } from '@agentmux/client-ui/error-presentation'
import { useEffect } from 'react'
import {
  resolveNotificationModeId,
  resolveNotificationSound
} from '../../../shared/notification-presentation'
import { api } from '../lib/api'
import { createAttentionNotifier } from '../lib/attention-notifier'
import { notificationDeliveryNotice } from '../lib/notification-delivery-notice'
import { summarizeAgentAttention } from '../lib/agent-attention'
import { createVisibleSessionIdsSelector } from '../lib/session-visibility'
import { sessionPresentationById } from '../lib/session-presentation'
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
    let disposed = false
    let windowFocused = document.hasFocus()
    const visibleSessionIdsForState = createVisibleSessionIdsSelector()
    const notifier = createAttentionNotifier({
      snapshot: () => {
        const state = useAppStore.getState()
        return { sessions: state.sessions, windowFocused, visibleSessionIds: visibleSessionIdsForState(state),
          mode: resolveNotificationModeId(state.config), sound: resolveNotificationSound(state.config), timelines: state.timelines }
      },
      notify: async input => {
        const receipt = { requestId: mintObjectId(), subject: sessionPresentationById(useAppStore.getState().sessions).get(input.sessionId)!.control }
        const delivery = await api.ui.notifyAgentAttention(input).catch(error => ({ status: 'unknown' as const, reason: presentError(error) }))
        const notice = notificationDeliveryNotice(delivery, receipt)
        if (!disposed && notice) reportError(notice.message, notice.context)
        return delivery
      }
    })

    // Seed from whatever is already projected, WITHOUT notifying: Agents that finished before this window
    // opened are not news, and announcing them would train the user to ignore the channel.
    notifier.seed(useAppStore.getState().sessions)

    // The Store owns attention facts. These values only track the one native side effect, so repeated
    // status observations don't repeat IPC and a failed setter never masquerades as a delivered badge.
    let badgeCount: number | undefined
    let badgeFailureKey: string | undefined
    let publishingBadge = false
    const publishBadge = async (): Promise<void> => {
      if (disposed || publishingBadge) return
      const count = summarizeAgentAttention(useAppStore.getState().sessions).needsYou
      if (count === badgeCount) return
      publishingBadge = true
      try {
        // false explicitly means this platform has no Dock; it is handled without inventing delivery.
        await api.ui.setAgentAttentionCount(count)
        if (!disposed) { badgeCount = count; badgeFailureKey = undefined }
      } catch (error) {
        if (!disposed) {
          badgeFailureKey ??= mintObjectId()
          reportError(new Error(
            'Updating the Dock badge did not complete. Agent attention remains visible in this window; the next Agent status update will retry.',
            { cause: error }
          ), { kind: 'process-degraded', summary: 'Dock attention badge could not update',
            event: { source: 'desktop-notifications', key: `dock-badge-update:${badgeFailureKey}`, object: { kind: 'application', id: 'desktop' } } })
        }
      } finally {
        publishingBadge = false
      }
      // A status may change while IPC is pending. Read its existing owner, not a second pending queue.
      // Do not automatically repeat a failed same-value request: the next relevant update retries it.
      if (!disposed && summarizeAgentAttention(useAppStore.getState().sessions).needsYou !== count) void publishBadge()
    }
    void publishBadge()

    const onFocus = (): void => { windowFocused = true }
    const onBlur = (): void => { windowFocused = false }
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)

    const reconcile = (): void => {
      void notifier.reconcile().catch((error: unknown) => { if (!disposed) reportError(error) })
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
          ), { kind: 'agent-broken', subject: session.control, event: { source: 'agent-attention', key: 'run-crashed' } })
        }
      }
      void publishBadge()
      reconcile()
    })

    return () => {
      disposed = true
      notifier.dispose()
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
