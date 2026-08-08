// The visible door to the keyboard cheat-sheet — the pure half.
//
// The bug this closes: the cheat-sheet (ShortcutsCheatSheet) is the app's ONLY surface for learning
// shortcuts, and until now the only way to open it was the `help.shortcuts` chord — which is itself
// on the sheet. A user had to already know the one chord to discover all the others. A bootstrap
// deadlock. The fix is a visible affordance (an icon-button in the persistent chrome) that opens the
// same panel.
//
// Why this replays the registry chord instead of calling a setter directly: the panel's open state
// (`shortcutsHelpOpen`) lives in App's local `useState`, and the one route that opens it from anywhere
// is App's single window-level capture keydown listener, which matches the event against the registry
// and dispatches to `help.shortcuts`'s handler. The chrome button cannot reach that App state (it is a
// store-only leaf, and threading a prop through its peer-held parents is not an option), so it does what
// the region context-menu keyboard path (WorkspaceWorkbench.openRegionMenuFromKeyboard) and the file
// tree (FileExplorer) already do: it synthesises the DOM event that the existing, already-tested handler
// consumes. No second copy of the routing, no new open-state, no new binding — the button presses the
// same key the user would, and App's listener does the rest.
//
// The chord is read from the registry SSOT (`help.shortcuts`) via `chordForPlatform`, never hand-typed:
// this repo has been burned by hand-copied chord strings drifting from the registry (tracker #367 — the
// terminal context menu hand-copied chords and silently showed stale keys after a rebind). Build the
// KeyboardEvent's fields from the binding and the same drift class cannot exist here: rebind help in the
// registry and this button follows, because it names no key of its own.
//
// This lives in a lib, not inside the component, for the reason the whole shortcut layer is pure: the
// desktop package has no DOM test environment (renderToStaticMarkup runs no effects, dispatches no
// events), so a decision written inside a click handler has no assertion that can reach it. The event
// this builds is a plain data value a test can inspect, and `chordMatches` (the registry's own matcher)
// can be run against it to prove it actually fires the intended binding on both platforms.

import { bindingById, chordForPlatform, type Chord } from './shortcut-registry'

/** The binding id of the cheat-sheet gesture. The one string this module names — and it is a registry id, not a chord. */
export const SHORTCUT_HELP_BINDING_ID = 'help.shortcuts'

/**
 * The KeyboardEvent init that replays the running platform's `help.shortcuts` chord. Every field is
 * derived from the registry binding — `key` is the platform chord's key (`/` on mac, `?` elsewhere),
 * and the modifier booleans map the chord's `primary` onto the platform's real modifier (Cmd on mac,
 * Ctrl elsewhere), exactly as `chordMatches` reads them back. `bubbles`/`cancelable` mirror a real
 * keydown so App's capture listener (which calls `preventDefault`) sees the same shape it always does.
 *
 * Throws if the binding is missing rather than returning a dead event: a synthetic keydown that matches
 * nothing would make the button silently do nothing — the exact failure mode (a trigger surface that is
 * quietly dead) this affordance exists to remove.
 */
export function shortcutHelpKeydownInit(isMac: boolean): KeyboardEventInit {
  const binding = bindingById(SHORTCUT_HELP_BINDING_ID)
  if (!binding) {
    throw new Error(
      `${SHORTCUT_HELP_BINDING_ID} is not in the shortcut registry; the cheat-sheet button cannot replay a chord that does not exist.`
    )
  }
  const chord: Chord = chordForPlatform(binding, isMac)
  return {
    key: chord.key,
    // The primary modifier IS Cmd on mac and Ctrl elsewhere — the same split chordMatches applies. A
    // non-primary chord (help is not one, but keep the mapping honest) carries neither.
    metaKey: chord.primary && isMac,
    ctrlKey: chord.primary && !isMac,
    shiftKey: chord.shift,
    altKey: chord.alt,
    bubbles: true,
    cancelable: true
  }
}

/**
 * Open the cheat-sheet by pressing its registry chord: build the platform keydown and dispatch it at the
 * window, where App's capture listener matches `help.shortcuts` and toggles the panel.
 *
 * Both seams are injectable so the behaviour is testable without a DOM. `target` is the dispatch surface
 * (defaulting to the real `window`); `createEvent` builds the event from the init (defaulting to the real
 * `KeyboardEvent` constructor). The desktop package's tests run in node, which has no `KeyboardEvent`
 * global and no window, so a test passes a plain factory + a capture target and inspects the init it
 * emitted — proving the handler actually dispatches the registry chord rather than merely being called.
 */
export function openShortcutHelp(
  isMac: boolean,
  options: {
    target?: Pick<EventTarget, 'dispatchEvent'>
    createEvent?: (type: string, init: KeyboardEventInit) => Event
  } = {}
): void {
  const target = options.target ?? (typeof window === 'undefined' ? undefined : window)
  if (!target) return
  const createEvent =
    options.createEvent ?? ((type, init) => new KeyboardEvent(type, init))
  target.dispatchEvent(createEvent('keydown', shortcutHelpKeydownInit(isMac)))
}
