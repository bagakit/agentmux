// The one place every keyboard binding lives — chord, stable id, scope, and the platform bottom line,
// each expressed exactly once. Before this, the same "which key is which action" decision was scattered
// across four libs (workbench / terminal / quick-switch / editor-save), each with its own platform split
// and none carrying a stable id. A cheat-sheet, user rebinding, and a command palette all need one
// enumerable table keyed by a durable id; this is that table.
//
// Why the decision layer stays pure (same reason the four originals were pure): this repo's component
// tests render with `renderToStaticMarkup`, which never runs effects and cannot dispatch DOM events, so
// a chord decision written inside an effect/callback has no assertion that can reach it. The load-bearing
// judgement — does this event match this binding, on this platform, in this scope — lives here, testable
// without a window. The shells (App's window listener, xterm's key handler, Monaco) only forward.

/** The subset of a KeyboardEvent a chord decision reads. Keeps the matcher window-free and testable. */
export type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

/**
 * Where a binding is evaluated, which also settles the non-intersection the four libs enforced by hand:
 * - `window`  — App's window-level capture listener (quick switcher, workbench actions).
 * - `terminal`— xterm's custom key handler; only live while a terminal owns focus, so these never collide
 *   with `window` bindings (a focused terminal claims the chord first; nothing else sees it).
 * - `editor`  — Monaco's own keybinding table while the editor owns focus.
 * A binding belongs to exactly one scope; that is the model, not one flat if over every key.
 */
export type ShortcutScope = 'window' | 'terminal' | 'editor'

/**
 * The key's readline classification — this is the *per-binding* form of the platform bottom line, not a
 * global switch. Off mac, bare Ctrl+letter is shell/readline territory (Ctrl+W delete-word, Ctrl+D EOF),
 * so a `letter` chord must add Shift there. But `digit` (Ctrl+1..9 is the tab-select convention, not a
 * readline key) and `arrow` (rides Ctrl+Alt, no conflict) ride bare Ctrl safely. These are TWO different
 * bottom lines living on the binding, not one rule to be flattened. `named` keys (Enter) carry no primary
 * chord and are exempt.
 *
 * `symbol` exists because adding Shift is only transparent for letters. `KeyboardEvent.key` reports the
 * *shifted character*, and `chordMatches` lowercases it: Ctrl+Shift+P arrives as `'P'`, which lowercases
 * back to the `'p'` the chord declares, so a letter chord can name one character for both platforms. A
 * symbol has no such round trip — Shift+`/` arrives as `'?'`, a different character entirely, and
 * lowercasing does nothing. `help.shortcuts` shipped as a `letter` chord naming `'/'` on both platforms,
 * so off mac it expected `'/'` while the keyboard delivered `'?'` and the app's only shortcut-discovery
 * gesture never fired. A `symbol` binding therefore names its shifted character explicitly.
 */
export type ShortcutKeyClass = 'letter' | 'digit' | 'arrow' | 'named' | 'symbol'

/** A fully-resolved chord for one platform: the key plus the exact modifier set required to match it. */
export interface Chord {
  /** `KeyboardEvent.key`, lowercased. */
  key: string
  /** Requires the primary chord — Cmd on mac, Ctrl elsewhere (and never the opposite one). */
  primary: boolean
  /** Shift must be present iff true. Exact — a binding for Cmd+F does not also fire on Cmd+Shift+F. */
  shift: boolean
  /** Alt must be present iff true. Exact. */
  alt: boolean
}

export interface ShortcutBinding {
  /** Durable id — the override-persistence key and the cheat-sheet anchor. Never renamed once shipped. */
  id: string
  scope: ShortcutScope
  keyClass: ShortcutKeyClass
  /** Human label for the cheat-sheet / command palette. */
  label: string
  /** The chord on macOS. */
  mac: Chord
  /** The chord on every other platform. */
  other: Chord
  /**
   * Window-scope only: suppress the chord while a non-terminal editable control has focus, so typing in
   * the composer or a rename box is never hijacked (Cmd+D must not split, Cmd+W must not close). A global
   * navigation gesture (the quick switcher) omits this and fires even mid-typing.
   */
  gate?: 'not-in-editable'
}

// --- Chord builders: the platform bottom line, applied in exactly one place per key class -------------

/** A letter chord: bare Cmd on mac; Ctrl+Shift elsewhere (bare Ctrl+letter belongs to readline). */
function letterChords(letter: string): Pick<ShortcutBinding, 'mac' | 'other'> {
  return {
    mac: { key: letter, primary: true, shift: false, alt: false },
    other: { key: letter, primary: true, shift: true, alt: false }
  }
}

