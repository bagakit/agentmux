import type { AgentProviderId } from '@agentmux/core'
import type { AppConfig, SessionSnapshot } from '../../../shared/contracts'
import { isNeedsYouState } from './attention-vocabulary'
import { attentionSortRank } from './attention-event'
import {
  activeWorkbenchSurface,
  titleWorkbenchSurface,
  workspaceForSession,
  type WorkbenchTab
} from './workbench-tabs'

// The quick switcher's data core. It fuses the window's open tabs and agent sessions into one ranked
// list a single keystroke can search, and — the AgentMux twist — floats sessions that need you above
// idle rows so the switcher doubles as an attention router. Everything here is pure: the component
// feeds it Store facts and renders the ordered targets, so the ranking is testable without a DOM.

// A row's activation verb. Both map onto Store verbs that already exist and are the only way to
// switch today: a tab jumps via activateTab, a session via selectSession.
export type QuickSwitchTarget =
  | { kind: 'tab'; tabId: string; workspaceId: string; tabGroupId: string }
  | { kind: 'session'; sessionId: string }

export type QuickSwitchKind = 'session' | 'tab'

export type QuickSwitchItem = {
  id: string
  kind: QuickSwitchKind
  // Primary line: what the user reads first. A session's own label, or a tab's title.
  title: string
  // Secondary line: workspace / branch / path context, one step quieter.
  subtitle: string
  // Only agent rows carry a provider so the row can lead with its mark; terminal + non-session rows
  // stay null and lead with a kind glyph the component picks.
  providerId: AgentProviderId | null
  // The session's live state, when this row is (or projects) an agent session. Drives the attention
  // lift and lets the row echo the shared StatusDot vocabulary. null for terminals and plain tabs.
  state: SessionSnapshot['status']['state'] | null
  // How long the state has been observed — the tiebreaker inside an attention class, so the row that
  // has waited longest ranks first, matching the status bar's "jump to the earliest" contract.
  observedAt: number
  target: QuickSwitchTarget
}

// Attention weight: needs-you rows lift highest, then errors, then working, then everything idle.
// Which states are needs-you is NOT decided here — `isNeedsYouState` is the one table, so this ordering
// cannot drift from the notification decision or the status bar's counts the way a local `case
// 'waiting': case 'blocked':` ladder silently would. And the ORDER itself is not decided here either:
// this classifies the state into a sort class and defers to `attentionSortRank`, the one table the
// roster sorts by too, so the two surfaces cannot disagree about who ranks above whom (they had, before
// — see attention-ordering.test.ts). A finished (`done`) row and an idle one tie there deliberately,
// pending #199.
function attentionRank(state: QuickSwitchItem['state']): number {
  if (state === null) return attentionSortRank('idle')
  if (isNeedsYouState(state)) return attentionSortRank('needs-you')
  if (state === 'error') return attentionSortRank('error')
  if (state === 'working') return attentionSortRank('working')
  return attentionSortRank(state === 'done' ? 'done' : 'idle')
}

// A conservative subsequence fuzzy match: every query char must appear in order in the haystack.
// Returns a score (higher is better) or null for no match. Scoring rewards contiguous runs and
// matches at word starts so "wb" ranks WorkspaceBoard above a scattered hit, without a heavyweight
// matcher — this is one input over a small window index, not a codebase-wide search.
export function fuzzyScore(query: string, haystack: string): number | null {
  if (query === '') return 0
  const needle = query.toLowerCase()
  const hay = haystack.toLowerCase()
  let score = 0
  let hayIndex = 0
  let previousMatch = -1
  for (let i = 0; i < needle.length; i += 1) {
    const char = needle[i]!
    const found = hay.indexOf(char, hayIndex)
    if (found === -1) return null
    // Contiguous with the previous matched char: a run, the strongest signal.
    if (found === previousMatch + 1) score += 8
    // At a word boundary (start, or after a separator): the next strongest.
    else if (found === 0 || /[\s/\-_:.]/u.test(hay[found - 1] ?? '')) score += 6
    else score += 1
    // Earlier matches beat later ones, gently, so a prefix hit edges out a deep one.
    score -= Math.min(found, 12) * 0.1
    previousMatch = found
    hayIndex = found + 1
  }
  return score
}

type RankedItem = QuickSwitchItem & { matchScore: number }

