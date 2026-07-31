import type { AgentCatalogEntry, LaunchOptionSelection, RiskTier } from '@agentmux/core'
import type { SessionSnapshot } from '../../../shared/contracts'
import { categoryFor, type AttentionCategory } from './attention-event'
import { agentUsageDisplay, type AgentUsageDisplay } from './agent-usage'

// An enumerable, window-wide roster of Agents.
//
// The attention bar can only jump to the ONE Session that has waited longest. That is the right answer
// to "who first", but it is the wrong shape for "show me everything running" — with several Agents in
// flight you had to walk panes to find the rest, and answering a pending request meant visiting each
// one. This is the list that was missing, and it is deliberately ONE surface: the pending requests are
// rows in it, not a second inbox that would then have to agree with it.
//
// Each row also carries what its Agent is ALLOWED to do. The launch posture is fixed at spawn and was
// already persisted, but nothing ever displayed it, so the user had to remember what they picked half
// an hour ago to know whether this Agent can write files unattended.

export type RosterScope = {
  // The Provider's own label for the option and the chosen value, e.g. "Sandbox" / "Danger full access".
  label: string
  value: string
  // The declared risk of the chosen value, reusing the shared RiskTier vocabulary so a roster row and an
  // approval card grade the same choice identically. Absent when the Provider declared no tier for this
  // choice: an undeclared risk is left undeclared rather than defaulted to 'safe', which would be a
  // claim nobody made.
  tier?: RiskTier
}

export type RosterRow = {
  sessionId: string
  label: string
  providerId: string
  workspacePath: string
  state: SessionSnapshot['status']['state']
  // The attention class this Agent falls in, or null when it wants nothing. Drives ordering and lets the
  // row reuse the shared status treatment.
  attention: AttentionCategory | null
  observedAt: number
  // True when Core is holding a typed request for this Agent — the rows that make this a work queue
  // rather than a status list.
  awaitingReply: boolean
  // 有多少条 Thread 还没被确认。与 awaitingReply 并列，因为它们回答的是同一个问题——
  // "这一行需要我做点什么吗"——所以它是这份名册的一列，不是另开的第二个收件箱。
  unacknowledgedThreads: number
  // What this Agent was authorized to do at spawn. Empty when the create declared nothing: absence
  // shows nothing at all, never a placeholder or an inferred default.
  scopes: RosterScope[]
  // 这个 Agent 最近一 turn 的真实 token 用量，或"此 Provider 不报用量"/"还没有一 turn"。三态都由
  // SessionSnapshot 自描述算出，绝不塌成 0（见 agent-usage.ts）。
  usage: AgentUsageDisplay
}

// needs-you first, then error, then working, then everything idle — the same ranking the quick switcher
// and the attention bar use, so the three never disagree about who is most urgent.
const ATTENTION_RANK: Record<AttentionCategory, number> = { 'needs-you': 0, error: 1, done: 3 }

function rank(row: RosterRow): number {
  if (row.attention) return ATTENTION_RANK[row.attention]
  return row.state === 'working' ? 2 : 4
}

/**
 * Resolve a persisted launch-option selection into displayable scopes.
 *
 * The selection is `{optionId: choiceId}` and carries no words of its own, so it is joined against the
 * Provider's catalog declaration — the same DESCRIBE half the launcher rendered from. A selection whose
 * option or choice the Provider no longer declares is DROPPED rather than shown raw: an id like
 * `bypass-all` rendered as a label would look like a verified fact while actually being unresolvable.
 */
export function resolveRosterScopes(
  selection: LaunchOptionSelection | undefined,
  catalogEntry: AgentCatalogEntry | undefined
): RosterScope[] {
  if (!selection || !catalogEntry) return []
  const scopes: RosterScope[] = []
  for (const option of catalogEntry.launchOptions ?? []) {
    const choiceId = selection[option.id]
    if (choiceId === undefined) continue
    const choice = option.choices.find((candidate) => candidate.id === choiceId)
    if (!choice) continue
    scopes.push({
      label: option.label,
      value: choice.label,
      ...(choice.tier ? { tier: choice.tier } : {})
    })
  }
  return scopes
}

/**
 * Build the roster from the Session projection the Store already holds.
 *
 * Reads nothing new: Sessions come from the same projection the bar and the dots use, and scopes come
 * from the Provider catalog the launcher already has. No Core contract, no message state machine.
 */
export function buildAgentRoster(input: {
  sessions: readonly SessionSnapshot[]
  providerCatalog: readonly AgentCatalogEntry[]
  /** 每个 Agent 名下未确认的 Thread 数。缺席读作 0——没有 Thread 不是缺数据。 */
  unacknowledgedThreads?: Readonly<Record<string, number>>
}): RosterRow[] {
  // A store that has not hydrated its catalog yet has none: that is an empty scope list, not a crash.
  // The roster must survive being opened during startup.
  const catalog = new Map((input.providerCatalog ?? []).map((entry) => [entry.id, entry]))
  const rows: RosterRow[] = []
  for (const session of input.sessions ?? []) {
    if (session.kind !== 'agent') continue
    rows.push({
      sessionId: session.id,
      label: session.label,
      providerId: session.providerId,
      workspacePath: session.workspacePath,
      state: session.status.state,
      attention: categoryFor(session.status.state),
      observedAt: session.status.observedAt,
      awaitingReply: session.pendingInteraction !== undefined,
      unacknowledgedThreads: input.unacknowledgedThreads?.[session.id] ?? 0,
      scopes: resolveRosterScopes(session.launchOptions, catalog.get(session.providerId)),
      usage: agentUsageDisplay(session)
    })
  }
  rows.sort((left, right) => {
    const byAttention = rank(left) - rank(right)
    if (byAttention !== 0) return byAttention
    // Inside a class the longest wait comes first, matching the bar's "jump to the earliest" contract.
    if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt
    return left.sessionId.localeCompare(right.sessionId)
  })
  return rows
}

/**
 * The count for the collapsed badge.
 *
 * Deliberately the same needs-you + error total the attention bar shows, so the badge and the bar are
 * one aggregate seen at two sizes rather than two numbers a user has to reconcile.
 */
export function rosterBadgeCount(rows: readonly RosterRow[]): number {
  return rows.filter((row) => row.attention === 'needs-you' || row.attention === 'error').length
}

/**
 * The highest tier among a row's scopes, for a single restrained risk mark on the row.
 *
 * A row shows one mark, so it must be the most permissive thing this Agent was granted — that is the
 * fact worth surfacing when scanning a list.
 */
export function rowRiskTier(row: RosterRow): RiskTier | null {
  const order: RiskTier[] = ['danger', 'caution', 'safe']
  for (const tier of order) {
    if (row.scopes.some((scope) => scope.tier === tier)) return tier
  }
  return null
}