/**
 * A symbol chord: bare Cmd on mac; Ctrl+Shift elsewhere — the same bottom line as a letter, but the
 * shifted character has to be named, because `KeyboardEvent.key` reports it and lowercasing cannot undo
 * it the way it undoes a letter's capitalization. Callers pass both characters so the mismatch that broke
 * `help.shortcuts` (declaring `'/'` where the keyboard delivers `'?'`) cannot be written by accident.
 */
function symbolChords(unshifted: string, shifted: string): Pick<ShortcutBinding, 'mac' | 'other'> {
  return {
    mac: { key: unshifted, primary: true, shift: false, alt: false },
    other: { key: shifted, primary: true, shift: true, alt: false }
  }
}

/** A digit chord: bare Cmd/Ctrl both platforms — Ctrl+digit is the tab-select convention, not readline. */
function digitChords(digit: string): Pick<ShortcutBinding, 'mac' | 'other'> {
  return {
    mac: { key: digit, primary: true, shift: false, alt: false },
    other: { key: digit, primary: true, shift: false, alt: false }
  }
}

/** An arrow chord: Cmd/Ctrl + Alt both platforms — no readline conflict on either. */
function arrowChords(arrow: string): Pick<ShortcutBinding, 'mac' | 'other'> {
  return {
    mac: { key: arrow, primary: true, shift: false, alt: true },
    other: { key: arrow, primary: true, shift: false, alt: true }
  }
}

const SELECT_TAB_BINDINGS: ShortcutBinding[] = Array.from({ length: 9 }, (_, index) => {
  const digit = String(index + 1)
  return {
    id: `workbench.select-tab.${digit}`,
    scope: 'window',
    keyClass: 'digit',
    label: digit === '9' ? 'Select last tab' : `Select tab ${digit}`,
    gate: 'not-in-editable',
    ...digitChords(digit)
  }
})

/**
 * The whole binding table. Order matters only for matching within a scope (first match wins); no two
 * bindings in one scope resolve to the same chord, so order is not load-bearing today — the uniqueness
 * guard keeps it that way.
 */
