import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

// SidebarToggleChrome pulls in the store → api.ts, which reads the vite define `__AGENTMUX_WEB_PREVIEW__`
// at module load. Stub it before those imports evaluate (same handling as the other component tests) so
// the suite LOADS — a suite that fails to load prints `Test Files 1 failed` while `Tests` shows nothing.
vi.hoisted(() => {
  vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true)
})

import { SidebarToggleChrome } from '../src/renderer/src/components/TopRowChrome.js'
import {
  openShortcutHelp,
  shortcutHelpKeydownInit,
  SHORTCUT_HELP_BINDING_ID
} from '../src/renderer/src/lib/shortcut-help-affordance.js'
import {
  bindingById,
  chordForPlatform,
  chordMatches,
  matchShortcut,
  type ShortcutEvent
} from '../src/renderer/src/lib/shortcut-registry.js'
import { assertSingleCallReachable, readAndParse } from './helpers/effect-reachability.js'

// The visible cheat-sheet door — the fix for the bootstrap deadlock where the app's ONLY shortcut-
// discovery surface (ShortcutsCheatSheet) could be opened only by a shortcut that is itself on the sheet.
//
// What this guards, and why each piece is separate (this repo's bar is mutation-based, and the traps are
// specific): the button (1) renders, (2) is actually OPERABLE, (3) its click actually DOES the thing —
// not merely "is wired" — and (4) the chord it presses is derived from the registry, not hand-typed.
// Those are orthogonal properties, so they live in separate families of `it()`; two assertions in one
// `it()` mask each other (whichever throws first makes the rest dead code — this repo's
// two-throws-in-one-it lesson).
//
// The desktop package has NO DOM test environment: renderToStaticMarkup runs no effects and dispatches
// no events, and there is no window. So the behavioural half cannot click a rendered button — it drives
// the pure `openShortcutHelp` against a stub EventTarget and inspects the event it dispatches. The
// render half proves the button is on screen and calls that function; the reachability half proves the
// handler body is not empty. Together they close the gap either half leaves open.
//
// ─── The four gaps a review of the shipping commit MEASURED, and what closed each ───
//
// Every claim below is a real run against this file. The four mutations all SURVIVED the original guard
// at `Tests 10 passed (10)` with `tsc --noEmit` exit 0 — i.e. neither the tests nor the compiler saw them.
//
//   G1 `disabled` on the button. The affordance renders, the handler is present and reachable, and the
//      user cannot click it: a completely dead door, which is the ONE thing this whole feature exists to
//      remove. Closed by `assertOperableButton`, which reads the anchor element's own attributes. Note
//      the criterion CANNOT be "the markup contains no `disabled`" — the sibling ToolsToggle legitimately
//      renders `disabled=""` in this same fragment (measured), so a markup-wide check is either vacuous
//      or a false red. It has to be scoped to the anchored element.
//   G2 `false && openShortcutHelp(...)` as the handler body. `assertSingleCallReachable` declares this
//      blind spot itself (it only sees `return`/`throw` before the call, not an unreachable call), but
//      that assertion is the SOLE killer of the emptied-handler mutation — so its blind spot left the
//      component wiring effectively unguarded. Closed by `assertHandlerCallIsTheWholeBody`, which
//      requires the handler body to BE that call, with no operator wrapped around it.
//   G3 `key: isMac ? '/' : '?'` — hand-copying BOTH platform keys, not one. The old message claimed the
//      #367 drift class "cannot exist here by construction"; that was too strong, and this file now says
//      so. The behavioural asserts compare against `chordForPlatform`, so a copy that is correct TODAY
//      agrees with them. Closed by `assertDerivedFromChord`: the emitted `key` must be an expression that
//      READS the resolved chord, not a literal that happens to match it.
//   G4 `<button>` → `<span>`. Loses the implicit button role, keyboard activation, and focusability while
//      the label and the marker attribute stay put. Closed by the tag assertion inside
//      `assertOperableButton`.
//
// What this file still does NOT see, stated so nobody reads more into it: nothing here proves the button
// is MOUNTED on a real screen. `SidebarToggleChrome` has three call sites (TopRowChrome's own
// TopRowLeadingChrome, SurfaceToolDock, WorkspaceSidebar — counted, not assumed), and the reachability
// claim in the component's comment rests on all three; this file renders the fragment directly and
// asserts nothing about those three. Deleting any one of them stays green here.

