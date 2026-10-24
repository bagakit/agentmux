/**
 * Every `TerminalThemeId`, once, and the single source of truth for it. Iterate this (never a
 * hand-written list) when a consumer or a validator needs to walk every theme.
 *
 * Before this tuple existed, the type was a bare `'graphite' | 'catppuccin-mocha'` union, and the
 * persistence-layer validator (`appearanceSchema` in `main/config-store.ts`) re-spelled the members as
 * an independent `z.enum(['graphite', 'catppuccin-mocha'])` with no compiler link back to the union.
 * Adding a member to the union therefore compiled clean while config load fail-closed rejected any
 * config carrying the new theme (`.strict()` + enum) — a valid user preference silently dropped, with
 * tsc silent throughout, and "add a member" is the common direction. Deriving both the union and the
 * schema from this one tuple removes the second declaration point. The sibling `notifications` field in
 * the same schema was already derived from `NOTIFICATION_TIERS` this way; `terminalTheme` was the copy.
 */
export const TERMINAL_THEME_IDS = ['graphite', 'catppuccin-mocha', 'workspace', 'dracula', 'nord', 'gruvbox-dark', 'solarized-dark', 'solarized-light'] as const

/**
 * The terminal appearance theme id. DERIVED from `TERMINAL_THEME_IDS` so the direction is forced: a
 * member added to the tuple widens this type, and `z.enum(TERMINAL_THEME_IDS)` in `config-store.ts`
 * widens with it (the schema reads the tuple), so the validator can never fall behind the union.
 */
export type TerminalThemeId = (typeof TERMINAL_THEME_IDS)[number]

/**
 * Two-way exactness between `TERMINAL_THEME_IDS` and `TerminalThemeId`, identical in intent to the
 * `_workspaceKindsAreExactlyTheUnion` proof above. `satisfies readonly TerminalThemeId[]` alone would
 * prove only ⊆; this proves ⊇ as well (every theme is in the tuple), the direction a member addition
 * would break. `void` keeps the proof from reading as dead code.
 */
const _terminalThemeIdsAreExactlyTheUnion: [
  (typeof TERMINAL_THEME_IDS)[number] extends TerminalThemeId ? true : never,
  TerminalThemeId extends (typeof TERMINAL_THEME_IDS)[number] ? true : never
] = [true, true]
void _terminalThemeIdsAreExactlyTheUnion

import { TERMINAL_EXTENDED_ANSI, type TerminalPalette } from './terminal-palette.js'
export type { TerminalPalette } from './terminal-palette.js'

const EXTENDED_ANSI = TERMINAL_EXTENDED_ANSI

