/**
 * The renderer's semantic theme boundary. Values live in styles/tokens.css;
 * this module only gives consumers stable names and a typed var() helper.
 */
export const APP_APPEARANCE_DATASET_KEY = 'appearance' as const

export const THEME_TOKENS = {
  appBackground: '--bg',
  surface0: '--surface-0',
  surface1: '--surface-1',
  surface2: '--surface-2',
  surface3: '--surface-3',
  text: '--text',
  textMuted: '--text-2',
  textSubtle: '--text-3',
  line: '--line',
  lineSoft: '--line-soft',
  success: '--green',
  warning: '--amber',
  danger: '--red',
  focus: '--focus-line',
} as const

export type ThemeTokenName = keyof typeof THEME_TOKENS

export function themeVar(name: ThemeTokenName): `var(${(typeof THEME_TOKENS)[ThemeTokenName]})` {
  return `var(${THEME_TOKENS[name]})` as `var(${(typeof THEME_TOKENS)[ThemeTokenName]})`
}
