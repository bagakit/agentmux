import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import {
  AGENT_DISPLAY_STATES,
  isNeedsYouState
} from '../src/renderer/src/lib/attention-vocabulary.js'
import {
  attentionAccentFor,
  categoryFor
} from '../src/renderer/src/lib/attention-event.js'
import { summarizeAgentAttention } from '../src/renderer/src/lib/agent-attention.js'
import { buildAgentRoster, rosterBadgeCount } from '../src/renderer/src/lib/agent-roster.js'
import {
  BOARD_COLUMN_DESCRIPTIONS,
  PROJECT_BOARD_COLUMNS,
  sessionBoardColumn
} from '../src/renderer/src/lib/project-board.js'
import { rankQuickSwitchItems, type QuickSwitchItem } from '../src/renderer/src/lib/quick-switch.js'

// "Does this Agent need a person" had five hand-written answers, and one of them had already drifted.
// `attention-vocabulary.ts` is now the single table; this file is what stops the five copies coming back.
//
// The layers are deliberately separate, because each fails on its own:
//
//   1. THE TABLE — every state's verdict, pinned against an anchor that does NOT come from the table
//      itself. Without the anchor, deleting a row would shrink `AGENT_DISPLAY_STATES`, every loop below
//      would iterate a smaller set, and the whole file would stay green while a state fell out of every
//      attention surface at once.
//   2. EQUIVALENCE — each consumer's verdict, asked through its own public function over all nine
//      states, must agree with the table. This is what a re-introduced local `state === 'waiting' ||
//      state === 'blocked'` fails: it is right for today's union and wrong the day a state is added, and
//      it is also what the *deliberately different* Board mapping is allowed to disagree with.
//   3. THE COLUMN COPY — the Board's needs-you column is a catch-all whose words are a claim about the
//      mapping. It said "Waiting or blocked" while the column also held `disconnected` and `error`, on
//      two surfaces at once. The states are derived from `sessionBoardColumn`, so the copy is checked
//      against what the mapping actually does rather than against a remembered pair.
//   4. THE WIRING — a consumer can be correct and still not be plugged in. Each call site is extracted
//      from its own source and interrogated separately: a shared assertion would let one revert alone.

// ---------------------------------------------------------------------------------------------------
// Layer 1: the table, anchored outside itself
// ---------------------------------------------------------------------------------------------------

// The union's members, parsed from Core's own declaration. This is the anchor: it is not derived from
// the verdict table, so a row deleted from the table (or a tenth state added in Core) is a failure here
// instead of a silently smaller set for every loop in this file to iterate.
function unionMembersFromCore(): string[] {
  const source = readFileSync(
    new URL('../../../packages/core/src/types.ts', import.meta.url),
    'utf8'
  )
  const declaration = source.indexOf('export type AgentDisplayState =')
  expect(declaration).toBeGreaterThan(-1)
  // Right bound matters: the union ends at the first blank line, and slicing to end-of-file would let
  // the next declaration's string literals join the set.
  const body = source.slice(declaration, source.indexOf('\n\n', declaration))
  return [...body.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!)
}

describe('the needs-you table is the only definition', () => {
  it('parses a live union from Core, so the anchor cannot go vacuously true', () => {
    const members = unionMembersFromCore()
    // Self-check for the parse itself: a regex that stopped matching would produce an empty anchor, and
    // an empty anchor compared against a non-empty list still fails — but it would fail for the wrong
    // reason and read as a vocabulary bug. This says the parse is live.
    expect(members.length).toBeGreaterThanOrEqual(5)
    expect(members).toContain('waiting')
    expect(members).toContain('blocked')
  })

  it('enumerates exactly the states Core declares', () => {
    expect([...AGENT_DISPLAY_STATES].sort()).toEqual(unionMembersFromCore().sort())
  })

  it('gives each state the verdict its docstring argues for', () => {
    // Written out per state rather than as two lists, so flipping one verdict names that one state.
    expect(isNeedsYouState('waiting')).toBe(true)
    expect(isNeedsYouState('blocked')).toBe(true)
    expect(isNeedsYouState('starting')).toBe(false)
    expect(isNeedsYouState('running')).toBe(false)
    expect(isNeedsYouState('working')).toBe(false)
    expect(isNeedsYouState('done')).toBe(false)
    expect(isNeedsYouState('exited')).toBe(false)
    // The two that a coarser surface DOES treat as needs-you, and that this vocabulary deliberately
    // does not: amber has to mean "you are the blocker" and nothing else.
    expect(isNeedsYouState('error')).toBe(false)
    expect(isNeedsYouState('disconnected')).toBe(false)
  })
})

