/**
 * One declaration for the Browser chords that act on the page shown in a Browser surface. The same bare
 * Cmd (macOS) / Ctrl (elsewhere) chord as every browser: the Browser surface has no shell underneath.
 */
export const BROWSER_PAGE_SHORTCUTS = [
  { id: 'browser.focus-address', action: 'focus-address', label: 'Focus address', chord: { key: 'l', primary: true, shift: false, alt: false } },
  { id: 'browser.reload', action: 'reload', label: 'Reload page', chord: { key: 'r', primary: true, shift: false, alt: false } },
  { id: 'browser.find', action: 'find', label: 'Find in page', chord: { key: 'f', primary: true, shift: false, alt: false } }
] as const

export type BrowserPageShortcutAction = (typeof BROWSER_PAGE_SHORTCUTS)[number]['action']

/** One key press as Electron's native page input reports it. */
export type BrowserPageKeyInput = { key: string; meta: boolean; control: boolean; shift: boolean; alt: boolean }

/**
 * The page action this exact chord asks for. Every modifier matches exactly and the primary is Cmd on macOS,
 * Ctrl elsewhere. Main's native page entry and the Browser chrome both ask here, so a chord means the same
 * whether the page or its toolbar has focus.
 */
export function browserPageShortcut(input: BrowserPageKeyInput, isMac: boolean): BrowserPageShortcutAction | null {
  const primary = isMac ? input.meta && !input.control : input.control && !input.meta
  const bare = !input.meta && !input.control
  return BROWSER_PAGE_SHORTCUTS.find(({ chord }) => chord.key === input.key.toLowerCase() &&
    chord.shift === input.shift && chord.alt === input.alt && (chord.primary ? primary : bare))?.action ?? null
}
