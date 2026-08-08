import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

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
import { assertSingleCallReachable } from './helpers/effect-reachability.js'

// The visible cheat-sheet door — the fix for the bootstrap deadlock where the app's ONLY shortcut-
// discovery surface (ShortcutsCheatSheet) could be opened only by a shortcut that is itself on the sheet.
//
// What this guards, and why each piece is separate (this repo's bar is mutation-based, and the traps are
// specific): the button (1) renders, (2) its click actually DOES the thing — not merely "is wired" — and
// (3) the chord it presses is derived from the registry, not hand-typed. Those are three orthogonal
// properties, so they live in three families of `it()`; two assertions in one `it()` mask each other
// (whichever throws first makes the rest dead code — this repo's two-throws-in-one-it lesson).
//
// The desktop package has NO DOM test environment: renderToStaticMarkup runs no effects and dispatches
// no events, and there is no window. So the behavioural half cannot click a rendered button — it drives
// the pure `openShortcutHelp` against a stub EventTarget and inspects the event it dispatches. The
// render half proves the button is on screen and calls that function; the reachability half proves the
// handler body is not empty. Together they close the gap either half leaves open.

const TOP_ROW_CHROME = fileURLToPath(
  new URL('../src/renderer/src/components/TopRowChrome.tsx', import.meta.url)
)

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
