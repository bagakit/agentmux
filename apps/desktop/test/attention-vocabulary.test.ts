import { readFileSync, readdirSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import type { AgentDisplayState } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts.js'
import { allStyleRules } from './helpers/styles.js'
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
  '../src/renderer/src/lib/agent-attention.ts'
]

/**
 * Modules that must not hand-copy the vocabulary, but are no longer required to ask the table THEMSELVES.
 *
 * The two halves of this guard protect different things, and conflating them costs correctness. "Must not
 * name 'waiting' in code" forbids the hand copy — it applies to every module downstream of the decision,
 * forever. "Must import isNeedsYouState" pins HOW the verdict is reached — and it is satisfied just as
 * well, in fact more strongly, by delegating to a module that is itself on the list above.
 *
 * quick-switch.ts moved here when its ranking collapsed into `attentionSortClass` (attention-event.ts).
 * It no longer asks the predicate at all; it asks a function that does. Keeping the import requirement
 * would have forced a vestigial `import { isNeedsYouState }` that nothing calls — an unused binding this
 * repo's tsconfig does not flag (no `noUnusedLocals`), sitting in the file as evidence of a check that is
 * no longer true. A guard that has to be appeased with dead code has stopped describing the codebase.
 */
const NO_HAND_COPY_MODULES = [...CONSUMER_MODULES, '../src/renderer/src/lib/quick-switch.ts']

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