const TOP_ROW_CHROME = fileURLToPath(
  new URL('../src/renderer/src/components/TopRowChrome.tsx', import.meta.url)
)

const AFFORDANCE_LIB = fileURLToPath(
  new URL('../src/renderer/src/lib/shortcut-help-affordance.ts', import.meta.url)
)

/** The bare marker attribute that anchors every structural assertion to the one help button. */
const HELP_ANCHOR_ATTRIBUTE = 'data-shortcut-help-open'

/**
 * The JSX element carrying `HELP_ANCHOR_ATTRIBUTE` — the anchor every structural criterion hangs off.
 *
 * Asserts there is exactly one. Zero means the anchor was renamed or the button deleted and every
 * criterion below would otherwise be vacuous; more than one means the anchor no longer identifies a
 * single element, so "the help button's tag" stops being a well-defined thing.
 */
function helpButtonElement(): ts.JsxOpeningLikeElement {
  const { sourceFile } = readAndParse(TOP_ROW_CHROME)
  const found: ts.JsxOpeningLikeElement[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const carries = node.attributes.properties.some(
        (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === HELP_ANCHOR_ATTRIBUTE
      )
      if (carries) found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  expect(
    found,
    `TopRowChrome 里带 ${HELP_ANCHOR_ATTRIBUTE} 的元素应恰为 1 个，实测 ${found.length} 个` +
      `（0 个说明锚点被改名或按钮被删，本文件其余结构判据会随之全部变空转）`
  ).toHaveLength(1)
  return found[0]!
}

/** A stub dispatch surface: records every dispatched event without a DOM. */
function captureTarget(): { events: FakeKeyEvent[]; dispatchEvent: (event: FakeKeyEvent) => boolean } {
  const events: FakeKeyEvent[] = []
  return {
    events,
    dispatchEvent(event: FakeKeyEvent) {
      events.push(event)
      return true
    }
  }
}

// node has no KeyboardEvent global and no window (this package runs no DOM env), so the test injects a
// plain-object event factory. The object carries exactly the fields the registry matcher reads, so we can
// run chordMatches / matchShortcut against the very thing the button dispatched.
type FakeKeyEvent = { type: string } & ShortcutEvent

function fakeCreateEvent(type: string, init: KeyboardEventInit): FakeKeyEvent {
  return {
    type,
    key: init.key ?? '',
    metaKey: Boolean(init.metaKey),
    ctrlKey: Boolean(init.ctrlKey),
    shiftKey: Boolean(init.shiftKey),
    altKey: Boolean(init.altKey)
  }
}

/** Drive openShortcutHelp with both seams stubbed; return the events it dispatched. */
function pressHelp(isMac: boolean): FakeKeyEvent[] {
  const target = captureTarget()
  openShortcutHelp(isMac, { target, createEvent: fakeCreateEvent })
  return target.events
}

describe('cheat-sheet visible affordance — it renders', () => {
  // MUTATION 1 target: delete the button's rendering and this goes red.
  //
  // Count occurrences rather than `toContain(...)`: a presence assertion is vacuous when the shape can
  // appear more than once, and this repo counts per file rather than asking "does it appear". Exactly one
  // button, exactly one accessible label.
  it('SidebarToggleChrome renders exactly one keyboard-shortcuts button with an accessible label', () => {
    const markup = renderToStaticMarkup(createElement(SidebarToggleChrome))
    // The static render anchor (a bare marker attribute, like data-project-rail-toggle beside it).
    expect(markup.split('data-shortcut-help-open').length - 1, 'button rendered ≠ once').toBe(1)
    expect(markup.split('aria-label="Keyboard shortcuts"').length - 1, 'accessible label ≠ once').toBe(1)
  })
})

describe('cheat-sheet visible affordance — and it is actually operable', () => {
  // Rendering is not the property that matters; being CLICKABLE is. These two mutations both leave the
  // button on screen, with its label, its marker attribute, and a present + reachable handler — and both
  // make the door dead. Measured on the shipping guard: each SURVIVED at `Tests 10 passed (10)` with
  // `tsc --noEmit` exit 0.
  //
  //   G1 add `disabled` to the <button>  → nothing happens on click, forever.
  //   G4 change `<button>` to `<span>`   → no implicit button role, no Enter/Space activation, not in the
  //                                        tab order. Worst for exactly the keyboard-first user this
  //                                        affordance was built for.
  //
  // Why the criterion is anchored to the element and not to the markup: `SidebarToggleChrome` legitimately
  // renders a `disabled` sibling — ToolsToggle carries `disabled=""` in this very fragment (measured in
  // the rendered output). So "the markup contains no `disabled`" would be a false red today, and scoping
  // it to "…outside the help button" is the kind of exception list this repo has been burned by. Reading
  // the anchored element's own attributes needs no exception at all.

  it('the help affordance is a real <button>, not a non-interactive element', () => {
    const element = helpButtonElement()
    // A bare tag-name assertion: `span`/`div` lose the implicit role, keyboard activation and focusability
    // that make this reachable without a pointer.
    expect(
      element.tagName.getText(),
      '快捷键清单入口必须是 <button>：换成 span/div 会丢掉隐式 role、Enter/Space 激活与可聚焦性，' +
        '而 aria-label 与锚点属性照旧在场（本仓实测该变异在旧守卫下 10 条全绿）'
    ).toBe('button')
  })

  it('the help affordance is never disabled', () => {
    const element = helpButtonElement()
    const disabled = element.attributes.properties.filter(
      (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === 'disabled'
    )
    // No condition is acceptable here, not even a "sometimes" one: this button's whole job is to be the
    // one door a user who knows no shortcuts can always open. `disabled={false}` would pass a
    // truthiness-style check while inviting the next author to make it conditional, so the criterion is
    // "the attribute is absent", full stop.
    expect(
      disabled.map((prop) => prop.getText()),
      'cheat-sheet 入口不得带 disabled：按钮照旧渲染、handler 照旧在场且可达，但用户永远点不动，' +
        '正是这个 affordance 存在的理由被抹掉（该变异在旧守卫下 10 条全绿）'
    ).toEqual([])
  })
})

describe('cheat-sheet visible affordance — the click actually opens it', () => {
  // MUTATION 2b target: delete the `dispatchEvent` line from `openShortcutHelp` — the lib stops emitting
  // while every caller still calls it. Measured: `Tests 3 failed | 7 passed (10)`, and the three reds are
  // exactly this describe's three cases.
  //
  // The assertion records what the call DID — how many times it touched the outside world — with the
  // counter zeroed before the call. A fixture that only recorded "openShortcutHelp was called" would
  // survive an emptied body; counting dispatches does not.
  //
  // What this family does NOT see, measured, so nobody reads more into it than it buys: emptying the
  // COMPONENT's `onClick` body (mutation 2, in TopRowChrome) leaves this family fully green — `pressHelp`
  // calls `openShortcutHelp` directly and never goes through the button. That mutation is caught by
  // exactly one assertion in this file, the reachability guard at the bottom (measured: 1 failed | 9
  // passed). Two mutations, two disjoint killers; neither layer is redundant and neither covers the other.
  it('openShortcutHelp dispatches exactly one keydown at the target', () => {
    const events = pressHelp(true)
    expect(events.length, 'handler touched the outside world ≠ once').toBe(1)
    expect(events[0]!.type).toBe('keydown')
  })

  // The dispatched event must actually FIRE the help binding — not just be "a keydown". This is the seam
  // between the button and App's real window listener: App routes window keydowns through `matchShortcut`
  // against the registry, so if the event the button emits matches `help.shortcuts` there, pressing the
  // button is indistinguishable from the user pressing the chord. Assert on both platforms because the
  // chord's shape differs (see the drift test below); mutation 2b (lib stops dispatching) reds here too,
  // since there is no event to match. An emptied component handler does NOT red here — see above.
  for (const isMac of [true, false] as const) {
    it(`the dispatched event fires help.shortcuts in window scope (isMac=${isMac})`, () => {
      const event = pressHelp(isMac)[0]
      expect(event, 'no event was dispatched — the handler body is empty').toBeDefined()
      // The event, run through the registry's own window-scope matcher, resolves to the help binding.
      // `editableTarget: false` — help is un-gated, so it fires even mid-typing (the design intent).
      expect(
        matchShortcut(event!, isMac, { scope: 'window', editableTarget: false }),
        'the button-pressed chord does not resolve to help.shortcuts in the registry'
      ).toBe(SHORTCUT_HELP_BINDING_ID)
    })
  }
})

describe('cheat-sheet chord is derived from the registry, never hand-typed', () => {
  // MUTATION 3 target (the #367 drift shape): replace the derived chord with a hand-typed literal of the
  // currently-correct chord.
  //
  // Today `help.shortcuts` is Cmd+/ on mac, Ctrl+Shift+/ elsewhere — BUT off mac the keyboard delivers
  // `?`, not `/` (Shift+/ is `?`), which is exactly why the binding is a `symbol` chord naming both
  // characters. So the currently-correct hand-typed literal a drifting author would most naturally write
  // is `key: '/'` on both platforms. This asserts the dispatched key EQUALS the registry chord's key on
  // each platform: hand-typing `'/'` reds the non-mac case (registry says `?`), which is the whole point.
  //
  // `chordMatches` is the registry's own matcher — the same predicate App's listener trusts — so this
  // proves the emitted event is byte-for-byte what the registry declares, not a look-alike.
  const binding = bindingById(SHORTCUT_HELP_BINDING_ID)

  it('help.shortcuts is still in the registry (anchor for the derivation)', () => {
    expect(binding, 'help.shortcuts vanished from the registry').not.toBeNull()
  })

  for (const isMac of [true, false] as const) {
    it(`the emitted event equals the registry chord, not a copy (isMac=${isMac})`, () => {
      const chord = chordForPlatform(binding!, isMac)
      const init = shortcutHelpKeydownInit(isMac)
      // Key must be the registry's platform key verbatim: `/` on mac, `?` off mac. A hand-typed `'/'`
      // both-platforms literal reds the off-mac case here.
      expect(init.key, `emitted key ≠ registry key for isMac=${isMac}`).toBe(chord.key)
      // And the whole chord must match under the registry's matcher — modifiers included.
      const event: ShortcutEvent = {
        key: init.key ?? '',
        metaKey: Boolean(init.metaKey),
        ctrlKey: Boolean(init.ctrlKey),
        shiftKey: Boolean(init.shiftKey),
        altKey: Boolean(init.altKey)
      }
      expect(
        chordMatches(chord, event, isMac),
        `emitted chord does not match the registry chord for isMac=${isMac}`
      ).toBe(true)
    })
  }

  // Symmetry check that pins the #367 shape directly: the two platforms must NOT emit the same key. If a
  // drifting author collapses both to one hand-typed literal, this reds even if some future rebind made
  // the mac key coincidentally right.
  it('mac and non-mac emit different keys (the symbol split the registry declares)', () => {
    expect(shortcutHelpKeydownInit(true).key).not.toBe(shortcutHelpKeydownInit(false).key)
  })

  // G3: the asserts above are all VALUE comparisons, and a hand-copy that is correct today agrees with
  // every one of them. The measured survivor is `key: isMac ? '/' : '?'` — it copies BOTH platform keys,
  // so it equals `chordForPlatform`'s key on each platform, matches under `chordMatches`, and the two
  // platforms still differ. Measured on the shipping guard: SURVIVED at `Tests 10 passed (10)`.
  //
  // The shipping commit's message claimed the #367 drift class "cannot exist here by construction". That
  // was too strong, and this is the assertion that makes the weaker, true claim enforceable: the emitted
  // `key` must be an expression that READS the resolved chord — not a literal, and not a conditional over
  // literals that happens to agree with it. A rebind in the registry then follows automatically, which is
  // the actual property "derived, not hand-typed" means.
  //
  // The criterion is deliberately narrow — "the initializer's subtree contains a read of the local the
  // chord was resolved into" — because that is what "derives from" means here and it needs no list of
  // forbidden spellings. What it does NOT see: laundering the chord through an identity function, or a
  // read of some OTHER property of the chord (`chord.primary` in the `key` slot would pass this and fail
  // the value asserts above — which is the intended division of labour, not a hole).
  it('the emitted key is derived from the resolved chord, not a literal that matches it', () => {
    const { sourceFile } = readAndParse(AFFORDANCE_LIB)
    let checked = false
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'shortcutHelpKeydownInit' && node.body) {
        // The local the platform chord is resolved into — found by its initializer being the
        // `chordForPlatform(...)` call, so renaming the variable cannot break this.
        const chordLocals: string[] = []
        const scan = (inner: ts.Node): void => {
          if (
            ts.isVariableDeclaration(inner) &&
            ts.isIdentifier(inner.name) &&
            inner.initializer &&
            inner.initializer.getText().includes('chordForPlatform')
          ) {
            chordLocals.push(inner.name.text)
          }
          ts.forEachChild(inner, scan)
        }
        scan(node.body)
        expect(
          chordLocals,
          'shortcutHelpKeydownInit 里应恰有一个由 chordForPlatform(...) 解析出来的局部（本判据的前提，' +
            '缺席说明它不再从注册表取平台和弦，而这条断言会随之变空转）'
        ).toHaveLength(1)

        const returned = node.body.statements.find(ts.isReturnStatement)?.expression
        expect(returned && ts.isObjectLiteralExpression(returned), '返回的应是对象字面量').toBe(true)
        const keyProp = (returned as ts.ObjectLiteralExpression).properties.find(
          (prop) => ts.isPropertyAssignment(prop) && prop.name.getText() === 'key'
        )
        expect(keyProp, '返回的 KeyboardEventInit 里应有 key 属性').toBeDefined()

        // Does the `key` initializer READ that local anywhere in its subtree?
        const local = chordLocals[0]!
        let readsChord = false
        const walk = (inner: ts.Node): void => {
          if (ts.isIdentifier(inner) && inner.text === local) readsChord = true
          ts.forEachChild(inner, walk)
        }
        walk((keyProp as ts.PropertyAssignment).initializer)
        expect(
          readsChord,
          `key 的取值必须读到 ${local}（那个从注册表解析出来的和弦），而不是与它今天恰好相等的字面量。` +
            `实测 \`key: isMac ? '/' : '?'\`（两个平台各抄一份）能通过全部取值断言：它在每个平台都等于` +
            `chordForPlatform 的 key、过 chordMatches、且两平台仍不相等——于是改键之后按钮静默显示/派发旧键，` +
            `正是 #367 那一族。实测该变异在旧守卫下 10 条全绿。`
        ).toBe(true)
        checked = true
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    // Presence self-check: if the function were renamed or moved, every assertion above would be skipped
    // and this `it` would pass having asserted nothing.
    expect(checked, 'shortcutHelpKeydownInit 没找到——本条判据整段没被执行（改名/搬家都会这样）').toBe(true)
  })
})

describe('the button reuses the existing route — no duplicated open-state', () => {
  // MUTATION 2 target (the component half): empty the click handler's body while leaving the button wired.
  // Measured: `Tests 1 failed | 9 passed (10)` — and the single red is THIS assertion. That is the whole
  // reason this layer exists: the behaviour family above calls `openShortcutHelp` directly, so an emptied
  // handler is invisible to it. The handler's body must actually call openShortcutHelp, and that call must
  // be reachable (no early return in front of it turning the handler into a no-op — this repo's "a
  // source-text toContain is worthless; a return makes the handler a no-op while the text still matches"
  // trap). `assertSingleCallReachable` fails on 0 calls (deleted), >1 calls, and any return/throw before
  // the call.
  it('TopRowChrome click handler calls openShortcutHelp, reachably and exactly once', () => {
    assertSingleCallReachable({
      sourcePath: TOP_ROW_CHROME,
      calleeName: 'openShortcutHelp',
      label: 'TopRowChrome ShortcutHelpButton onClick'
    })
  })

  // G2: `assertSingleCallReachable` declares its own blind spot — it only sees `return`/`throw` BEFORE the
  // call, so it cannot see a call that is present, un-preceded by any exit, and still never runs.
  // Measured survivor: `onClick={() => false && openShortcutHelp(isMacPlatform())}` → SURVIVED at
  // `Tests 10 passed (10)`, `tsc --noEmit` exit 0. That matters more than a declared blind spot usually
  // does, because the assertion above is the SOLE killer of the emptied-handler mutation: with the blind
  // spot open, the component wiring had no effective guard at all.
  //
  // The criterion inverts rather than enumerating forbidden operators (`&&`, `||`, `?:`, `void 0 &&`, …):
  // this repo's forbidden-list guards always leak. The handler body must BE that call — an expression-bodied
  // arrow whose expression is the call, or a block whose single statement is the call — so nothing can wrap
  // it. Anything else fails loudly and names the shape it saw, rather than being silently classified as OK.
  //
  // What it still does not see: it does not prove the handler is invoked (no DOM environment), and it does
  // not follow the call into `openShortcutHelp` — the behaviour family above owns that half.
  it('the click handler body IS that call — nothing wrapped around it', () => {
    const element = helpButtonElement()
    const onClick = element.attributes.properties.find(
      (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === 'onClick'
    )
    expect(onClick && ts.isJsxAttribute(onClick), '帮助按钮上应有 onClick').toBe(true)
    const initializer = (onClick as ts.JsxAttribute).initializer
    expect(
      initializer && ts.isJsxExpression(initializer) && initializer.expression,
      'onClick 的值应是一个表达式（花括号形式）'
    ).toBeTruthy()
    const handler = (initializer as ts.JsxExpression).expression!
    expect(
      ts.isArrowFunction(handler),
      `onClick 应是内联箭头函数，实测 ${ts.SyntaxKind[handler.kind]}`
    ).toBe(true)

    // Peel exactly one legal shape: `() => call(...)` or `() => { call(...) }`. No other wrapper allowed.
    const body = (handler as ts.ArrowFunction).body
    let expression: ts.Node
    if (ts.isBlock(body)) {
      expect(
        body.statements.length,
        'handler 体里应恰好只有那一句调用（多一句就有别的东西在替它做决定）'
      ).toBe(1)
      const only = body.statements[0]!
      expect(
        ts.isExpressionStatement(only),
        `handler 体里那一句应是表达式语句，实测 ${ts.SyntaxKind[only.kind]}`
      ).toBe(true)
      expression = (only as ts.ExpressionStatement).expression
    } else {
      expression = body
    }

    // The expression itself must be the call — not a `&&`/`||`/`?:` whose operand it is.
    expect(
      ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
        ? expression.expression.text
        : `NOT-A-BARE-CALL(${ts.SyntaxKind[expression.kind]}: ${expression.getText().replace(/\s+/g, ' ')})`,
      'handler 体必须**就是** openShortcutHelp(...) 这次调用本身。实测 `false && openShortcutHelp(...)` ' +
        '这种写法调用在场、之前无任何 return/throw，因此 assertSingleCallReachable 完全看不见它' +
        '（旧守卫下 10 条全绿、tsc 也沉默），而按钮变成一个彻底的死门。'
    ).toBe('openShortcutHelp')
  })

  // The affordance must not have grown its own open-state or its own routing: it presses the registry
  // chord and lets App's one listener decide. The behavioural tests above already prove the emitted event
  // resolves to help.shortcuts through the registry matcher — i.e. it IS the same route the user's chord
  // takes. This adds the one structural fact behaviour cannot see: the binding id the affordance targets
  // is the registry constant, not a second hand-written literal that could drift from it.
  it('the affordance targets the registry binding id, not a duplicated literal', () => {
    expect(SHORTCUT_HELP_BINDING_ID).toBe('help.shortcuts')
    expect(bindingById(SHORTCUT_HELP_BINDING_ID), 'the id the button presses is not a real registry binding').not.toBeNull()
  })
})
