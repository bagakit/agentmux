import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
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
    for (const relative of ORDERING_CONSUMERS) {
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

// ---------------------------------------------------------------------------------------------------
// One ordinal table, repo-wide
// ---------------------------------------------------------------------------------------------------

// The check above interrogates a hand-written list of consumers, and a hand-written list exempts by
// omission: the two tables this feature deleted (row-attention.ts and fanout-group.ts, #435) were not on
// it, so both sat there agreeing with the shared table while nothing asked them to read it. Listing them
// would only move the blind spot to the next copy.
//
// So this scans the whole renderer instead, and the criterion is STRUCTURAL: outside the SSOT, no file
// may spell its own attention-class → number mapping. That is the one thing the behavioural checks above
// provably cannot catch — a fresh copy is correct for today's classes and reds nothing until the day it
// drifts, which is exactly how three copies accumulated.
//
// Known leaks, stated rather than implied: a `switch` returning numbers, a `Map`, computed keys, or a
// helper that returns ordinals from another module would all pass. The two spellings covered are the two
// that actually occurred (an object literal, and a ternary ladder over class names), and each is pinned
// on synthetic input below so a change to the extractor cannot quietly stop matching them.
const SORT_CLASSES: readonly string[] = ['needs-you', 'error', 'working', 'done', 'idle']

// The one file allowed to hold the mapping.
const ORDERING_SSOT = 'lib/attention-event.ts'

// The modules that route their ordering through it today. Used only by the per-consumer check above —
// the structural scan below derives its own scope and does not read this list.
const ORDERING_CONSUMERS = [
  '../src/renderer/src/lib/agent-roster.ts',
  '../src/renderer/src/lib/quick-switch.ts',
  '../src/renderer/src/lib/row-attention.ts',
  '../src/renderer/src/lib/fanout-group.ts'
]

function rendererSources(): string[] {
  const root = new URL('../src/renderer/src/', import.meta.url)
  const walk = (relative: string): string[] =>
    readdirSync(new URL(relative, root), { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? walk(`${relative}${entry.name}/`)
        : entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')
          ? [`${relative}${entry.name}`]
          : []
    )
  return walk('')
}

/**
 * Every place in one source that maps attention sort classes to numbers, via TypeScript's own parser.
 *
 * Using the parser rather than a regex is what keeps prose out: every module's docstring names the
 * classes and some quote the ordinals, and a text scan would report each of those as a copy.
 */
function attentionOrdinalTables(source: string, label: string): string[] {
  const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []

  const keyOf = (name: ts.PropertyName): string | null =>
    ts.isStringLiteralLike(name) || ts.isIdentifier(name) ? name.text : null

  const mentionsClass = (node: ts.Node): boolean => {
    if (ts.isStringLiteralLike(node) && SORT_CLASSES.includes(node.text)) return true
    return ts.forEachChild(node, mentionsClass) ?? false
  }

  // A ladder's branches are numbers, possibly through further ternaries: `a ? 0 : b ? 1 : 2`.
  const yieldsOnlyNumbers = (node: ts.Node): boolean => {
    if (ts.isNumericLiteral(node)) return true
    if (ts.isParenthesizedExpression(node)) return yieldsOnlyNumbers(node.expression)
    if (ts.isConditionalExpression(node)) {
      return yieldsOnlyNumbers(node.whenTrue) && yieldsOnlyNumbers(node.whenFalse)
    }
    return false
  }

  const visit = (node: ts.Node): void => {
    // Spelling 1: `{ 'needs-you': 0, error: 1 }` — two or more class keys, all numeric values.
    if (ts.isObjectLiteralExpression(node) && node.properties.length >= 2) {
      const entries = node.properties.map((property) =>
        ts.isPropertyAssignment(property)
          ? { key: keyOf(property.name), numeric: ts.isNumericLiteral(property.initializer) }
          : null
      )
      if (entries.every((entry) => entry?.key && SORT_CLASSES.includes(entry.key) && entry.numeric)) {
        found.push(node.getText())
      }
    }
    // Spelling 2: `state === 'needs-you' ? 0 : 1` — a ternary over class names yielding only numbers.
    if (
      ts.isConditionalExpression(node) &&
      mentionsClass(node.condition) &&
      yieldsOnlyNumbers(node.whenTrue) &&
      yieldsOnlyNumbers(node.whenFalse)
    ) {
      found.push(node.getText())
      // Report the OUTERMOST ladder only: `a ? 0 : b ? 1 : 2` is one table, and descending would count
      // its own tail a second time. Nothing can hide inside — a matched ladder's branches are numbers by
      // construction, so the only unvisited subtree is the condition, which cannot itself be a table.
      return
    }
    ts.forEachChild(node, visit)
  }

  ts.forEachChild(file, visit)
  return found
}

describe('the attention ordinals live in exactly one file', () => {
  it('recognises both spellings of a private table, and does not fire on ordinary code', () => {
    // Without this the scan below could pass by having quietly stopped matching anything — the shape
    // that makes a whole-repo guard look thorough while checking nothing.
    expect(attentionOrdinalTables("const r = { 'needs-you': 0, error: 1, done: 3 }", 'x.ts')).toHaveLength(1)
    expect(attentionOrdinalTables("const r = s === 'needs-you' ? 0 : s === 'error' ? 1 : 3", 'x.ts')).toHaveLength(1)
    // …and the near misses it must NOT claim: counts keyed on class names are not an ordering, and a
    // ternary over class names that yields something other than a rank is ordinary code.
    expect(attentionOrdinalTables("const counts = { 'needs-you': n, error: e }", 'x.ts')).toEqual([])
    expect(attentionOrdinalTables("const label = s === 'needs-you' ? 'Waiting' : 'Idle'", 'x.ts')).toEqual([])
    expect(attentionOrdinalTables('const sizes = { small: 0, large: 1 }', 'x.ts')).toEqual([])
  })

  it('finds the mapping in the SSOT and nowhere else', () => {
    const sources = rendererSources()
    // Self-check: a scan root pointing at the wrong directory would find nothing to complain about and
    // report success for a codebase full of copies.
    expect(sources).toContain(ORDERING_SSOT)
    expect(sources.length).toBeGreaterThan(50)

    const holders = sources
      .map((relative) => ({
        relative,
        tables: attentionOrdinalTables(read(`../src/renderer/src/${relative}`), relative)
      }))
      .filter(({ tables }) => tables.length > 0)

    // The SSOT must be one of them — if the shared table itself vanished, every other file passing this
    // scan would mean the ordering had no definition at all rather than exactly one.
    expect(holders.map(({ relative }) => relative)).toContain(ORDERING_SSOT)
    expect(
      holders.filter(({ relative }) => relative !== ORDERING_SSOT).map(({ relative, tables }) => `${relative}: ${tables.join(' | ')}`)
    ).toEqual([])
  })
})
