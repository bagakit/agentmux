import type { AgentCatalogEntry, LaunchOptionSelection } from '@agentmux/core'
// RISK_TIERS is the risk-ladder SSOT, imported as a runtime VALUE. It lives on the node-free
// `@agentmux/core/risk-tier` subpath precisely so the renderer can rank by it without pulling Core's
// process/filesystem runtime into the render process (the root barrel `@agentmux/core` would).
import { RISK_TIERS, type RiskTier } from '@agentmux/core/risk-tier'
import type { SessionSnapshot } from '../../../shared/contracts'
import { attentionSortRank, categoryFor, isUrgentAttention, type AttentionCategory } from './attention-event'
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
  //
  // 这是「这一行需要我做点什么吗」的**唯一**答案。曾经并列过一个 `unacknowledgedThreads: number`，
  // 注释写着「与 awaitingReply 并列，因为它们回答的是同一个问题」——而 Core 里根本没有 Thread 实体
  // （`acknowledged` 只出现在 prompt 提交与字节确认两处，都不是消息线程），唯一调用点也从不传它，
  // 于是每行恒为 0，界面上那枚 "N msg" 徽标与它的 aria 文案是死代码。它的两条测试自己造入参来证明
  // 「传进去就带出来」——合成的 fixture 等于自证，恒绿。删掉它而不是给它找个生产者：同一个问题有
  // 两列，就必然有一天两列答得不一样。见 roster-single-pending-axis.test.ts 的检测器。
  awaitingReply: boolean
  // What this Agent was authorized to do at spawn. Empty when the create declared nothing: absence
  // shows nothing at all, never a placeholder or an inferred default.
  scopes: RosterScope[]
  // 这个 Agent 最近一 turn 的真实 token 用量，或"此 Provider 不报用量"/"还没有一 turn"。三态都由
  // SessionSnapshot 自描述算出，绝不塌成 0（见 agent-usage.ts）。
  usage: AgentUsageDisplay
}

// needs-you first, then error, then working, then everything idle — the ONE ordering the quick switcher
// also sorts by (see attentionSortRank in attention-event.ts), so the two can never disagree about who
// is most urgent. `done` and idle share a rank there deliberately, pending #199's unread/seen axis.
function rank(row: RosterRow): number {
  if (row.attention) return attentionSortRank(row.attention)
  return attentionSortRank(row.state === 'working' ? 'working' : 'idle')
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
 * How many rows are urgent — the count a collapsed-roster badge WOULD show.
 *
 * There is NO such badge. Nothing in production calls this: `AgentRoster` renders its collapsed count
 * from the `total` prop, and `WorkspaceSidebar` computes its own badge inline. This function's only
 * callers are its tests. It reads {@link isUrgentAttention} so that IF a badge is ever built it grades
 * urgency the same way the row accent does — but until that product decision lands, this is an unwired
 * aggregate, not delivered wiring. It is kept (rather than deleted) pending that decision; the
 * lib-export-reachability guard records it as a deliberate test-only export for exactly this reason.
 * Do not let this docstring, or the one on {@link isUrgentAttention}, read as if the badge exists.
 */
export function rosterBadgeCount(rows: readonly RosterRow[]): number {
  return rows.filter((row) => isUrgentAttention(row.attention)).length
}

/**
 * The highest tier among a row's scopes, for a single restrained risk mark on the row.
 *
 * A row shows one mark, so it must be the most permissive thing this Agent was granted — that is the
 * fact worth surfacing when scanning a list.
 *
 * "Highest" is defined by the SSOT tuple: {@link RISK_TIERS} is ordered ascending danger, so a tier's
 * INDEX is its danger rank and the most dangerous scope is the one with the greatest index. Deriving the
 * rank from the tuple (rather than hand-copying a reversed `['danger','caution','safe']` ladder) means
 * adding a member to `RISK_TIERS`, or reordering it, moves this ranking with it — there is no second copy
 * of the order to fall out of step.
 */
export function rowRiskTier(row: RosterRow): RiskTier | null {
  let highest: RiskTier | null = null
  let highestRank = -1
  for (const scope of row.scopes) {
    if (scope.tier === undefined) continue
    const rank = RISK_TIERS.indexOf(scope.tier)
    if (rank > highestRank) {
      highestRank = rank
      highest = scope.tier
    }
  }
  return highest
}
