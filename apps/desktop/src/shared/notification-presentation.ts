import type { AgentDisplayState, AgentTimelineItem } from '@agentmux/core'

// The single source of truth for what an attention notification says and how long it stays.
//
// Both sides read this one module: the renderer (settings slider + the notifier that builds the body)
// and Desktop main (which translates a mode into Electron Notification options and reports honestly
// when the platform cannot honour it). Living in `shared/` — next to contracts.ts — is what keeps the
// dwell tier table from being copied into a second place that would drift. It is deliberately node-free
// so the renderer bundle can import it: the platform decision takes the platform string as an argument
// rather than reading `process`.

/**
 * The dwell slider is ONE dimension: `off → several dwell durations → until-acknowledged`. Each stop is
 * a tier here; the settings control renders exactly these stops in order, and delivery resolves a stop
 * to the `mode` it carries. There is no second table.
 */
export type NotificationModeId = 'off' | 'brief' | 'standard' | 'patient' | 'until-acknowledged'

/**
 * What a resolved tier asks delivery to do. `off` never reaches main — the notifier drops it before the
 * IPC — so main only ever sees `dwell` or `until-acknowledged`.
 */
export type NotificationMode =
  | { kind: 'off' }
  // A banner that dismisses itself after `dwellMs`. Best-effort: main bounds it with a timer, the OS
  // still owns the floor/ceiling of how long a banner can live.
  | { kind: 'dwell'; dwellMs: number }
  // Ask the platform to keep the notification up until the user acts on it. Not universally honourable
  // (see presentationForMode) — the delivery result says whether it actually was.
  | { kind: 'until-acknowledged' }

export type NotificationTier = {
  id: NotificationModeId
  label: string
  description: string
  mode: NotificationMode
}

/**
 * The tier table. Order IS the slider order, left (off) to right (until-acknowledged). Add or retune a
 * stop here and both the settings control and delivery follow, because both derive from this array.
 */
export const NOTIFICATION_TIERS: readonly NotificationTier[] = [
  { id: 'off', label: 'Off', description: 'No system notifications.', mode: { kind: 'off' } },
  { id: 'brief', label: 'Brief', description: 'A quick banner (about 6 seconds).', mode: { kind: 'dwell', dwellMs: 6_000 } },
  { id: 'standard', label: 'Standard', description: 'Long enough to read the summary (about 12 seconds).', mode: { kind: 'dwell', dwellMs: 12_000 } },
  { id: 'patient', label: 'Patient', description: 'Stays a while if you are away (about 30 seconds).', mode: { kind: 'dwell', dwellMs: 30_000 } },
  { id: 'until-acknowledged', label: 'Until I dismiss it', description: 'Stays until you act on it, where the platform allows.', mode: { kind: 'until-acknowledged' } }
] as const

/**
 * The default stop when the user has never chosen one. Not `off` (the feature would appear broken) and
 * long enough to read a body that carries a conversation summary — `standard`, not `brief`.
 */
export const DEFAULT_NOTIFICATION_MODE_ID: NotificationModeId = 'standard'

export type NotificationSettings = {
  mode: NotificationModeId
}

export type NotificationPresentation = 'as-requested' | 'downgraded'

/**
 * The delivery result. `shown` distinguishes "presented in the mode you asked for" from "the platform
 * downgraded it to an ordinary transient banner", so a caller can be honest instead of assuming success.
 */
export type NotificationDelivery =
  | { status: 'shown'; presentation: NotificationPresentation }
  | { status: 'unsupported'; reason: string }

function tierFor(id: NotificationModeId | undefined): NotificationTier {
  return NOTIFICATION_TIERS.find((tier) => tier.id === id)
    ?? NOTIFICATION_TIERS.find((tier) => tier.id === DEFAULT_NOTIFICATION_MODE_ID)!
}

/** The active mode id for a config, defaulting when the field is absent or carries an unknown id. */
export function resolveNotificationModeId(
  config: { notifications?: NotificationSettings | undefined } | null | undefined
): NotificationModeId {
  return tierFor(config?.notifications?.mode).id
}

/** The delivery descriptor for a mode id, defaulting on an unknown id. */
export function resolveNotificationMode(id: NotificationModeId | undefined): NotificationMode {
  return tierFor(id).mode
}

/**
 * Whether a platform can keep a notification up until the user acts. Electron honours
 * `timeoutType: 'never'` on Windows and Linux; macOS ignores it (banner-vs-alert is a system
 * preference, not something the app sets), so persistence cannot be promised there.
 */
function platformHonorsPersistence(platform: string): boolean {
  return platform === 'win32' || platform === 'linux'
}

/**
 * What a platform will actually do with a requested mode. Only `until-acknowledged` can be downgraded,
 * and only on a platform that cannot pin a notification open; everything else is delivered as asked.
 */
export function presentationForMode(mode: NotificationMode, platform: string): NotificationPresentation {
  if (mode.kind === 'until-acknowledged' && !platformHonorsPersistence(platform)) return 'downgraded'
  return 'as-requested'
}

// A notification body is a glance, not a document: one line, no markdown, no code block. Newlines are
// collapsed so a fenced block cannot smuggle its own line breaks in, and the text is cut on a code-point
// boundary (Array.from, not slice) so a truncation never splits an emoji or surrogate pair.
const SUMMARY_MAX_CHARS = 120

function summarize(text: string | undefined): string | undefined {
  if (!text) return undefined
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  const points = Array.from(collapsed)
  if (points.length <= SUMMARY_MAX_CHARS) return collapsed
  return `${points.slice(0, SUMMARY_MAX_CHARS).join('')}…`
}

function statusLabel(state: AgentDisplayState): string {
  switch (state) {
    case 'starting': return 'Starting'
    case 'running': return 'Running'
    case 'disconnected': return 'Disconnected'
    case 'working': return 'Working'
    case 'waiting': return 'Waiting for you'
    case 'blocked': return 'Blocked'
    case 'done': return 'Finished'
    case 'exited': return 'Exited'
    case 'error': return 'Error'
    default: return 'Unknown'
  }
}

function latestContentOfKind(
  items: readonly AgentTimelineItem[],
  kind: AgentTimelineItem['kind']
): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.kind === kind && item.content) return item.content
  }
  return undefined
}

/**
 * Build the notification body from what already exists: the Session's name and status, plus the last
 * assistant reply and last user question read straight from the Activity timeline. No second message
 * store is consulted or kept — if a segment is not in the timeline it is omitted entirely rather than
 * filled with a "(none)" placeholder.
 */
export function composeAttentionBody(input: {
  label: string
  state: AgentDisplayState
  items?: readonly AgentTimelineItem[] | undefined
}): string {
  const lines: string[] = [`${input.label} — ${statusLabel(input.state)}`]
  const items = input.items ?? []
  const reply = summarize(latestContentOfKind(items, 'assistant_message'))
  if (reply) lines.push(`${input.label}: ${reply}`)
  const question = summarize(latestContentOfKind(items, 'user_message'))
  if (question) lines.push(`You: ${question}`)
  return lines.join('\n')
}