// Every expression a `data-attention` is COMPUTED from, in one file, via TypeScript's own parser.
//
// Two spellings reach the DOM and they look nothing alike: `data-attention={expr}` on the element, and
// `{...(cond ? { 'data-attention': expr } : {})}` spread in to omit the attribute entirely when there
// is nothing to say. A regex written for the first is silently blind to the second — measured, not
// assumed: the pattern this replaced matched 1 of the 2 forms, so half the call sites (the Project Rail
// row and group header, the Topic avatar) were exempt from every criterion in this file while the
// self-check "we extracted something" stayed green off the other half. Hence a real parser: the shapes
// are a property of the syntax, and enumerating spellings is how the next one gets missed.
//
// Literal values (`data-attention="working"`) are deliberately NOT returned. They are a different
// concept wearing the same attribute name — they label which class a segment is ABOUT and stay put when
// its count is zero — so folding them in here would force an exemption list, and an exemption list is
// where a dead attribute hides.
// 每个**计算出来的** `data-attention`，连同它所在那个元素的类名。
//
// 类名必须从同一个 JSX 元素上取，不能另列一张「组件 → 类名」的表。原来那里是一张手抄的两行 Map，
// 于是第三个发这个属性的组件（Topic 头像）不在里面——它发了属性、没有任何规则接，而这份文件里
// 每一条判据对它一概免检，同时"我们提取到了东西"的自检靠另外两行照旧全绿。这正是本文件反复
// 警告的那个形状：靠省略来豁免。改成派生之后，下一个发这个属性的组件自动入册。
function attentionEmissions(source: string): Array<{ attention: string; classNames: string[] }> {
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: Array<{ attention: string; classNames: string[] }> = []

  // 同一个元素上 className 里那些**完整的**字面量类名。
  //
  // 半截名字是这里唯一的陷阱：`status--${state}` 的字面量部分是 `status--`，把它当成一个类名放进
  // 下面那条可达性正则（`\.status--[^,{]*\[data-attention`）就会命中 `.status--working[data-attention]`
  // ——一个其实无人上色的属性借邻居的规则过了关。
  //
  // 所以判据不是"把 `${...}` 抹掉之后剩下什么"，而是每一段字面量的两端**在语法上**接的是什么：
  // 紧贴插值的那个词是半截的，只有与插值之间隔了空白的词才是完整类名。段的边界由 TS 自己给出，
  // 这里不引入哨兵字符——一个"类名里不可能出现的字符"是又一个要维护的假设，而本仓
  // reference-name-containment.test.ts 已经记过它最坏的形态：往源文件里塞 NUL 会让整个文件对
  // `git grep` 永久失明。
  const completeWords = (text: string, cutLeft: boolean, cutRight: boolean): string[] => {
    // split 在字符串两端的空白处留下空串——那正好证明"这一端与插值之间有空白"，即该端的词完整。
    const words = text.split(/\s+/u)
    if (cutLeft && words[0] !== '') words.shift()
    if (cutRight && words[words.length - 1] !== '') words.pop()
    return words.filter((word) => /^[a-z][a-z0-9_-]*$/iu.test(word))
  }
  const classNamesOf = (attributes: ts.JsxAttributes): string[] => {
    for (const attribute of attributes.properties) {
      if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== 'className') continue
      const initializer = attribute.initializer
      if (!initializer) return []
      const expression = ts.isJsxExpression(initializer) ? initializer.expression : initializer
      if (!expression) return []
      if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
        return completeWords(expression.text, false, false)
      }
      if (ts.isTemplateExpression(expression)) {
        const last = expression.templateSpans.length - 1
        return [
          ...completeWords(expression.head.text, false, true),
          ...expression.templateSpans.flatMap((span, index) =>
            completeWords(span.literal.text, true, index < last)
          )
        ]
      }
      // 不认识的写法（`clsx(...)` 之类）。返回空而不是靠 getText() 猜——空会让"没有字面量类名"
      // 那条断言响亮报红，而 getText() 会把实参名字混成类名，悄悄放宽判据。
      return []
    }
    return []
  }

  const visit = (node: ts.Node): void => {
    // <tag className=... data-attention={expr}>
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText() === 'data-attention' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      found.push({
        attention: node.initializer.expression.getText(),
        classNames: classNamesOf(node.parent)
      })
    }
    // <tag className=... {...(cond ? { 'data-attention': expr } : {})}>
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isStringLiteralLike(node.name) ? node.name.text : null
      if (key === 'data-attention') {
        // 往上走到这个 spread 所属的属性表——展开写法与直写写法落在同一个元素上，类名也就同源。
        let attributes: ts.JsxAttributes | null = null
        for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
          if (ts.isJsxAttributes(parent)) {
            attributes = parent
            break
          }
        }
        found.push({
          attention: node.initializer.getText(),
          classNames: attributes ? classNamesOf(attributes) : []
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
}

function attentionAttributeExpressions(source: string): string[] {
  const file = ts.createSourceFile('x.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const found: string[] = []
  const visit = (node: ts.Node): void => {
    // <tag data-attention={expr}>
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText() === 'data-attention' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      found.push(node.initializer.expression.getText())
    }
    // { 'data-attention': expr } inside a spread
    if (ts.isPropertyAssignment(node)) {
      const key = ts.isStringLiteralLike(node.name) ? node.name.text : null
      if (key === 'data-attention') found.push(node.initializer.getText())
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(file, visit)
  return found
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

  it('every dynamic data-attention has a stylesheet rule that could match it', () => {
    // The gap this closes: an emitter can hand the DOM an attribute no stylesheet ever reads. Nothing
    // errors, nothing looks unfinished in the source, and the state it was supposed to announce is
    // simply invisible. Four surfaces were in that position at once. Three of them turned out to be
    // redundant (their own `.status--<state>` dot already carried the signal, so the attribute was
    // deleted rather than given a rule), and one — the Topic avatar — was a real invisible state.
    //
    // So the criterion is REACHABILITY, not presence: for each component that emits a *computed*
    // data-attention, some rule somewhere must select that component's class together with
    // [data-attention]. A guard that only checked "the selector name appears in some file" would pass
    // on a stylesheet that mentions the class for unrelated reasons — that exact blind spot let the
    // fan-out lane's dead attribute live (see the CSS-guard note in the styles tests).
    //
    // Both halves of the input are DERIVED, and both used to be hand-copied lists that exempted by
    // omission:
    //
    //   - the emitters came from a two-row `Map<component, className>`, so the third emitter (the Topic
    //     avatar, #409) was exempt from every criterion here while the self-check stayed green off the
    //     other two rows. Now every component file is scanned and the class name is read off the SAME
    //     JSX element as the attribute, so a new emitter cannot be absent and cannot be paired with the
    //     wrong class.
    //   - the stylesheets came from a six-name list while the folder holds fifteen. A rule moved into an
    //     unlisted file would read as "no rule selects this" and red the wrong thing; a new surface
    //     styled only in an unlisted file would be invisible to the criterion. `allStyles()` derives the
    //     set from index.css's own @import order and throws if a stylesheet is not imported at all.
    // 剥掉注释的那一份：判据是"有没有这么一条规则"，而**这条规则的理由注释里逐字写着那个选择器**。
    // 实测过：把头像的类名整个改掉（界面上再没有规则接得住），24 条照旧全绿——命中的是散文。
    const styles = allStyleRules()
    const componentDir = new URL('../src/renderer/src/components/', import.meta.url)
    const components = readdirSync(componentDir).filter((name) => name.endsWith('.tsx'))
    // Self-check: an empty scan root would make every loop below vacuous. This is the shape that turned
    // a stylesheet guard green by pointing it at the wrong directory once already.
    expect(components.length).toBeGreaterThan(10)

    const emitters = components
      .map((component) => ({ component, emissions: attentionEmissions(read(`../src/renderer/src/components/${component}`)) }))
      .filter(({ emissions }) => emissions.length > 0)
    // Self-check: the extractor finding nothing anywhere would report success for a codebase that had
    // quietly stopped emitting the attribute altogether.
    expect(emitters.length).toBeGreaterThan(0)

    for (const { component, emissions } of emitters) {
      for (const { attention, classNames } of emissions) {
        // An emission on an element with no literal class name cannot be reached by any rule, so it is
        // a failure in its own right rather than something to skip.
        expect(classNames.length, `${component} emits data-attention (${attention}) on an element with no literal className`)
          .toBeGreaterThan(0)
        // The rule has to name one of THIS element's classes AND the attribute in one selector. Matching
        // them independently would accept a stylesheet that styles the class for layout and reads
        // [data-attention] on some unrelated element.
        // `\\b` 不够：类名以 `-` 收尾时它不是词边界，而更要紧的是 `.status` 会前缀命中
        // `.status--working[data-attention]`——一个共享的基类就此替这个元素借到了别人的规则（实测：
        // 头像的独有类名改掉后，同元素上的 `status` 让整条判据照旧通过）。所以要求类名后面紧跟的
        // 不是类名字符：选择器里合法的下一个字符只能是 `.#[:>+~,{` 或空白。
        const reachable = classNames.some((className) =>
          new RegExp(`\\.${className}(?![\\w-])[^,{]*\\[data-attention`, 'u').test(styles)
        )
        expect(
          reachable,
          `${component} emits data-attention (${attention}) on .${classNames.join('/.')} but no rule selects that pair`
        ).toBe(true)
      }
    }
  })

  it('the emission extractor reads the class off the same element, both spellings', () => {
    // The derivation above is only as good as this pairing: a extractor that returned the attribute but
    // lost the class would make every reachability check vacuous (zero classNames → the assertion above
    // reds, which is the safe direction), and one that picked up a NEIGHBOUR's class would let a dead
    // attribute pass by borrowing a styled sibling's name. Both spellings and the interpolated-class
    // shape are pinned on synthetic input.
    expect(attentionEmissions('const a = <b className="lane" data-attention={f(s)} />')).toEqual([
      { attention: 'f(s)', classNames: ['lane'] }
    ])
    expect(
      attentionEmissions("const a = <b className=\"row\" {...(x ? { 'data-attention': x.c } : {})} />")
    ).toEqual([{ attention: 'x.c', classNames: ['row'] }])
    // Template strings are the majority spelling here, and the half name is the whole reason this
    // extractor is not a regex. `status--${s}`'s literal part is `status--`; keeping it would make the
    // reachability regex below match `.status--working[data-attention]`, so an attribute that nothing
    // paints passes by borrowing a neighbouring state's rule. Only words separated from the
    // interpolation by whitespace are complete class names — the word touching it is dropped whole.
    expect(
      attentionEmissions('const a = <b className={`avatar status status--${s}`} data-attention={g(s)} />')
    ).toEqual([{ attention: 'g(s)', classNames: ['avatar', 'status'] }])
    // …and the same on the other side of an interpolation, plus a complete word between two of them.
    expect(
      attentionEmissions('const a = <b className={`a${x}b c ${y}d`} data-attention={g(s)} />')
    ).toEqual([{ attention: 'g(s)', classNames: ['c'] }])
    // A neighbouring element's class must not leak in.
    expect(
      attentionEmissions('const a = <b className="outer"><i className="inner" data-attention={h(s)} /></b>')
    ).toEqual([{ attention: 'h(s)', classNames: ['inner'] }])
    // Literals stay out: they are a different concept wearing the same attribute name.
    expect(attentionEmissions('const a = <b className="lane" data-attention="working" />')).toEqual([])
  })

  it('a computed data-attention on a class no rule selects is caught', () => {
    // The assertion above would go quietly green if the regex stopped matching anything, so pin both
    // directions on synthetic input. This is the shape that actually shipped: the class is styled, the
    // attribute is styled elsewhere, and the pair is styled nowhere.
    const styled = '.lane[data-attention="error"] { color: red; }'
    const decoy = '.lane { color: grey; }\n.other-thing[data-attention] { color: red; }'
    const pair = /\.lane[^,{]*\[data-attention/u
    expect(pair.test(styled)).toBe(true)
    expect(pair.test(decoy)).toBe(false)
  })

  it('the two surfaces whose dot already carries attention do not also emit the attribute', () => {
    // The fan-out lane and the roster row each render `.status--<state>` from a mapping that sends
    // needs-you to `waiting` and error to `error` — the shared vocabulary's amber and red, with amber
    // additionally carrying a `?` pip. Adding a second mark on the same element would be the same fact
    // twice, which is what the Project Rail's one-signal-per-row rule exists to prevent. This pins the
    // deletion so a future edit re-adding the attribute has to confront the reason it went away.
    for (const [component, mapper] of [
      ['FanOutStrip.tsx', 'laneState'],
      ['AgentRoster.tsx', 'stateFor']
    ] as const) {
      const source = read(`../src/renderer/src/components/${component}`)
      expect(
        attentionAttributeExpressions(source),
        `${component}'s dot already carries attention; a second mark would double it`
      ).toEqual([])
      // And the dot must still be derived from attention — otherwise the signal is gone entirely
      // rather than expressed once, which is the failure this deletion must not become. Two halves,
      // both required: the mapper feeds the row's attention into the shared tier decision, and the
      // rendered class is interpolated from that mapper's result rather than from a state read
      // straight off the session (which would drop needs-you back into invisibility).
      //
      // The needs-you -> `waiting` step itself is asserted where it now lives, in `statusDotTier`
      // (attention-event.test.ts). It used to be spelled out in BOTH of these components, and that
      // duplication was not harmless: both copies ended in `state === 'working' ? 'working' : null`,
      // so a live `running` Agent drew the resting grey dot while the count above it said working.
      // Matching the mapper's body for `'needs-you'` here would now be asserting that the copy came
      // back.
      expect(source).toMatch(new RegExp(`function ${mapper}[\\s\\S]*?statusDotTier\\(`, 'u'))
      expect(source).toMatch(new RegExp(`const state = ${mapper}\\(`, 'u'))
      expect(source).toContain('`status status--${state}`')
    }
  })

  it('the extractor sees both spellings, and ignores literals', () => {
    // The regex this replaced saw only the first of these. Pinning all three shapes on synthetic input
    // makes the blind spot falsifiable here rather than in a component six months from now.
    const direct = 'const a = <b data-attention={accentFor(s)} />'
    const spread = "const a = <b {...(x ? { 'data-attention': x.category } : {})} />"
    const literal = 'const a = <b data-attention="working" />'
    expect(attentionAttributeExpressions(direct)).toEqual(['accentFor(s)'])
    expect(attentionAttributeExpressions(spread)).toEqual(['x.category'])
    expect(attentionAttributeExpressions(literal)).toEqual([])
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
      // Must still reach the verdict through the table. 判据是「这个名字从那个模块进来了」，不是
      // 「这一行长这样」：同一条 import 上再带一个 `type NeedsYouState`，性质分毫未变，而按整行匹配
      // 的旧写法会当场红。红了之后最省事的修法是把判据改松——那会把这个文件关掉的每一条旁路重新
      // 打开。所以这里认那个安全拼法，而不是削弱断言。
      expect(source, relative).toMatch(
        /import \{[^}]*\bisNeedsYouState\b[^}]*\} from '\.\/attention-vocabulary'/
      )
    }

    // 手抄禁令的适用面比上面宽：既包括自己问表的模块，也包括把判定委托出去的模块。委托不是豁免——
    // 一个不再 import 谓词的模块，照样可以在自己文件里写一行 `state === 'waiting'`，那正是本断言要挡的。
    for (const relative of NO_HAND_COPY_MODULES) {
      const source = read(relative)
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