export const SHORTCUT_BINDINGS: readonly ShortcutBinding[] = [
  // --- window: global navigation (fires even while typing) ---
  {
    id: 'quick-switch.toggle',
    scope: 'window',
    keyClass: 'letter',
    label: 'Quick switch',
    ...letterChords('p')
  },
  {
    // The one discoverability gesture: summon the read-only cheat-sheet of every binding on this table.
    // A primary-modified chord (not bare `?`) so it never collides with typing a slash/question mark into
    // a terminal or composer. It rides the same bottom line as a letter — bare Ctrl+/ off mac is readline's
    // undo (Ctrl+_) — so: Cmd+/ on mac, Ctrl+Shift+/ elsewhere. But it is a `symbol`, not a `letter`: off
    // mac the keyboard delivers `?`, and only naming that character makes the chord matchable at all.
    // Un-gated like the quick switcher — help must be reachable mid-typing.
    id: 'help.shortcuts',
    scope: 'window',
    keyClass: 'symbol',
    label: 'Show keyboard shortcuts',
    ...symbolChords('/', '?')
  },
  // --- window: workbench actions (suppressed inside non-terminal editable inputs) ---
  ...SELECT_TAB_BINDINGS,
  {
    // 相对导航：绝对序号答不了「下一张」。九个数字键只在 Tab 少且位置记得住时够用；一旦十几张，
    // 用户要的动作是"往后翻一张"，而那在数字键上没有对应键。
    //
    // 为什么是 `[` / `]` 加 primary：这是浏览器与编辑器上「上一个/下一个」的通行和弦，且这一对
    // 在本表里没被占用（数字被 select-tab 占、四个方向键被 focus-region 占、字母 p/w/d 已用）。
    // 走 `symbolChords` 而不是自己写两行：off mac 的底线是 Ctrl+Shift（裸 Ctrl+letter 留给 readline），
    // 而带 Shift 时键盘送来的是 `{`/`}` 不是 `[`/`]`——那个不匹配正是 `help.shortcuts` 出过的错，
    // 这个 helper 存在就是为了让它写不出来。
    id: 'workbench.previous-tab',
    scope: 'window',
    keyClass: 'symbol',
    label: 'Previous tab',
    gate: 'not-in-editable',
    ...symbolChords('[', '{')
  },
  {
    id: 'workbench.next-tab',
    scope: 'window',
    keyClass: 'symbol',
    label: 'Next tab',
    gate: 'not-in-editable',
    ...symbolChords(']', '}')
  },
  {
    id: 'workbench.close-region',
    scope: 'window',
    keyClass: 'letter',
    label: 'Close region',
    gate: 'not-in-editable',
    ...letterChords('w')
  },
  {
    // Split direction: mac reuses one letter and picks direction with Shift (Cmd+D right, Cmd+Shift+D
    // down — the mac terminal convention). Off mac the base chord already carries Shift (bare Ctrl+letter
    // is reserved), so Shift can no longer distinguish direction; two different letters do instead
    // (Ctrl+Shift+E right, Ctrl+Shift+O down — the common Linux-terminal convention).
    id: 'workbench.split.right',
    scope: 'window',
    keyClass: 'letter',
    label: 'Split region right',
    gate: 'not-in-editable',
    mac: { key: 'd', primary: true, shift: false, alt: false },
    other: { key: 'e', primary: true, shift: true, alt: false }
  },
  {
    id: 'workbench.split.down',
    scope: 'window',
    keyClass: 'letter',
    label: 'Split region down',
    gate: 'not-in-editable',
    mac: { key: 'd', primary: true, shift: true, alt: false },
    other: { key: 'o', primary: true, shift: true, alt: false }
  },
  {
    id: 'workbench.focus-region.left',
    scope: 'window',
    keyClass: 'arrow',
    label: 'Focus region left',
    gate: 'not-in-editable',
    ...arrowChords('arrowleft')
  },
  {
    id: 'workbench.focus-region.right',
    scope: 'window',
    keyClass: 'arrow',
    label: 'Focus region right',
    gate: 'not-in-editable',
    ...arrowChords('arrowright')
  },
  {
    id: 'workbench.focus-region.up',
    scope: 'window',
    keyClass: 'arrow',
    label: 'Focus region up',
    gate: 'not-in-editable',
    ...arrowChords('arrowup')
  },
  {
    id: 'workbench.focus-region.down',
    scope: 'window',
    keyClass: 'arrow',
    label: 'Focus region down',
    gate: 'not-in-editable',
    ...arrowChords('arrowdown')
  },
  // --- terminal: only live while a terminal owns focus ---
  {
    id: 'terminal.search',
    scope: 'terminal',
    keyClass: 'letter',
    label: 'Search terminal',
    ...letterChords('f')
  },
  {
    id: 'terminal.copy',
    scope: 'terminal',
    keyClass: 'letter',
    label: 'Copy selection',
    ...letterChords('c')
  },
  {
    id: 'terminal.clear',
    scope: 'terminal',
    keyClass: 'letter',
    label: 'Clear terminal',
    ...letterChords('k')
  },
  {
    // Shift+Enter carries no primary chord: it is the bare Shift+Enter that must be sent as distinct
    // bytes so a downstream TUI can tell it from a plain Enter (see terminal-shortcuts.ts for the bytes).
    id: 'terminal.newline',
    scope: 'terminal',
    keyClass: 'named',
    label: 'Insert newline',
    mac: { key: 'enter', primary: false, shift: true, alt: false },
    other: { key: 'enter', primary: false, shift: true, alt: false }
  },
  // --- editor: matched by Monaco's own keybinding table while the editor owns focus ---
  {
    // Bare Cmd/Ctrl+S — no Shift off mac, unlike other letters. The readline bottom line does not apply
    // in editor scope: Monaco owns focus, there is no shell underneath, and Ctrl+S is the universal save.
    id: 'editor.save',
    scope: 'editor',
    keyClass: 'letter',
    label: 'Save file',
    mac: { key: 's', primary: true, shift: false, alt: false },
    other: { key: 's', primary: true, shift: false, alt: false }
  },
  {
    // Alt+Z — the near-universal editor chord for word wrap, same on both platforms (it carries no primary
    // modifier, so the readline bottom line does not apply). Lives here, not as a hardcoded Monaco bitmask,
    // so the cheat-sheet advertises the same key Monaco obeys — the drift `editor.save`'s comment warns of.
    id: 'editor.toggle-word-wrap',
    scope: 'editor',
    keyClass: 'letter',
    label: 'Toggle word wrap',
    mac: { key: 'z', primary: false, shift: false, alt: true },
    other: { key: 'z', primary: false, shift: false, alt: true }
  },
  {
    // The editor's discoverability door. Monaco ships find, replace, go-to-line, go-to-symbol and the
    // multi-cursor commands already keybound, and EditorPane disables none of them — so the gap was never
    // capability, only that nothing told the user they exist.
    //
    // Why one row here instead of a row per command: Monaco owns those chords, and its public API exposes
    // NO way to read them back (`IEditorAction` carries id, label and metadata — no keybinding). A
    // hand-written `Find ⌘F` row would therefore be a second, unverifiable declaration of a key Monaco
    // decides: change it here and Monaco keeps obeying its own, which is exactly the decorative-row drift
    // `editor.save`'s comment above warns about. So this binding opens Monaco's own command palette, which
    // lists every action WITH the key Monaco actually obeys. One key we own; the rest stay Monaco's to state.
    //
    // F1 — and specifically NOT a letter chord. Three facts force it, each verified against the
    // installed Monaco rather than assumed:
    //
    // 1. F1 is already Monaco's own key for this exact action (`editor.action.quickCommand`, bound
    //    `primary: KeyCode.F1` under `EditorContextKeys.focus`). Declaring the key Monaco already obeys
    //    means the registry states a fact instead of overriding one — and the cheat-sheet row is then
    //    true even for a user who never goes through our registration at all.
    // 2. A `letter` chord could not be stated honestly here. `letterChords` deliberately diverges by
    //    platform (bare Cmd on mac, Ctrl+Shift elsewhere) because bare Ctrl+letter is readline's, but
    //    Monaco's `CtrlCmd` remaps to Ctrl off mac and its Shift bit does NOT — so an editor-scope
    //    letter binding cannot mean the same chord on both platforms. `monacoKeybindingFor` now
    //    rejects any divergent binding rather than silently shipping the mac half.
    // 3. Every plausible letter was already taken. `addDynamicKeybinding` registers at `weight1: 1000`
    //    against Monaco's `EditorContrib: 100`, so OUR key silently WINS and the built-in it collides
    //    with just stops working. Cmd+E — what this binding shipped with — is Monaco's
    //    Find-with-Selection (`StartFindWithSelection`, `mac: CtrlCmd|KeyE`); taking it removed a
    //    working editor feature to advertise the others. Monaco holds bare CtrlCmd on A-M plus U/V/X/Y/Z
    //    and CtrlCmd+Shift on A/C/G/I/K/L/M/O/R/Z, so there is no free letter to move to either.
    //
    // Why one row here instead of a row per command: see above — Monaco's API cannot be asked what key
    // it obeys, so this door is the one key we state and its palette declares all the rest.
    id: 'editor.show-commands',
    scope: 'editor',
    keyClass: 'named',
    label: 'Show editor commands',
    mac: { key: 'f1', primary: false, shift: false, alt: false },
    other: { key: 'f1', primary: false, shift: false, alt: false }
  }
]

