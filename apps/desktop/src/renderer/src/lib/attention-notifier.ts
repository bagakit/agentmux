import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { attentionEvents, nextAttentionStates, type AttentionEvent } from './attention-event'

// Turns attention decisions into native notifications.
//
// The decision itself lives in attention-event.ts and the on-screen answer in session-visibility.ts;
// this only sequences them and remembers what it already announced. It is a plain object rather than a
// hook so the sequencing — the part that can double-notify or go silent — is testable without a window.

export type NotifyDelivery = { status: 'shown' } | { status: 'unsupported'; reason: string }

export type AttentionNotifierPorts = {
  notify(input: { sessionId: string; title: string; body: string }): Promise<NotifyDelivery>
  // Reported once, the first time the platform refuses. Without this the user is told nothing at all and
  // silently loses a feature they enabled.
  onUnsupported?: (reason: string) => void
}

export type AttentionNotifier = {
  /**
   * Reconcile the latest Sessions against what was last announced, raising notifications for anything
   * newly worth attention. Returns the events it raised, for tests and for callers that want to log.
   */
  reconcile(input: {
    sessions: readonly SessionSnapshot[]
    windowFocused: boolean
    visibleSessionIds: ReadonlySet<string>
  }): Promise<AttentionEvent[]>
  /** Adopt the current states WITHOUT notifying — used to seed on first projection. */
  seed(sessions: readonly SessionSnapshot[]): void
  setEnabled(enabled: boolean): void
}

const TITLES: Record<AttentionEvent['category'], string> = {
  done: 'Agent finished',
  'needs-you': 'Agent needs you',
  error: 'Agent failed'
}

function bodyFor(event: AttentionEvent): string {
  if (event.category === 'needs-you') return `${event.label} is waiting for your answer.`
  if (event.category === 'error') return `${event.label} stopped with an error.`
  return `${event.label} finished its turn.`
}

export function createAttentionNotifier(ports: AttentionNotifierPorts): AttentionNotifier {
  let previousStates = new Map<string, AgentDisplayState>()
  let enabled = true
  // Reported once per notifier, not once per event: a platform that refuses will refuse every time, and
  // repeating it would turn one honest failure into a stream of noise.
  let unsupportedReported = false

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
      if (!enabled || events.length === 0) return []

      for (const event of events) {
        const delivery = await ports.notify({
          sessionId: event.sessionId,
          title: TITLES[event.category],
          body: bodyFor(event)
        })
        if (delivery.status === 'unsupported' && !unsupportedReported) {
          unsupportedReported = true
          // Explicit failure: the in-window dot and the Board still carry the fact, so the user keeps
          // the signal — they just learn the OS channel is unavailable instead of assuming it works.
          ports.onUnsupported?.(delivery.reason)
        }
      }
      return events
    },

    seed(sessions) {
      previousStates = nextAttentionStates(sessions)
    },

    setEnabled(next) {
      enabled = next
    }
  }
}