// ---------------------------------------------------------------------------------------------------
// Layer 2: every consumer agrees with the table, across the whole union
// ---------------------------------------------------------------------------------------------------

const NEEDS_YOU_STATES = AGENT_DISPLAY_STATES.filter(isNeedsYouState)

function agentSession(id: string, state: AgentDisplayState): SessionSnapshot {
  return {
    id,
    kind: 'agent',
    providerId: 'codex',
    executorId: 'codex',
    capabilities: {
      terminal: true,
      timeline: 'streaming',
      permission: 'respond',
      providerResume: true,
      replyCorrelation: 'native-turn-id'
    },
    hostId: 'local',
    workspacePath: '/repo',
    label: `Agent ${id}`,
    createdAt: 1,
    updatedAt: 1,
    processState: 'running',
    status: { state, source: 'native-hook', observedAt: 1 },
    latestOutputBytes: 0,
    control: { kind: 'agent', hostId: 'local', agentSessionId: id, run: { runId: `run-${id}` } }
  } as unknown as SessionSnapshot
}

function quickSwitchItem(id: string, state: AgentDisplayState | null): QuickSwitchItem {
  return {
    id,
    kind: 'session',
    title: id,
    subtitle: '',
    providerId: null,
    state,
    observedAt: 1,
    target: { kind: 'session', sessionId: id }
  }
}

describe('every attention surface reads the same table', () => {
  it('has states on both sides of the question, so the loops below can actually discriminate', () => {
    // Without this, a table of all-false (or all-true) would satisfy every equivalence below by making
    // one branch unreachable.
    expect(NEEDS_YOU_STATES.length).toBeGreaterThan(0)
    expect(NEEDS_YOU_STATES.length).toBeLessThan(AGENT_DISPLAY_STATES.length)
  })

  it('categoryFor calls exactly the table states needs-you', () => {
    for (const state of AGENT_DISPLAY_STATES) {
      expect(categoryFor(state) === 'needs-you').toBe(isNeedsYouState(state))
    }
  })

  it('attentionAccentFor accents exactly the table states with needs-you', () => {
    for (const state of AGENT_DISPLAY_STATES) {
      expect(attentionAccentFor(state) === 'needs-you').toBe(isNeedsYouState(state))
    }
    // The accent is urgent-only: `done` is worth a notification but must not compete for the same ink.
    expect(attentionAccentFor('done')).toBeNull()
    expect(attentionAccentFor('error')).toBe('error')
  })

  it('the window rollup counts and jumps to exactly the table states', () => {
    for (const state of AGENT_DISPLAY_STATES) {
      const rollup = summarizeAgentAttention([agentSession('only', state)])
      expect(rollup.needsYou).toBe(isNeedsYouState(state) ? 1 : 0)
      // The count and the jump target were two separate hand-written copies; they must not be able to
      // disagree about a single Session.
      expect(rollup.needsYouSessionId).toBe(isNeedsYouState(state) ? 'only' : null)
    }
  })

  it('the roster badge counts needs-you plus error and nothing else', () => {
    for (const state of AGENT_DISPLAY_STATES) {
      const rows = buildAgentRoster({
        sessions: [agentSession('only', state)],
        providerCatalog: []
      })
      const urgent = isNeedsYouState(state) || state === 'error'
      expect(rosterBadgeCount(rows)).toBe(urgent ? 1 : 0)
    }
  })

  it('the quick switcher ranks exactly the table states above an error row', () => {
    for (const state of AGENT_DISPLAY_STATES) {
      // The baseline is `error`, not `running`: error also outranks a running Agent, so beating a
      // running row is true for two classes and cannot discriminate. Being above error is the top of
      // the ladder, and needs-you is the only class there.
      //
      // The ids make ties break toward the baseline (equal rank → equal observedAt → id order, and
      // 'a' < 'z'), so the candidate can only come first by having a strictly better rank.
      const ranked = rankQuickSwitchItems(
        [quickSwitchItem('a-error-baseline', 'error'), quickSwitchItem('z-candidate', state)],
        ''
      )
      expect(ranked[0]!.id === 'z-candidate').toBe(isNeedsYouState(state))
    }
  })
})