/** The chord this binding requires on the running platform. */
export function chordForPlatform(binding: ShortcutBinding, isMac: boolean): Chord {
  return isMac ? binding.mac : binding.other
}

/** The slice of Monaco's API a keybinding needs — just the two constant bags, so this stays window-free. */
export interface MonacoKeybindingApi {
  KeyMod: { readonly CtrlCmd: number; readonly Shift: number; readonly Alt: number }
  KeyCode: Readonly<Record<string, number>>
}

/**
 * Translate a registry binding into the bitmask Monaco's own keybinding table wants.
 *
 * Editor-scope bindings are matched by Monaco, not by `matchShortcut`, so the registry cannot be their
 * SSOT just by declaring them — something has to carry the declaration across into Monaco's vocabulary.
 * Without this, the two sides each name the key independently: the registry said `'s'` while `EditorPane`
 * hardcoded `KeyMod.CtrlCmd | KeyCode.KeyS`, and nothing compared them. Rebinding save in the registry
 * changed the cheat-sheet and nothing else — the row displayed one key while the editor obeyed another,
 * which is worse than having no registry entry at all.
 *
 * `KeyCode` is indexed by Monaco's own name for the key rather than a table of our own: a letter is
 * `Key<X>`, and a key Monaco spells differently (`F1`) is named as itself. An unknown spelling throws
 * rather than silently resolving to `undefined`, which `|` would turn into `NaN` and Monaco would accept
 * as a keybinding that can never fire — exactly the silent failure this function exists to remove.
 *
 * Which platform's chord is handed over: Monaco has no platform split we can address. Its `CtrlCmd` *is*
 * Cmd on mac and Ctrl elsewhere — but that remap covers the primary modifier ONLY; Shift and Alt are
 * passed through verbatim. So a binding whose two platform chords differ cannot be expressed to Monaco at
 * all, and picking either one would ship a key the other platform's cheat-sheet row contradicts. That is
 * not hypothetical: `editor.show-commands` shipped as a `letterChords` binding, whose whole purpose is to
 * diverge (bare Cmd on mac, Ctrl+Shift elsewhere, because bare Ctrl+letter is readline's). This function
 * read `.mac` unconditionally, so off mac Monaco was handed Ctrl+E while the cheat-sheet advertised
 * Ctrl+Shift+E — the advertised key did nothing at all. Rejecting divergence is what makes the single
 * `.mac` read below sound: past this guard the two chords are identical, so there is no choice to get
 * wrong. An editor binding must therefore name a chord that means the same thing on every platform.
 */
