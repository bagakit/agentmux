import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { attentionSortRank } from '../src/renderer/src/lib/attention-event.js'
import { buildAgentRoster } from '../src/renderer/src/lib/agent-roster.js'
import { rankQuickSwitchItems, type QuickSwitchItem } from '../src/renderer/src/lib/quick-switch.js'

// The roster and the quick switcher both sort Agent rows by attention, and they MUST agree about who
// ranks above whom. They were two hand-written rank tables before, and they had already drifted: the
// roster gave a finished (`done`) Agent rank 3 and an idle one rank 4 — sorting completion strictly
// above idleness — while the switcher tied them at 3. The comment on the roster's table promised "the
// same ranking the quick switcher and the attention bar use, so the three never disagree", which the
// code did not deliver (#435/#477).
//
// This file is what stops that coming back. attentionSortRank is now the ONE ordering both import. The
// load-bearing check is not two per-consumer snapshots — a snapshot each cannot catch them diverging —
// but a single assertion that the two consumers order the SAME shared set of states IDENTICALLY.

// One representative state per sort class, plus the done/idle boundary that actually drifted.
//
// observedAt is chosen to make that boundary discriminating: the idle row is observed EARLIER than the
// done row. With the classes tied (the correct behaviour, and the switcher's), the shared tiebreak —
// earliest-observed first — puts idle before done. If the roster's old table comes back (done rank 3 <
// idle rank 4), the class rank overrides that tiebreak and puts done first, so the roster's order
// diverges from the switcher's and this file reds. A done row observed LATER than idle is therefore the
// exact shape the old table gets wrong.
const SHARED_STATES: ReadonlyArray<{ id: string; state: AgentDisplayState; observedAt: number }> = [
  { id: 'needs-you', state: 'waiting', observedAt: 5 },
  { id: 'error', state: 'error', observedAt: 5 },
  { id: 'working', state: 'working', observedAt: 5 },
  { id: 'idle', state: 'disconnected', observedAt: 1 },
  { id: 'done', state: 'done', observedAt: 2 }
]

// needs-you, then error, then working, then {idle, done} tied and broken by earliest-observed. The idle
// row (observedAt 1) leads the done row (observedAt 2) precisely because the two classes tie.
const EXPECTED_ORDER = ['needs-you', 'error', 'working', 'idle', 'done']

function rosterAgent(spec: { id: string; state: AgentDisplayState; observedAt: number }): SessionSnapshot {
  return {
    id: spec.id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'complete-events',
      permission: 'observe',
      providerResume: true,
      replyCorrelation: 'none'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: `Agent ${spec.id}`,
    createdAt: 1,
    updatedAt: spec.observedAt,
    processState: 'running',
    status: { state: spec.state, source: 'native-hook', observedAt: spec.observedAt },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: spec.id, run: { runId: `run-${spec.id}` } }
  } as unknown as SessionSnapshot
}

function quickItem(spec: { id: string; state: AgentDisplayState; observedAt: number }): QuickSwitchItem {
  return {
    id: spec.id,
    kind: 'session',
    title: spec.id,
    subtitle: '',
    providerId: null,
    state: spec.state,
    observedAt: spec.observedAt,
    target: { kind: 'session', sessionId: spec.id }
  }
}

function rosterOrder(specs: typeof SHARED_STATES): string[] {
  return buildAgentRoster({ sessions: specs.map(rosterAgent), providerCatalog: [] }).map((row) => row.sessionId)
}

function quickOrder(specs: typeof SHARED_STATES): string[] {
  // Empty query keeps the fused order and applies only the attention lift, so nothing but the ranking
  // decides the sequence.
  return rankQuickSwitchItems(specs.map(quickItem), '').map((item) => item.id)
}

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('the roster and the quick switcher share one attention ordering', () => {
  it('orders the same shared set of states identically — the two cannot disagree', () => {
    // The whole point: assert the two consumers agree, not that each matches a remembered snapshot. A
    // snapshot per consumer would let both be individually "green" while ranking the same Agents in a
    // different order relative to each other.
    const roster = rosterOrder(SHARED_STATES)
    const quick = quickOrder(SHARED_STATES)
    expect(roster).toEqual(quick)
    // And anchor the shared result, so a future change that makes BOTH agree on a wrong order is caught
    // too rather than passing by mutual consent.
    expect(roster).toEqual(EXPECTED_ORDER)
  })

  it('is stable under input shuffling, so it is the ranking deciding the order and not input order', () => {
    const shuffled = [...SHARED_STATES].reverse()
    expect(rosterOrder(shuffled)).toEqual(EXPECTED_ORDER)
    expect(quickOrder(shuffled)).toEqual(EXPECTED_ORDER)
  })

  it('ties a finished Agent with an idle one, deliberately, pending an unread/seen axis (#199)', () => {
    // The decision this file settles: a finished-but-unlooked-at Agent is NOT ranked above an idle one,
    // because there is no unread/seen concept to justify it (that is #199). #246 records that ranking
    // `done` above idle is contrary to every reference product while no such axis exists. This is the
    // fact the old roster table got wrong; pin it on the SSOT itself so the tie is intentional, not
    // incidental.
    expect(attentionSortRank('done')).toBe(attentionSortRank('idle'))
    // …and the classes above it are strictly ordered, most urgent first.
    expect(attentionSortRank('needs-you')).toBeLessThan(attentionSortRank('error'))
    expect(attentionSortRank('error')).toBeLessThan(attentionSortRank('working'))
    expect(attentionSortRank('working')).toBeLessThan(attentionSortRank('done'))
  })

  it('has both consumers route their ORDER through the shared table, not a private one', () => {
    // The behavioural check above catches the roster's old table because it drifts the done/idle
    // boundary. It cannot catch a re-introduced table that happens to be behaviourally identical today
    // (the switcher's old literal ladder was) — the very thing that then drifts tomorrow. So also pin
    // the wiring: each consumer must import and CALL attentionSortRank rather than keep its own ordinals.
    for (const relative of [
      '../src/renderer/src/lib/agent-roster.ts',
      '../src/renderer/src/lib/quick-switch.ts'
    ]) {
      const source = read(relative)
      expect(source, `${relative} must import the shared ordering`).toMatch(
        /import \{[^}]*\battentionSortRank\b[^}]*\} from '\.\/attention-event'/
      )
      // A real call, not just an import: the ordinals must be READ from the shared table. Comments in
      // both files mention the name without the call parens, so this matches code, not prose.
      expect(source, `${relative} must call attentionSortRank, not spell its own ordinals`).toContain(
        'attentionSortRank('
      )
    }
  })
})
