import type { AgentDisplayState, AgentTimelineSnapshot } from '@agentmux/core'
import type {
  AgentAttentionNotifyInput,
  NotificationDelivery,
  NotificationModeId,
  SessionSnapshot
} from '../../../shared/contracts'
import { composeAttentionBody } from '../../../shared/notification-presentation'
import { attentionEvents, nextAttentionStates, type AttentionEvent } from './attention-event'

// Turns attention decisions into native notifications.
//
// The decision itself lives in attention-event.ts, the body wording in notification-presentation.ts,
// and the on-screen answer in session-visibility.ts; this only sequences them and remembers what it
// already announced. It is a plain object rather than a hook so the sequencing — the part that can
// double-notify or go silent — is testable without a window.

export type AttentionNotifierPorts = {
  notify(input: AgentAttentionNotifyInput): Promise<NotificationDelivery>
  // Reported once, the first time the platform refuses. Without this the user is told nothing at all and
  // silently loses a feature they enabled.
  onUnsupported?: (reason: string) => void
  // Reported once, the first time the platform DOWNGRADES the requested mode (e.g. "until I dismiss it"
  // on macOS, which cannot pin a banner open). Distinct from unsupported: the notification did show, it
  // just did not stay the way the user asked — so we tell them once instead of pretending it stuck.
  onDowngraded?: (mode: NotificationModeId) => void
}

export type AttentionReconcileInput = {
  sessions: readonly SessionSnapshot[]
  windowFocused: boolean
  visibleSessionIds: ReadonlySet<string>
  // The dwell tier the user chose. `off` means raise nothing at all (baseline still advances below).
  mode: NotificationModeId
  // Whether the user asked for a sound. Resolved from config by the caller — the notifier is handed the
  // answer rather than the config, for the same reason it is handed `mode`: this object sequences a
  // decision, it does not make one.
  sound: boolean
  // Activity timelines by Session id, read to compose the body. Absent entries simply yield a body with
  // no conversation summary — no second message store is kept for notifications.
  timelines: Readonly<Record<string, AgentTimelineSnapshot>>
}

export type AttentionNotifier = {
  /**
   * Reconcile the latest Sessions against what was last announced, raising notifications for anything
   * newly worth attention. Returns the events it raised, for tests and for callers that want to log.
   */
  reconcile(input: AttentionReconcileInput): Promise<AttentionEvent[]>
  /** Adopt the current states WITHOUT notifying — used to seed on first projection. */
  seed(sessions: readonly SessionSnapshot[]): void
}

const TITLES: Record<AttentionEvent['category'], string> = {
  done: 'Agent finished',
  'needs-you': 'Agent needs you',
  error: 'Agent failed'
}

// The AgentDisplayState carried into the notification body, kept beside the label so the body can name
// both the Agent and its current state. The event is always derived from a Session in the same batch,
// so the lookup succeeds; the category-shaped fallback only guards the impossible missing case and stays
// a valid state word rather than inventing one.
const CATEGORY_FALLBACK_STATE: Record<AttentionEvent['category'], AgentDisplayState> = {
  done: 'done',
  'needs-you': 'waiting',
  error: 'error'
}

function stateFor(event: AttentionEvent, sessions: readonly SessionSnapshot[]): AgentDisplayState {
  const session = sessions.find((candidate) => candidate.id === event.sessionId)
  return session?.status.state ?? CATEGORY_FALLBACK_STATE[event.category]
}

export function createAttentionNotifier(ports: AttentionNotifierPorts): AttentionNotifier {
  let previousStates = new Map<string, AgentDisplayState>()
  // Reported once per notifier, not once per event: a platform that refuses (or downgrades) will do so
  // every time, and repeating it would turn one honest fact into a stream of noise.
  let unsupportedReported = false
  let downgradeReported = false

  return {
    async reconcile(input) {
      const events = attentionEvents({
        sessions: input.sessions,
        previousStates,
        visibilityFor: (sessionId) => ({
          windowFocused: input.windowFocused,
          sessionVisible: input.visibleSessionIds.has(sessionId)
        })
      })
      // Advance the baseline even when notifications are off, so turning them back on does not replay a
      // backlog of transitions that happened while the user was not listening.
      previousStates = nextAttentionStates(input.sessions)
      // The `off` tier raises nothing. It still advanced the baseline above — reopening does not replay.
      if (input.mode === 'off' || events.length === 0) return []

      for (const event of events) {
        const delivery = await ports.notify({
          sessionId: event.sessionId,
          title: TITLES[event.category],
          body: composeAttentionBody({
            label: event.label,
            state: stateFor(event, input.sessions),
            items: input.timelines[event.sessionId]?.items
          }),
          mode: input.mode,
          sound: input.sound
        })
        if (delivery.status === 'unsupported') {
          if (!unsupportedReported) {
            unsupportedReported = true
            // Explicit failure: the in-window dot and the Board still carry the fact, so the user keeps
            // the signal — they just learn the OS channel is unavailable instead of assuming it works.
            ports.onUnsupported?.(delivery.reason)
          }
          continue
        }
        if (delivery.presentation === 'downgraded' && !downgradeReported) {
          downgradeReported = true
          ports.onDowngraded?.(input.mode)
        }
      }
      return events
    },

    seed(sessions) {
      previousStates = nextAttentionStates(sessions)
    }
  }
}