// ---------------------------------------------------------------------------------------------------
// Layer 3: the Board's needs-you copy names what the mapping actually puts there
// ---------------------------------------------------------------------------------------------------

// The user-facing word for each state, for checking prose. Kept total over the union at runtime (see the
// self-check below) rather than only in the type, because this package's tsconfig does not include
// `test/` — a missing key here would otherwise be `undefined` and silently skipped.
//
// `error` is deliberately worded as "failed": the copy is for users, and forcing it to say the internal
// state name would be a worse sentence. The map exists so the guard can accept that without accepting
// an omission.
const USER_WORD_FOR_STATE: Record<AgentDisplayState, string> = {
  starting: 'starting',
  running: 'running',
  disconnected: 'disconnected',
  working: 'working',
  waiting: 'waiting',
  blocked: 'blocked',
  done: 'completed',
  exited: 'exited',
  error: 'failed'
}

function statesInColumn(column: (typeof PROJECT_BOARD_COLUMNS)[number]): AgentDisplayState[] {
  return AGENT_DISPLAY_STATES.filter(
    (state) => sessionBoardColumn({ status: { state, source: 'native-hook', observedAt: 1 } }) === column
  )
}

describe('the Board column copy is a claim about the mapping', () => {
  it('has a word for every state, so no state can be skipped rather than checked', () => {
    expect(Object.keys(USER_WORD_FOR_STATE).sort()).toEqual([...AGENT_DISPLAY_STATES].sort())
  })

  it('describes every column', () => {
    expect(Object.keys(BOARD_COLUMN_DESCRIPTIONS).sort()).toEqual([...PROJECT_BOARD_COLUMNS].sort())
  })

  it('names every state the needs-you column actually holds', () => {
    const states = statesInColumn('needs-you')
    // Self-check: this column is the catch-all, and the assertion below is only meaningful while it
    // holds more than the pair someone would remember.
    expect(states.length).toBeGreaterThan(2)
    const copy = BOARD_COLUMN_DESCRIPTIONS['needs-you'].toLowerCase()
    for (const state of states) {
      expect(copy).toContain(USER_WORD_FOR_STATE[state])
    }
  })

  it('names nothing the needs-you column does not hold', () => {
    // The other direction, and it needs its own assertion: "every state in the column is named" is
    // satisfied by copy that names MORE than the column holds. Narrowing the mapping and leaving the
    // words alone is then silent — the Board would promise a heading for stalled runs while filing
    // them under Working. (Measured: moving `disconnected` to the working column left the check above
    // green.) Same class of lie as the one this whole layer exists for, pointing the other way.
    const held = new Set(statesInColumn('needs-you').map((state) => USER_WORD_FOR_STATE[state]))
    const copy = BOARD_COLUMN_DESCRIPTIONS['needs-you'].toLowerCase()
    for (const state of AGENT_DISPLAY_STATES) {
      const word = USER_WORD_FOR_STATE[state]
      if (held.has(word)) continue
      expect(copy, `needs-you copy names '${word}', which lands elsewhere`).not.toContain(word)
    }
  })

  it('keeps that copy an enumeration rather than a vague summary', () => {
    // The check above passes trivially for prose that names the states and also for prose that names
    // them inside a sentence that means something else. This is the other half: the catch-all column
    // must LIST, because "Needs attention" would satisfy nothing a user needs and would quietly make
    // the assertion above unfalsifiable by dropping every word at once.
    const copy = BOARD_COLUMN_DESCRIPTIONS['needs-you']
    expect(copy).toMatch(/,/)
    expect(copy.toLowerCase()).toContain(' or ')
  })
})

