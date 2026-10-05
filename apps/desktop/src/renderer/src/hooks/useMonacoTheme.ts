import { MONACO_THEME_ID } from '../lib/monaco-theme'

/** The module's single native adapter observes Root; components only select its stable ID. */
export function useMonacoTheme() {
  return MONACO_THEME_ID
}
