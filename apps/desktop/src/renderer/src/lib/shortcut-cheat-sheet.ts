// The cheat-sheet's data layer — pure, window-free, and derived entirely from the registry. It declares
// NO binding of its own: every row is projected from SHORTCUT_BINDINGS, so a binding added to the registry
// shows up here for free and one deleted disappears. That is the whole point — a second hand-kept list
// would drift from the registry (this repo's "声明了却从不注册的事件" lesson), so there is exactly one
// list and this reads it.
//
// Grouping reuses the registry's OWN fields — scope and gate — instead of inventing a parallel taxonomy:
//   - terminal scope            → Terminal   (live only while a terminal owns focus)
//   - editor scope              → Editor     (Monaco's table)
//   - window scope, un-gated    → Global     (quick switch / help — fire even mid-typing)
//   - window scope, gated       → Workbench  (suppressed inside editable inputs)
// The (scope, gate) pair is total over the registry, so every binding lands in exactly one group.
//
// Why this is pure and the component is a thin shell: the repo's component tests render with
// renderToStaticMarkup (no effects, no DOM events), and Radix's Portal renders NOTHING there. So the
// load-bearing "which rows, which platform shape" decision lives here where a test can reach it, and the
// panel is a plain conditional overlay that maps this model to markup.

import { SHORTCUT_BINDINGS, chordForPlatform, type Chord, type ShortcutBinding } from './shortcut-registry'

/** A cheat-sheet group id, derived from (scope, gate). Not a new taxonomy — a projection of existing fields. */
export type CheatSheetGroupId = 'global' | 'workbench' | 'terminal' | 'editor'

export interface CheatSheetRow {
  /** The registry binding id — the anchor that ties a rendered row back to its SSOT entry. */
  id: string
  label: string
  /** The chord tokens for the running platform, in display order (modifiers then key). */
  keys: string[]
}

export interface CheatSheetGroup {
  id: CheatSheetGroupId
  title: string
  rows: CheatSheetRow[]
}

/** Which group a binding belongs to, read off the registry's own scope + gate. Total over the registry. */
export function groupIdForBinding(binding: ShortcutBinding): CheatSheetGroupId {
  if (binding.scope === 'terminal') return 'terminal'
  if (binding.scope === 'editor') return 'editor'
  // window scope splits on the gate: the two un-gated gestures are global (reach the user mid-typing);
  // everything else is a workbench action suppressed inside editable inputs.
  return binding.gate === 'not-in-editable' ? 'workbench' : 'global'
}

// Group display order + titles. Global leads (the always-available gestures), then the surface groups from
// outermost focus context inward. The order is the array order; titles are the only hand-written strings
// here and they name groups, never re-declare a binding.
const GROUP_ORDER: readonly { id: CheatSheetGroupId; title: string }[] = [
  { id: 'global', title: 'Global' },
  { id: 'workbench', title: 'Workbench' },
  { id: 'terminal', title: 'Terminal' },
  { id: 'editor', title: 'Editor' }
]

/** How a single key renders: arrows to glyphs, Enter and function keys spelled out, letters upper-cased, digits/symbols as-is. */
function keyToken(key: string): string {
  switch (key) {
    case 'arrowleft': return '←'
    case 'arrowright': return '→'
    case 'arrowup': return '↑'
    case 'arrowdown': return '↓'
    case 'enter': return 'Enter'
    // A function key's own name IS its label — upper-casing it is the whole rendering, and it needs no
    // modifier glyph in front (`f1` → `F1`, never `⌘F1`), which the chord's all-false modifiers already say.
    case 'f1': return 'F1'
    default: return key.length === 1 ? key.toUpperCase() : key
  }
}

/**
 * A chord as display tokens for one platform. Modifiers first in a stable order (primary, alt, shift), then
 * the key. The platform split is the registry's — mac shows the symbol glyphs (⌘ ⌥ ⇧), every other platform
 * spells the words (Ctrl / Alt / Shift) — so the same Chord renders differently per platform and a test can
 * pin that a mac shape never leaks into the non-mac render.
 */
export function formatChord(chord: Chord, isMac: boolean): string[] {
  const tokens: string[] = []
  if (chord.primary) tokens.push(isMac ? '⌘' : 'Ctrl')
  if (chord.alt) tokens.push(isMac ? '⌥' : 'Alt')
  if (chord.shift) tokens.push(isMac ? '⇧' : 'Shift')
  tokens.push(keyToken(chord.key))
  return tokens
}

/**
 * The whole cheat-sheet for the running platform: every registry binding, grouped, each row carrying its
 * platform chord tokens. Groups with no bindings are dropped. The row set across all groups is exactly the
 * registry's id set — nothing added, nothing filtered out — because this iterates SHORTCUT_BINDINGS directly.
 */
export function buildCheatSheet(isMac: boolean): CheatSheetGroup[] {
  return GROUP_ORDER.map(({ id, title }) => ({
    id,
    title,
    rows: SHORTCUT_BINDINGS
      .filter((binding) => groupIdForBinding(binding) === id)
      .map((binding) => ({
        id: binding.id,
        label: binding.label,
        keys: formatChord(chordForPlatform(binding, isMac), isMac)
      }))
  })).filter((group) => group.rows.length > 0)
}
