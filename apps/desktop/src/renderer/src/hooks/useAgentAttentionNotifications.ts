import { useEffect } from 'react'
import { api } from '../lib/api'
import { createAttentionNotifier } from '../lib/attention-notifier'
import { visibleSessionIds } from '../lib/session-visibility'
import { visibleTabGroupsForState } from '../lib/visible-tab-groups'
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
      onUnsupported: (reason) => reportError(new Error(`Agent notifications are unavailable: ${reason}`))
    })

    // Seed from whatever is already projected, WITHOUT notifying: Agents that finished before this window
    // opened are not news, and announcing them would train the user to ignore the channel.
    notifier.seed(useAppStore.getState().sessions)

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
          visibleSessionIds: visibleSessionIds({
            tabs: state.tabs,
            // ONLY the rendered workspace's groups. The window mounts one WorkspaceWorkbench at a time
            // (App.tsx), while `layouts` accumulates a layout for every workspace ever visited — so
            // collecting them all marked background-workspace Agents as "on screen" and silently
            // suppressed exactly the completions this feature exists to announce. And on the Board no
            // Session Region is mounted at all, so nothing is visible there.
            tabGroups: visibleTabGroupsForState(state)
          })
        })
        // The reconcile itself must never become a silent failure: it is exactly the kind of
        // fire-and-forget path the renderer's net was added for, but a local catch says more.
        .catch((error: unknown) => reportError(error))
    }

    // Only Session identity/status changes can produce an attention event, so the subscription is scoped
    // to that slice rather than firing on every store write.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.sessions === previous.sessions) return
      reconcile()
    })

    return () => {
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