// The empty query keeps the natural fused order (sessions first, then tabs) but still applies the
// attention lift, so opening the switcher with no typing surfaces whoever needs you at the top.
// A non-empty query filters to matches, then orders by attention, then match quality, then recency.
export function rankQuickSwitchItems(
  items: readonly QuickSwitchItem[],
  query: string
): QuickSwitchItem[] {
  const trimmed = query.trim()
  const ranked: RankedItem[] = []
  for (const item of items) {
    // Match against the visible title AND subtitle so "main" finds a workspace-qualified tab.
    const titleScore = fuzzyScore(trimmed, item.title)
    const subtitleScore = trimmed === '' ? null : fuzzyScore(trimmed, item.subtitle)
    if (trimmed !== '' && titleScore === null && subtitleScore === null) continue
    const best = Math.max(titleScore ?? -Infinity, (subtitleScore ?? -Infinity) - 3)
    ranked.push({ ...item, matchScore: Number.isFinite(best) ? best : 0 })
  }
  ranked.sort((a, b) => {
    const attention = attentionRank(a.state) - attentionRank(b.state)
    if (attention !== 0) return attention
    // Inside an attention class, the earliest-observed row wins for the classes that mean "waiting",
    // matching the status bar; for idle rows observedAt is just a stable, deterministic tiebreak.
    if (a.matchScore !== b.matchScore) return b.matchScore - a.matchScore
    if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt
    return a.id.localeCompare(b.id)
  })
  return ranked.map(({ matchScore: _matchScore, ...item }) => item)
}

// Project the Store's tabs + sessions into the fused index. Session rows come first so a keystroke's
// empty state leads with live agents; each open tab that is NOT already an agent/terminal projection
// becomes its own row (files, browsers, launchers), because those have no session to route through.
export function buildQuickSwitchIndex(input: {
  config: AppConfig | null
  sessions: readonly SessionSnapshot[]
  tabs: Readonly<Record<string, WorkbenchTab>>
  tabGroupOf: (workspaceId: string, tabId: string) => string | null
}): QuickSwitchItem[] {
  const { config, sessions, tabs, tabGroupOf } = input
  const items: QuickSwitchItem[] = []

  for (const session of sessions) {
    const workspace = workspaceForSession(config, session)
    const branch = workspace?.branch
    const workspaceName = workspace?.name ?? session.workspacePath.split('/').at(-1) ?? session.workspacePath
    items.push({
      id: `session:${session.id}`,
      kind: 'session',
      title: session.label,
      subtitle: branch ? `${workspaceName} · ${branch}` : workspaceName,
      providerId: session.kind === 'agent' ? session.providerId : null,
      state: session.kind === 'agent' ? session.status.state : null,
      observedAt: session.status.observedAt,
      target: { kind: 'session', sessionId: session.id }
    })
  }

  // Tabs whose title surface is an agent/terminal session are already represented by the session row
  // above — selectSession activates that exact view — so only non-session tabs earn their own row.
  // A store that has not hydrated its workbench yet has no tabs at all; that is an empty index, not a
  // crash, and the switcher must survive being opened during startup.
  for (const tab of Object.values(tabs ?? {})) {
    const surface = titleWorkbenchSurface(tab)
    if (surface.kind === 'agent' || surface.kind === 'terminal') continue
    const tabGroupId = tabGroupOf(tab.workspaceId, tab.id)
    if (!tabGroupId) continue
    const workspace = config?.workspaces.find((candidate) => candidate.id === tab.workspaceId)
    items.push({
      id: `tab:${tab.id}`,
      kind: 'tab',
      title: quickSwitchTabTitle(tab),
      subtitle: workspace?.name ?? tab.workspaceId,
      providerId: null,
      state: null,
      observedAt: 0,
      target: { kind: 'tab', tabId: tab.id, workspaceId: tab.workspaceId, tabGroupId }
    })
  }

  return items
}

// The switcher's own title derivation for non-session tabs. It mirrors the tab strip's own labels
// (file basename, launcher = New Tab, browser title/url) so a row reads exactly like its tab.
export function quickSwitchTabTitle(tab: WorkbenchTab): string {
  const surface = titleWorkbenchSurface(tab)
  if (surface.kind === 'file') return surface.path.split('/').at(-1) ?? surface.path
  if (surface.kind === 'launcher') return 'New Tab'
  if (surface.kind === 'browser') {
    if (surface.title && surface.title !== 'about:blank') return surface.title
    return surface.url === 'about:blank' ? 'New Tab' : surface.url
  }
  const active = activeWorkbenchSurface(tab)
  return active.kind === 'file' ? (active.path.split('/').at(-1) ?? active.path) : tab.id
}