export function monacoKeybindingFor(binding: ShortcutBinding, monaco: MonacoKeybindingApi): number {
  const { mac, other } = binding
  if (mac.key !== other.key || mac.primary !== other.primary || mac.shift !== other.shift || mac.alt !== other.alt) {
    throw new Error(
      `${binding.id}: editor-scope chords must be identical on every platform, but mac and other differ; Monaco remaps only the primary modifier, so a divergent binding would obey one platform's chord while the cheat-sheet advertises the other's.`
    )
  }
  const chord = mac
  const codeName = chord.key.length === 1 ? `Key${chord.key.toUpperCase()}` : chord.key.toUpperCase()
  const keyCode = monaco.KeyCode[codeName]
  if (typeof keyCode !== 'number') {
    throw new Error(
      `${binding.id}: no Monaco KeyCode for key ${JSON.stringify(chord.key)}; add the mapping instead of shipping a keybinding that cannot fire.`
    )
  }
  let keybinding = keyCode
  if (chord.primary) keybinding |= monaco.KeyMod.CtrlCmd
  if (chord.shift) keybinding |= monaco.KeyMod.Shift
  if (chord.alt) keybinding |= monaco.KeyMod.Alt
  return keybinding
}

/** The binding with this id, or null. Editor-scope shells look theirs up rather than re-declaring a chord. */
export function bindingById(id: string): ShortcutBinding | null {
  return SHORTCUT_BINDINGS.find((binding) => binding.id === id) ?? null
}

/**
 * Does this event satisfy the chord? Every modifier is matched exactly — Shift and Alt against the
 * chord's own flags, the primary against the platform. Exactness is what keeps Cmd+Shift+F a distinct
 * chord from Cmd+F, so a future binding can claim it.
 */
export function chordMatches(chord: Chord, event: ShortcutEvent, isMac: boolean): boolean {
  if (event.key.toLowerCase() !== chord.key) return false
  if (Boolean(event.altKey) !== chord.alt) return false
  if (Boolean(event.shiftKey) !== chord.shift) return false
  if (chord.primary) {
    return isMac
      ? Boolean(event.metaKey) && !event.ctrlKey
      : Boolean(event.ctrlKey) && !event.metaKey
  }
  // A non-primary chord (Shift+Enter) must carry neither primary modifier.
  return !event.metaKey && !event.ctrlKey
}

export interface ShortcutMatchContext {
  scope: ShortcutScope
  /** True when a non-terminal editable control has focus; suppresses `not-in-editable` bindings. */
  editableTarget?: boolean
}

/** The id of the binding this event fires in the given scope, or null when nothing matches. */
export function matchShortcut(
  event: ShortcutEvent,
  isMac: boolean,
  context: ShortcutMatchContext
): string | null {
  for (const binding of SHORTCUT_BINDINGS) {
    if (binding.scope !== context.scope) continue
    if (binding.gate === 'not-in-editable' && context.editableTarget) continue
    if (chordMatches(chordForPlatform(binding, isMac), event, isMac)) return binding.id
  }
  return null
}

/**
 * Route one window-scope keydown: match it, then run the handler registered for that id. Pure — the
 * shell passes the DOM-derived `editableTarget` fact and a handler map, and this decides everything else,
 * so the whole route (match + gate + dispatch) is assertable without a window. A handler returns whether
 * it actually consumed the key (a workbench action may decline — ordinal out of range, no adjacent
 * region); the caller preventDefaults only when it did.
 */
export function routeWindowShortcut(
  event: ShortcutEvent,
  isMac: boolean,
  editableTarget: boolean,
  handlers: Record<string, () => boolean>
): boolean {
  const id = matchShortcut(event, isMac, { scope: 'window', editableTarget })
  if (!id) return false
  const handler = handlers[id]
  if (!handler) return false
  return handler()
}