// ---------------------------------------------------------------------------------------------------
// Layer 4: each call site is really wired, interrogated one at a time
// ---------------------------------------------------------------------------------------------------

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

// The modules that answer "does this Agent need a person". Every one of them must ask the table.
const CONSUMER_MODULES = [
  '../src/renderer/src/lib/attention-event.ts',
  '../src/renderer/src/lib/agent-attention.ts',
  '../src/renderer/src/lib/quick-switch.ts'
]

// Every string literal that is CODE, via TypeScript's own parser. Comments and JSDoc are not visited,
// so prose may name a state (the modules' own docstrings do, and must be able to) while code may not.
function codeStringLiterals(source: string, label: string): string[] {
  const file = ts.createSourceFile(label, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node.text)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

// Everything a `<tag data-attention={...}>` is given, in one file. The criterion is applied to each
// extracted expression rather than to the file's text as a whole: "the good call appears somewhere"
// stays true when a second, hand-written site is added beside it.
function attentionAttributeExpressions(source: string): string[] {
  return [...source.matchAll(/data-attention=\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map((m) => m[1]!)
}

// The `description:` value of each entry in a named `const X: Record<...> = { ... }` table.
function descriptionExpressions(source: string, tableName: string): Record<string, string> {
  const declaration = source.indexOf(`const ${tableName}`)
  expect(declaration).toBeGreaterThan(-1)
  // Both bounds have to be the object literal's, not the declaration's. These tables carry a multi-line
  // inline type annotation whose own `}` closes before the entries begin — anchoring the left bound at
  // `const` and the right at the first `\n}` extracted the ANNOTATION and found zero entries, which is
  // the vacuous-loop failure this file warns about elsewhere. So: open at `= {`, close at the first
  // brace back in column zero.
  const open = source.indexOf('= {', declaration)
  expect(open).toBeGreaterThan(declaration)
  const end = source.indexOf('\n}', open)
  expect(end).toBeGreaterThan(open)
  const body = source.slice(open, end)
  const found: Record<string, string> = {}
  for (const match of body.matchAll(/^\s*'?([a-z-]+)'?:\s*\{([^}]*)\}/gm)) {
    const description = /description:\s*([^,}]+)/.exec(match[2]!)
    if (description) found[match[1]!] = description[1]!.trim()
  }
  return found
}

describe('each attention call site is wired to the shared vocabulary', () => {
  it('QuickSwitcher gives every data-attention the shared accent, not a local ternary', () => {
    const source = read('../src/renderer/src/components/QuickSwitcher.tsx')
    const expressions = attentionAttributeExpressions(source)
    // Self-check: an extractor that matched nothing would make the loop below vacuous, which is exactly
    // how this row lost its accent unnoticed in the first place — it had no test at all.
    expect(expressions.length).toBeGreaterThan(0)
    for (const expression of expressions) {
      expect(expression).toContain('attentionAccentFor(')
    }
    // And the name has to resolve to the shared module, not to something local with the same spelling.
    expect(source).toMatch(/import \{ attentionAccentFor \} from '\.\.\/lib\/attention-event'/)
  })

  it('the Board columns take their words from the mapping module', () => {
    const source = read('../src/renderer/src/components/WorkspaceBoard.tsx')
    const descriptions = descriptionExpressions(source, 'COLUMN_META')
    expect(Object.keys(descriptions).sort()).toEqual([...PROJECT_BOARD_COLUMNS].sort())
    for (const [column, expression] of Object.entries(descriptions)) {
      expect(expression, `${column} must read the shared description`).toContain(
        'BOARD_COLUMN_DESCRIPTIONS'
      )
    }
  })

  it('the Agents dock groups take the same words for the same two columns', () => {
    // Checked separately from the Board on purpose. These are two surfaces that were confidently wrong
    // in the same way, and one assertion covering both would let either revert alone.
    const source = read('../src/renderer/src/components/SurfaceToolDock.tsx')
    const descriptions = descriptionExpressions(source, 'AGENT_GROUP_META')
    // `recent` is the done column renamed for this surface and keeps its own words; every group that
    // IS a Board column by name must read the shared copy.
    const ownWords = ['recent']
    for (const key of ownWords) {
      // The exception carries its own premise: if this group is renamed or removed, the exemption
      // becomes dead and says so here rather than quietly widening.
      expect(Object.keys(descriptions)).toContain(key)
    }
    const shared = Object.keys(descriptions).filter((key) => !ownWords.includes(key))
    expect(shared.sort()).toEqual(['needs-you', 'working'])
    for (const key of shared) {
      expect(descriptions[key], `${key} must read the shared description`).toContain(
        'BOARD_COLUMN_DESCRIPTIONS'
      )
    }
  })

  it('no attention surface re-derives the predicate from state literals', () => {
    // The equivalence layer above cannot catch this one, and that is why this assertion exists: a
    // re-introduced `state === 'waiting' || state === 'blocked'` agrees with the table for today's
    // union, so every behavioural check passes. It is wrong only on the day a state is added — which
    // is exactly when nobody is looking at these five files. (Measured: that copy survived the whole
    // equivalence layer.)
    //
    // So the criterion is structural. A hand copy has to NAME the states it accepts, and a state's
    // name is the vocabulary itself — there is no other spelling of `'waiting'`. Forbidding those
    // names in a consumer's code therefore forbids the copy rather than one shape of it.
    //
    // Literals come from TypeScript's own parser, so a comment mentioning `'waiting'` (this file's
    // own docstrings do) is not code and is not a violation. Guessing comment boundaries by line is
    // its own family of blind spot.
    const forbidden = new Set<string>(NEEDS_YOU_STATES)
    expect(forbidden.size).toBeGreaterThan(0)

    for (const relative of CONSUMER_MODULES) {
      const source = read(relative)
      // Must still reach the verdict through the table.
      expect(source, relative).toMatch(
        /import \{ isNeedsYouState \} from '\.\/attention-vocabulary'/
      )
      const literals = codeStringLiterals(source, relative)
      // Self-check: an extractor returning nothing would make every consumer vacuously compliant.
      // Each of these files does contain code literals (module specifiers at minimum).
      expect(literals.length, `${relative} must yield code literals`).toBeGreaterThan(0)
      for (const literal of literals) {
        expect(
          forbidden.has(literal),
          `${relative} names the needs-you state '${literal}' in code; ask isNeedsYouState instead`
        ).toBe(false)
      }
    }
  })

  it('would catch a needs-you state named in a consumer, and only in code', () => {
    // The assertion above is a "this shape is absent" check, and those go quietly green when the
    // extractor drifts. This pins both directions on synthetic sources, so the guard is falsifiable
    // without waiting for a real regression.
    const needsYou = NEEDS_YOU_STATES[0]!
    const copy = `import { x } from './y'\nconst p = (s: string) => s === '${needsYou}'\n`
    expect(codeStringLiterals(copy, 'synthetic').filter((l) => l === needsYou)).toHaveLength(1)
    const comment = `import { x } from './y'\n// mentions '${needsYou}' in prose\n`
    expect(codeStringLiterals(comment, 'synthetic').filter((l) => l === needsYou)).toHaveLength(0)
  })
})