// Keep a proven ANSI role palette, but use a true-black terminal work area
// so Codex's own gray composer and message surfaces remain visibly distinct.
// The main process also uses these foreground/background values to answer a
// Run's OSC 10/11 color queries while no Renderer is attached.
const TERMINAL_PALETTES: Readonly<Record<Exclude<TerminalThemeId, 'workspace'>, TerminalPalette>> = Object.freeze({
  graphite: Object.freeze({
    background: '#000000',
    foreground: '#ffffff',
    cursor: '#ffffff',
    cursorAccent: '#000000',
    selectionBackground: '#5a7898',
    selectionForeground: '#ffffff',
    black: '#1d1f21',
    red: '#cc6666',
    green: '#b5bd68',
    yellow: '#f0c674',
    blue: '#81a2be',
    magenta: '#b294bb',
    cyan: '#8abeb7',
    white: '#c5c8c6',
    brightBlack: '#666666',
    brightRed: '#d54e53',
    brightGreen: '#b9ca4a',
    brightYellow: '#e7c547',
    brightBlue: '#7aa6da',
    brightMagenta: '#c397d8',
    brightCyan: '#70c0b1',
    brightWhite: '#eaeaea',
    extendedAnsi: EXTENDED_ANSI
  }),
  'catppuccin-mocha': Object.freeze({
    background: '#1e1e2e',
    foreground: '#cdd6f4',
    cursor: '#f5e0dc',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#585b70',
    selectionForeground: '#cdd6f4',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#f5c2e7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8',
    extendedAnsi: EXTENDED_ANSI
  }),
  // Canonical primary/ANSI: https://draculatheme.com/spec
  // Selection uses the family surface with its original foreground; cursorAccent uses background.
  'dracula': Object.freeze({
    background: '#282a36',
    foreground: '#f8f8f2',
    cursor: '#f8f8f2',
    cursorAccent: '#282a36',
    selectionBackground: '#44475a',
    selectionForeground: '#f8f8f2',
    black: '#21222c',
    red: '#ff5555',
    green: '#50fa7b',
    yellow: '#f1fa8c',
    blue: '#bd93f9',
    magenta: '#ff79c6',
    cyan: '#8be9fd',
    white: '#f8f8f2',
    brightBlack: '#6272a4',
    brightRed: '#ff6e6e',
    brightGreen: '#69ff94',
    brightYellow: '#ffffa5',
    brightBlue: '#d6acff',
    brightMagenta: '#ff92df',
    brightCyan: '#a4ffff',
    brightWhite: '#ffffff',
    extendedAnsi: EXTENDED_ANSI
  }),
  // Canonical primary/ANSI: https://github.com/nordtheme/alacritty/blob/main/src/nord.yaml
  // Selection uses the family surface with its original foreground; cursorAccent uses background.
  'nord': Object.freeze({
    background: '#2e3440',
    foreground: '#d8dee9',
    cursor: '#d8dee9',
    cursorAccent: '#2e3440',
    selectionBackground: '#4c566a',
    selectionForeground: '#d8dee9',
    black: '#3b4252',
    red: '#bf616a',
    green: '#a3be8c',
    yellow: '#ebcb8b',
    blue: '#81a1c1',
    magenta: '#b48ead',
    cyan: '#88c0d0',
    white: '#e5e9f0',
    brightBlack: '#4c566a',
    brightRed: '#bf616a',
    brightGreen: '#a3be8c',
    brightYellow: '#ebcb8b',
    brightBlue: '#81a1c1',
    brightMagenta: '#b48ead',
    brightCyan: '#8fbcbb',
    brightWhite: '#eceff4',
    extendedAnsi: EXTENDED_ANSI
  }),
  // Canonical primary/ANSI: https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim
  // Selection uses the family surface with its original foreground; cursorAccent uses background.
  'gruvbox-dark': Object.freeze({
    background: '#282828',
    foreground: '#ebdbb2',
    cursor: '#ebdbb2',
    cursorAccent: '#282828',
    selectionBackground: '#504945',
    selectionForeground: '#ebdbb2',
    black: '#282828',
    red: '#cc241d',
    green: '#98971a',
    yellow: '#d79921',
    blue: '#458588',
    magenta: '#b16286',
    cyan: '#689d6a',
    white: '#a89984',
    brightBlack: '#928374',
    brightRed: '#fb4934',
    brightGreen: '#b8bb26',
    brightYellow: '#fabd2f',
    brightBlue: '#83a598',
    brightMagenta: '#d3869b',
    brightCyan: '#8ec07c',
    brightWhite: '#ebdbb2',
    extendedAnsi: EXTENDED_ANSI
  }),
  // Canonical primary/ANSI: https://github.com/altercation/solarized/blob/master/xresources/solarized
  // Selection uses the family surface with its original foreground; cursorAccent uses background.
  'solarized-dark': Object.freeze({
    background: '#002b36',
    foreground: '#839496',
    cursor: '#93a1a1',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    selectionForeground: '#839496',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#002b36',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
    extendedAnsi: EXTENDED_ANSI
  }),
  // Canonical primary/ANSI: https://github.com/altercation/solarized/blob/master/xresources/solarized
  // Selection uses the family surface with its original foreground; cursorAccent uses background.
  'solarized-light': Object.freeze({
    background: '#fdf6e3',
    foreground: '#657b83',
    cursor: '#586e75',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    selectionForeground: '#657b83',
    black: '#eee8d5',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#073642',
    brightBlack: '#fdf6e3',
    brightRed: '#cb4b16',
    brightGreen: '#93a1a1',
    brightYellow: '#839496',
    brightBlue: '#657b83',
    brightMagenta: '#6c71c4',
    brightCyan: '#586e75',
    brightWhite: '#002b36',
    extendedAnsi: EXTENDED_ANSI
  })
})

export function terminalPalette(themeId: Exclude<TerminalThemeId, 'workspace'>): TerminalPalette {
  const palette = TERMINAL_PALETTES[themeId]
  if (!palette) throw new Error(`Unknown terminal theme: ${String(themeId)}`)
  return palette
}
